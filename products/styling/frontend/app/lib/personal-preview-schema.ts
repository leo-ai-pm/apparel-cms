import { PERSONAL_PREVIEW_CONTRACT, PersonalPreviewApiError, type PersonalPreviewSchema } from "./personal-preview-api";
import type { PersonalPreviewTarget } from "./personal-preview-model";

/** Locked publications 1.0.2/1.0.3, composed with strict transport checks.
 * Real source mapping: reports/full-chain-live-20261010/styling-backend/REAL_PROVIDER_CONTRACT.md.
 * Frozen version number is optional; no name/model path is derived from the current Look.
 * Provider input, signed URLs and body measurements never enter this public projection.
 */
const bad = () => new PersonalPreviewApiError(502, "PREVIEW_INVALID_RESPONSE", "本人效果响应无法验证，请查询原记录；不会按此判断生成或删除成功。");
function requireValue(value: unknown): asserts value { if (!value) throw bad(); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Record<string, unknown>;
  requireValue(required.every(key => Object.hasOwn(result, key)) && Object.keys(result).every(key => required.includes(key) || optional.includes(key)));
  return result;
}
const text = (value: unknown, max = 2000): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const id = (value: unknown, max = 150): value is string => text(value, max) && /^[A-Za-z0-9_-]+$/.test(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const member = (value: unknown, values: readonly string[]): value is string => typeof value === "string" && values.includes(value);
const slots = ["top", "bottom", "shoes"] as const;
type Slot = typeof slots[number];
const cleanupStates = ["retained", "pending", "failed", "deleted", "not_present"];
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|\+00:00)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(value);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .every((part, index) => part === Number(match[index + 1]));
}
function size(value: unknown, slot: Slot) {
  const result = record(value, ["system", "value"]);
  requireValue(result.system === (slot === "shoes" ? "cn_shoe" : "clothing_alpha"));
  requireValue(typeof result.value === "string" && (slot === "shoes" ? ["35", "36", "37", "38", "39", "40"] : ["S", "M", "L", "XL"]).includes(result.value));
}
function selection(value: unknown): { digest: string; target: PersonalPreviewTarget } {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
    throw new PersonalPreviewApiError(502, "PREVIEW_HISTORY_METADATA_UNAVAILABLE", "原记录的搭配内容已不可用，无法核对历史展示；不会用当前搭配补齐。");
  }
  const result = record(value, ["snapshot_id", "snapshot_digest", "session_id", "look_version_id", "look_asset_id", "items", "fixed_image", "resources", "scene", "effective_conditions", "profile_summary", "prompt_version"], ["look_version_no"]);
  requireValue(sha(result.snapshot_digest) && result.snapshot_id === `pvs-${result.snapshot_digest.slice(0, 32)}`);
  requireValue(id(result.session_id, 64) && id(result.look_version_id) && id(result.look_asset_id));
  if (Object.hasOwn(result, "look_version_no")) requireValue(integer(result.look_version_no, 1));
  requireValue(member(result.prompt_version, ["personal_preview_prompt_v1", "personal_preview_identity_four_refs_v1"]) && (result.scene === null || text(result.scene, 200)));
  const resources = record(result.resources, ["catalog_version", "inventory_snapshot_id", "look_asset_version", "rule_set_version", "attribute_vocabulary_version"]);
  requireValue(Object.values(resources).every(value => id(value, 200)));
  const fixed = record(result.fixed_image, ["asset_id", "sha256", "origin"]);
  requireValue(fixed.asset_id === result.look_asset_id && sha(fixed.sha256));
  const origin = record(fixed.origin, ["origin_type", "source_name", "source_ref", "is_simulated", "rights_confirmed"]);
  requireValue(member(origin.origin_type, ["self_created", "ai_generated", "open_licensed", "authorized"])
    && text(origin.source_name) && typeof origin.source_ref === "string" && origin.source_ref.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(origin.source_ref)
    && origin.is_simulated === true && origin.rights_confirmed === true);
  if (member(origin.origin_type, ["open_licensed", "authorized"])) requireValue(text(origin.source_ref));
  const conditions = record(result.effective_conditions, [], ["budget_max_fen", "usual_sizes"]);
  if (Object.hasOwn(conditions, "budget_max_fen")) requireValue(conditions.budget_max_fen === null || integer(conditions.budget_max_fen));
  if (Object.hasOwn(conditions, "usual_sizes")) {
    const sizes = record(conditions.usual_sizes, [], slots);
    for (const slot of slots) if (Object.hasOwn(sizes, slot)) size(sizes[slot], slot);
  }
  if (result.profile_summary !== null) {
    const profile = record(result.profile_summary, [], ["profile_id", "profile_version", "snapshot_id", "snapshot_digest"]);
    if (Object.hasOwn(profile, "profile_id")) requireValue(profile.profile_id === null || id(profile.profile_id, 64));
    if (Object.hasOwn(profile, "profile_version")) requireValue(integer(profile.profile_version));
    if (Object.hasOwn(profile, "snapshot_id")) requireValue(id(profile.snapshot_id, 64));
    if (Object.hasOwn(profile, "snapshot_digest")) requireValue(sha(profile.snapshot_digest));
  }
  requireValue(Array.isArray(result.items) && result.items.length === 3);
  const seen = new Set<string>();
  const items = result.items.map(value => {
    const item = record(value, ["slot", "sku_id", "product_id", "size", "price_fen", "reference_asset_id", "reference_version", "reference_sha256"]);
    requireValue(member(item.slot, slots) && !seen.has(item.slot)); seen.add(item.slot);
    requireValue(id(item.sku_id) && id(item.product_id) && integer(item.price_fen) && id(item.reference_asset_id) && integer(item.reference_version, 1) && sha(item.reference_sha256));
    size(item.size, item.slot as Slot);
    return { slot: item.slot as Slot, skuId: item.sku_id, name: item.sku_id, referenceAssetId: item.reference_asset_id, referenceVersion: String(item.reference_version) };
  });
  requireValue(new Set(items.map(item => item.skuId)).size === 3);
  return { digest: result.snapshot_digest, target: { sessionId: result.session_id, lookVersionId: result.look_version_id,
    lookId: result.look_asset_id, versionNo: typeof result.look_version_no === "number" ? result.look_version_no : null, modelUrl: null, selectionDigest: result.snapshot_digest, items } };
}

function capabilityNotes(value: Record<string, unknown>) {
  const caps = record(value, ["contract_version", "enabled", "available", "provider_mode", "is_mock", "real_provider_enabled", "limits", "retention", "reasons"], ["provider_model"]);
  requireValue(caps.contract_version === PERSONAL_PREVIEW_CONTRACT && typeof caps.enabled === "boolean" && typeof caps.available === "boolean"
    && typeof caps.is_mock === "boolean" && typeof caps.real_provider_enabled === "boolean" && (!caps.available || caps.enabled));
  const real = caps.provider_mode === "runninghub";
  requireValue(real ? caps.available === true && caps.is_mock === false && caps.real_provider_enabled === true && caps.provider_model === "rhart-image-n-pro-official/edit"
    : caps.is_mock === caps.available && caps.real_provider_enabled === false && caps.provider_mode === (caps.available ? "mock" : "disabled") && (caps.provider_model === undefined || caps.provider_model === null));
  requireValue(Array.isArray(caps.reasons) && (caps.available ? caps.reasons.length === 0
    : caps.reasons.length === 1 && caps.reasons[0] === (caps.enabled ? "PREVIEW_PROVIDER_UNAVAILABLE" : "PREVIEW_DISABLED")));
  const limits = record(caps.limits, ["photo_max_bytes", "metadata_max_bytes", "max_pixels", "max_side", "formats", "active_per_owner", "daily_tasks"], real ? ["total_real_tasks"] : []);
  if (real) requireValue(limits.total_real_tasks === 1);
  const formats = limits.formats;
  requireValue(limits.photo_max_bytes === 5 * 1024 * 1024 && limits.metadata_max_bytes === 8 * 1024 && limits.max_pixels === 20_000_000 && limits.max_side === 8192
    && limits.active_per_owner === 1 && integer(limits.daily_tasks, 1) && limits.daily_tasks <= 100
    && Array.isArray(formats) && formats.length === 3 && ["jpeg", "png", "webp"].every(format => formats.includes(format)));
  const retention = record(caps.retention, ["confirmation_seconds", "input_hard_seconds", "result_seconds", "metadata_seconds", "request_tombstones", "provider_retention"]);
  requireValue(retention.confirmation_seconds === 600 && retention.input_hard_seconds === 86400 && retention.result_seconds === 30 * 86400
    && retention.metadata_seconds === 90 * 86400 && retention.request_tombstones === "retained" && retention.provider_retention === "unknown");
  return {
    purposeNote: real ? "RunningHub将处理去元数据后的本人照片与本次冻结的上衣、下装、鞋三张参考图，用于本人AI穿搭参考；照片及本人效果不进入产品或设计交接。" : caps.available ? "仅用于所选搭配的本地隔离模拟，不能作为本人真实效果。" : "本人效果服务当前不可用，不会上传照片或发起生成。",
    retentionNote: "安全重编码输入最长保留24小时，结果30天，记录内容90天；原请求防重标记保留。供应商留存与物理删除情况未知；供应商上传链接有效期不代表照片已删除。",
    costNote: real ? "本轮整个实例最多1个真实任务，失败、删除或重新打开不重置额度。供应商权限、余额与实际费用以真实调用为准；费用未知，不自动再次生成。" : `本地模拟每天最多${limits.daily_tasks}个任务，同时最多1个；不是实际生成额度或价格。真实调用费用未知。`,
  };
}

const taskKeys = ["contract_version", "task_id", "request_id", "session_id", "look_version_id", "state", "deletion_status", "created_at", "updated_at", "expires_at", "selection", "is_mock", "effect_kind", "effective_personal_preview", "result_available", "result_url", "error", "input_cleanup", "usage", "selection_status", "model_image_url"];
function taskEnvelope(value: unknown) {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "task")) {
    const envelope = record(value, ["task", "duplicate"]); requireValue(typeof envelope.duplicate === "boolean");
    // The transport checks duplicate against HTTP 200/202 before parsing the task.
    return record(envelope.task, taskKeys);
  }
  return record(value, taskKeys);
}
function taskDetails(value: { input_cleanup: unknown; usage: unknown; effect_kind: string; is_mock: boolean }) {
  const cleanup = record(value.input_cleanup, ["status", "expires_at"]);
  requireValue(member(cleanup.status, cleanupStates) && timestamp(cleanup.expires_at));
  const usage = record(value.usage, ["task_count", "attempt_count", "unknown_attempts", "cost_status"], value.is_mock ? [] : ["provider_model", "cost_amount", "cost_currency", "provider_usage"]);
  if (!value.is_mock && Object.hasOwn(usage, "provider_model")) {
    requireValue(usage.provider_model === "rhart-image-n-pro-official/edit" && usage.cost_amount === null && usage.cost_currency === null);
    const numbers = record(usage.provider_usage, [], Object.keys(usage.provider_usage !== null && typeof usage.provider_usage === "object" ? usage.provider_usage : {}));
    requireValue(Object.keys(numbers).length <= 100 && Object.entries(numbers).every(([key, number]) => id(key, 100) && typeof number === "number" && Number.isFinite(number) && number >= 0));
  } else if (!value.is_mock) requireValue(!["cost_amount", "cost_currency", "provider_usage"].some(key => Object.hasOwn(usage, key)));
  requireValue(usage.task_count === 1 && integer(usage.attempt_count) && usage.attempt_count <= 1
    && integer(usage.unknown_attempts) && usage.unknown_attempts <= usage.attempt_count);
  requireValue(typeof value.is_mock === "boolean" && (value.is_mock ? value.effect_kind === "mock_not_real" : member(value.effect_kind, ["unavailable", "ai_personal_reference"]))
    && usage.cost_status === (value.is_mock ? "not_applicable_mock" : "unknown"));
}
function deletion(value: unknown): { taskId: string; status: "deleting" | "deleted" } {
  const result = record(value, ["contract_version", "task_id", "deletion_status", "duplicate", "input_deletion", "result_deletion", "provider_cancel", "provider_deletion", "backup_deletion"]);
  requireValue(result.contract_version === PERSONAL_PREVIEW_CONTRACT && id(result.task_id, 64) && typeof result.duplicate === "boolean"
    && (result.deletion_status === "deleting" || result.deletion_status === "deleted")
    && member(result.input_deletion, cleanupStates) && member(result.result_deletion, cleanupStates)
    && member(result.provider_cancel, ["unknown", "not_applicable_mock"]) && result.provider_deletion === result.provider_cancel
    && result.backup_deletion === "unknown");
  if (result.deletion_status === "deleted") requireValue(member(result.input_deletion, ["deleted", "not_present"]) && member(result.result_deletion, ["deleted", "not_present"]));
  return { taskId: result.task_id, status: result.deletion_status };
}

export const personalPreviewSchema: PersonalPreviewSchema = { capabilityNotes, selection, taskEnvelope, taskDetails, deletion };
