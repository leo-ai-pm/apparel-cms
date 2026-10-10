import { appPath } from "./app-path";
import { PersonalPreviewError, type PersonalPreviewAvailability, type PersonalPreviewService, type PersonalPreviewSubmission,
  type PersonalPreviewTarget, type PersonalPreviewTask } from "./personal-preview-model";

export const PERSONAL_PREVIEW_CONTRACT = "personal_outfit_preview_v1" as const;
const ROOT = "/api/v1/personal-preview";
const MAX_PAGES = 100;
const SHA = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = ["queued", "running", "provider_unknown", "output_pending_review", "succeeded", "failed", "expired"] as const;
const DELETIONS = ["active", "deleting", "deleted"] as const;

/** The PP-0 prose does not lock these nested wire shapes. An implementation must
 * validate their exact, closed schema before projecting them into these UI values.
 * A missing parser fails closed; these projections are not guessed API DTOs. */
export interface PersonalPreviewSchema {
  capabilityNotes(value: Record<string, unknown>): { purposeNote: string; retentionNote: string; costNote: string };
  selection(value: unknown): { digest: string; target: PersonalPreviewTarget };
  taskEnvelope(value: unknown): Record<string, unknown>;
  taskDetails(value: { input_cleanup: unknown; usage: unknown; effect_kind: string; is_mock: boolean }): void;
  deletion(value: unknown): { taskId: string; status: "deleting" | "deleted" };
}
export interface PersonalPreviewApiService extends PersonalPreviewService {
  retry(requestId: string, signal: AbortSignal): Promise<PersonalPreviewTask>;
  canRetry(requestId: string): boolean;
  releaseSensitive(): void;
}
export class PersonalPreviewApiError extends PersonalPreviewError {
  constructor(readonly status: number, readonly code: string, message: string, identityInvalid = false, definitive = false) {
    super(message, identityInvalid, definitive, code, status); this.name = "PersonalPreviewApiError";
  }
}
const invalid = () => new PersonalPreviewApiError(502, "PREVIEW_INVALID_RESPONSE", "本人效果响应无法验证，请查询原记录；不会按此判断生成或删除成功。");
const schemaUnavailable = () => new PersonalPreviewApiError(503, "PREVIEW_SCHEMA_UNAVAILABLE", "本人效果接口的完整数据结构尚未锁定，当前不能确认上传或使用返回结果。");
const invalidInput = () => new PersonalPreviewApiError(422, "PREVIEW_INVALID_REQUEST", "请核对本次照片、搭配版本与原请求编号。", false, true);
const aborted = () => new PersonalPreviewApiError(0, "PREVIEW_ABORTED", "本次读取或提交已停止，请查询原请求；不代表云任务已取消。");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const text = (value: unknown, max = 2000): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const sha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
const sameTarget = (left: PersonalPreviewTarget, right: PersonalPreviewTarget) => left.sessionId === right.sessionId && left.lookVersionId === right.lookVersionId;
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|\+00:00)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(value);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .every((component, index) => component === Number(match[index + 1]));
}

/** Bounded JSON reader rejects duplicate keys, including escaped aliases. */
export function parsePersonalPreviewJson(raw: string): unknown {
  if (raw.length > 2_000_000) throw invalid();
  let at = 0;
  const space = () => { while (/[\t\r\n ]/.test(raw[at] ?? "~")) at++; };
  function string(): string {
    const start = at;
    if (raw[at++] !== '"') throw invalid();
    while (at < raw.length) {
      const char = raw[at++];
      if (char === '"') return JSON.parse(raw.slice(start, at)) as string;
      if (char === "\\") at++;
      else if (char.charCodeAt(0) < 32) throw invalid();
    }
    throw invalid();
  }
  function value(depth: number): unknown {
    if (depth > 64) throw invalid();
    space();
    if (raw[at] === '"') return string();
    if (raw[at] === "{") {
      at++; space(); const result: Record<string, unknown> = Object.create(null);
      if (raw[at] === "}") { at++; return result; }
      while (true) {
        space(); const key = string(); space();
        if (Object.hasOwn(result, key) || raw[at++] !== ":") throw invalid();
        result[key] = value(depth + 1); space();
        if (raw[at] === "}") { at++; return result; }
        if (raw[at++] !== ",") throw invalid();
      }
    }
    if (raw[at] === "[") {
      at++; space(); const result: unknown[] = [];
      if (raw[at] === "]") { at++; return result; }
      while (true) {
        result.push(value(depth + 1)); space();
        if (raw[at] === "]") { at++; return result; }
        if (raw[at++] !== ",") throw invalid();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at));
    if (!match) throw invalid();
    at += match[0].length; const result: unknown = JSON.parse(match[0]);
    if (typeof result === "number" && !Number.isFinite(result)) throw invalid();
    return result;
  }
  try { const result = value(0); space(); if (at !== raw.length) throw invalid(); return result; }
  catch { throw invalid(); }
}

const safeMessages: Record<string, string> = {
  PROFILE_OWNER_INVALID: "当前身份已失效，请重新确认身份。",
  PREVIEW_AUTH_NOT_SUPPORTED: "当前身份暂不支持本人照片授权。",
  PREVIEW_NOT_FOUND: "当前身份下未查到原记录；不能据此认定未提交或自动新建任务。",
  PREVIEW_CONFIRMATION_INVALID: "本次照片确认无效，请重新读取条件并明确确认。",
  PREVIEW_CONFIRMATION_EXPIRED: "本次照片确认已过期，请重新读取条件并明确确认。",
  PREVIEW_SELECTION_CHANGED: "所选搭配或生成条件已经变化，请重新核对并明确确认。",
  PREVIEW_SESSION_RESTART_REQUIRED: "这段旧对话未建立可验证归属，请明确新建私有对话后再选择搭配。",
  PREVIEW_REFERENCE_UNAVAILABLE: "这套搭配的参考图片暂不齐全或不可用。",
  PREVIEW_LOOK_INELIGIBLE: "这套搭配当前不满足本人效果条件。",
  PREVIEW_CONCURRENCY_LIMIT: "当前仍有未结束的本人效果任务，请先查询原任务。",
  PREVIEW_TOTAL_LIMIT: "本轮整个实例的真实任务额度已用完。失败或删除不重置额度，请查询原任务，不会自动新建。",
  PREVIEW_DAILY_LIMIT: "当前技术任务额度已用完，请保留原记录并稍后核对。",
  PREVIEW_REQUEST_CONFLICT: "原请求编号与提交内容不一致，不能替换原体。",
  PREVIEW_ACTION_CONFLICT: "原删除动作与目标不一致，请核对原记录。",
  PREVIEW_RESULT_NOT_READY: "原任务尚无可读取的本人效果，请查询任务状态。",
  PREVIEW_RESULT_EXPIRED: "原本人效果已过期，不能继续读取。",
  PREVIEW_HISTORY_METADATA_UNAVAILABLE: "搭配内容已按期限清除，原请求记录保留。",
  PREVIEW_DELETED: "原照片与效果已撤销访问，不能继续读取。",
  PREVIEW_DISABLED: "本人效果服务当前未启用。",
  PREVIEW_PROVIDER_UNAVAILABLE: "生成服务当前不可用，请保留原请求。",
  PREVIEW_STORAGE_UNAVAILABLE: "本人效果存储当前不可用，请查询原请求。",
  PREVIEW_UPLOAD_TOO_LARGE: "照片超过上传限额，请重新选择。",
  PREVIEW_FORMAT_UNSUPPORTED: "照片格式不支持，请选择 JPEG、PNG 或 WebP。",
  PREVIEW_PHOTO_INVALID: "照片无法安全读取，请重新选择有效图片。",
  PREVIEW_PIXELS_EXCEEDED: "照片像素超过处理限额，请缩小后重新选择。",
  PREVIEW_HASH_MISMATCH: "照片内容与本次确认不一致，请重新选择并确认。",
  PREVIEW_INVALID_REQUEST: "本人效果请求字段无效，请核对原请求与照片。",
};
const terminalCodes = new Set(["PREVIEW_TOTAL_LIMIT", "PREVIEW_REQUEST_CONFLICT", "PREVIEW_ACTION_CONFLICT", "PREVIEW_CONFIRMATION_INVALID", "PREVIEW_CONFIRMATION_EXPIRED",
  "PREVIEW_SELECTION_CHANGED", "PREVIEW_SESSION_RESTART_REQUIRED", "PREVIEW_REFERENCE_UNAVAILABLE", "PREVIEW_LOOK_INELIGIBLE",
  "PREVIEW_UPLOAD_TOO_LARGE", "PREVIEW_FORMAT_UNSUPPORTED", "PREVIEW_PHOTO_INVALID", "PREVIEW_PIXELS_EXCEEDED", "PREVIEW_HASH_MISMATCH", "PREVIEW_INVALID_REQUEST"]);
// A conflicting original ID may already represent an accepted task/action.
const definitiveCodes = new Set([...terminalCodes].filter(code => !["PREVIEW_REQUEST_CONFLICT", "PREVIEW_ACTION_CONFLICT"].includes(code)));
const reasonCodes = new Set(["PREVIEW_DISABLED", "PREVIEW_PROVIDER_UNAVAILABLE", "PREVIEW_LOOK_INELIGIBLE", "PREVIEW_REFERENCE_UNAVAILABLE"]);
function reasonMessages(values: unknown[]): string[] {
  return values.map(value => typeof value === "string" && reasonCodes.has(value) ? safeMessages[value] : "接口返回了未识别的生成条件，当前不能提交。请重新读取并核对。");
}

function validateTarget(target: PersonalPreviewTarget) {
  if (!object(target) || !exact(target, ["sessionId", "lookVersionId", "versionNo", "lookId", "modelUrl", "items"], ["selectionDigest"])
    || typeof target.sessionId !== "string" || !REQUEST_ID.test(target.sessionId) || typeof target.lookVersionId !== "string" || !REQUEST_ID.test(target.lookVersionId)
    || !id(target.lookId) || (target.versionNo !== null && (typeof target.versionNo !== "number" || !Number.isSafeInteger(target.versionNo) || target.versionNo < 1))
    || (target.modelUrl !== null && (!text(target.modelUrl, 2048) || !target.modelUrl.startsWith("/") || target.modelUrl.startsWith("//") || /[\\\s?#]/.test(target.modelUrl)))
    || ("selectionDigest" in target && !sha(target.selectionDigest))
    || !Array.isArray(target.items) || target.items.length !== 3 || ["top", "bottom", "shoes"].some(slot => target.items.filter(item => object(item) && item.slot === slot).length !== 1)
    || target.items.some(item => !object(item) || !exact(item, ["slot", "skuId", "name"], ["referenceAssetId", "referenceVersion"]) || !id(item.skuId) || !text(item.name, 200)
      || ("referenceAssetId" in item && !id(item.referenceAssetId)) || ("referenceVersion" in item && !text(item.referenceVersion, 100)))) throw invalid();
}
function targetCopy(target: PersonalPreviewTarget): PersonalPreviewTarget {
  validateTarget(target); return { ...target, items: target.items.map(item => ({ ...item })) };
}
type Metadata = { contract_version: typeof PERSONAL_PREVIEW_CONTRACT; request_id: string; session_id: string; look_version_id: string;
  selection_digest: string; photo_sha256: string; confirmation_id: string; confirmation_token: string };
type Original = { epoch: number; target: PersonalPreviewTarget; digest: string; file: File | null; metadata: string | null; expiresAt: number; queriedMissing: boolean; busy: boolean };

/** No persistence or raw upstream messages; one instance belongs to one consumer lifetime. */
export function createPersonalPreviewService({ schema }: { schema?: PersonalPreviewSchema } = {}): PersonalPreviewApiService {
  let epoch = 0;
  let permits = new WeakMap<object, { target: PersonalPreviewTarget; digest: string }>();
  const originals = new Map<string, Original>();
  const controls = new Set<AbortController>();
  const requireSchema = () => { if (!schema) throw schemaUnavailable(); return schema; };
  function parseWithSchema<T>(parse: () => T): T {
    try { return parse(); } catch (cause) { if (cause instanceof PersonalPreviewError) throw cause; throw invalid(); }
  }
  function releaseSensitive() {
    epoch++; permits = new WeakMap(); for (const original of originals.values()) { original.file = null; original.metadata = null; }
    originals.clear(); for (const control of controls) control.abort(); controls.clear();
  }
  function live(generation: number, signal: AbortSignal) { if (generation !== epoch || signal.aborted) throw aborted(); }
  async function fetchResponse(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    const control = new AbortController(); const generation = epoch;
    const onAbort = () => control.abort(); signal.addEventListener("abort", onAbort, { once: true }); controls.add(control);
    try {
      live(generation, signal);
      const response = await fetch(appPath(path), { ...init, credentials: "include", cache: "no-store", redirect: "error", signal: control.signal });
      live(generation, signal);
      if (response.redirected || response.type === "opaqueredirect") throw invalid();
      return response;
    } catch (cause) {
      if (cause instanceof PersonalPreviewError) throw cause;
      if (control.signal.aborted || signal.aborted || generation !== epoch) throw aborted();
      throw new PersonalPreviewApiError(0, "PREVIEW_NETWORK_ERROR", "本人效果请求未能确认，请查询原请求；不会自动重新提交。");
    } finally { signal.removeEventListener("abort", onAbort); controls.delete(control); }
  }
  async function readJson(response: Response): Promise<unknown> {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw invalid();
    if (!(response.headers.get("cache-control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store")) throw invalid();
    let raw: string;
    try { raw = await response.text(); } catch { throw new PersonalPreviewApiError(0, "PREVIEW_NETWORK_ERROR", "本人效果响应读取未能确认，请查询原请求；不会自动重新提交。"); }
    return parsePersonalPreviewJson(raw);
  }
  async function error(response: Response): Promise<never> {
    let code = "PREVIEW_HTTP_ERROR";
    try {
      const raw = await readJson(response);
      if (object(raw) && exact(raw, ["error"]) && object(raw.error) && exact(raw.error, ["code", "message"])
        && typeof raw.error.code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(raw.error.code) && typeof raw.error.message === "string") code = raw.error.code;
    } catch { /* Upstream text, credentials and invalid JSON are never shown. */ }
    const identityInvalid = response.status === 401 || response.status === 403;
    if (identityInvalid) releaseSensitive();
    throw new PersonalPreviewApiError(response.status, code, safeMessages[code] ?? (identityInvalid ? "当前身份或照片权限已失效，请重新确认身份。" : "本人效果请求未完成，请查询原记录并核对状态。"), identityInvalid,
      definitiveCodes.has(code));
  }
  async function json(path: string, signal: AbortSignal, statuses: readonly number[] = [200], body?: object): Promise<unknown> {
    const response = await fetchResponse(path, signal, body ? { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) } : { method: "GET", headers: { Accept: "application/json" } });
    if (!response.ok) return error(response);
    if (!statuses.includes(response.status)) throw invalid();
    return readJson(response);
  }
  function selection(raw: unknown) {
    const result = parseWithSchema(() => requireSchema().selection(raw));
    if (!object(result) || !sha(result.digest)) throw invalid();
    validateTarget(result.target); return { digest: result.digest, target: { ...targetCopy(result.target), selectionDigest: result.digest } };
  }
  function parseTask(value: unknown): PersonalPreviewTask {
    const raw = parseWithSchema(() => requireSchema().taskEnvelope(value));
    const required = ["contract_version", "task_id", "request_id", "session_id", "look_version_id", "state", "deletion_status", "created_at", "updated_at", "expires_at", "selection", "is_mock", "effect_kind", "effective_personal_preview", "result_available", "result_url", "error", "input_cleanup", "usage", "selection_status", "model_image_url"];
    if (!object(raw) || !exact(raw, required) || raw.contract_version !== PERSONAL_PREVIEW_CONTRACT || !id(raw.task_id)
      || typeof raw.request_id !== "string" || !REQUEST_ID.test(raw.request_id) || !id(raw.session_id) || !id(raw.look_version_id)
      || !STATUSES.includes(raw.state as PersonalPreviewTask["status"]) || !DELETIONS.includes(raw.deletion_status as PersonalPreviewTask["deletion"])
      || !timestamp(raw.created_at) || !timestamp(raw.updated_at) || Date.parse(raw.updated_at) < Date.parse(raw.created_at)
      || !(raw.expires_at === null || timestamp(raw.expires_at)) || typeof raw.is_mock !== "boolean" || !text(raw.effect_kind, 80)
      || typeof raw.effective_personal_preview !== "boolean" || typeof raw.result_available !== "boolean") throw invalid();
    if (raw.is_mock && (raw.effect_kind !== "mock_not_real" || raw.effective_personal_preview || raw.state === "succeeded")
      || (!raw.is_mock && raw.state === "succeeded" && !raw.effective_personal_preview)
      || (raw.effective_personal_preview && raw.state !== "succeeded")) throw invalid();
    if (!raw.is_mock && (raw.effective_personal_preview || raw.state === "succeeded" || raw.effect_kind !== (raw.result_available ? "ai_personal_reference" : "unavailable"))) throw invalid();
    if (raw.error !== null && (!object(raw.error) || !exact(raw.error, ["code", "message"]) || !text(raw.error.code, 80) || !text(raw.error.message))) throw invalid();
    if (!["available", "content_cleared"].includes(String(raw.selection_status))) throw invalid();
    let selected: { target: PersonalPreviewTarget };
    if (raw.selection_status === "content_cleared") {
      if (!object(raw.selection) || Object.keys(raw.selection).length || raw.result_available || raw.result_url !== null || raw.model_image_url !== null) throw invalid();
      selected = { target: { sessionId: raw.session_id, lookVersionId: raw.look_version_id, versionNo: null, lookId: null, modelUrl: null, items: [], contentCleared: true } };
    } else selected = selection(raw.selection);
    if (selected.target.sessionId !== raw.session_id || selected.target.lookVersionId !== raw.look_version_id) throw invalid();
    const modelPath = `${ROOT}/tasks/${encodeURIComponent(raw.task_id)}/model-image`;
    if (raw.model_image_url !== null && (raw.model_image_url !== modelPath || raw.selection_status !== "available" || raw.deletion_status !== "active" || raw.state === "expired"
      || raw.expires_at !== null && Date.parse(String(raw.expires_at)) <= Date.now())) throw invalid();
    const resultPath = `${ROOT}/tasks/${encodeURIComponent(raw.task_id)}/result`;
    if (raw.result_available ? raw.result_url !== resultPath || raw.deletion_status !== "active" || !["succeeded", "output_pending_review"].includes(String(raw.state))
      || (raw.expires_at !== null && Date.parse(String(raw.expires_at)) <= Date.now()) : raw.result_url !== null) throw invalid();
    const effectKind = raw.effect_kind, isMock = raw.is_mock;
    parseWithSchema(() => requireSchema().taskDetails({ input_cleanup: raw.input_cleanup, usage: raw.usage, effect_kind: effectKind, is_mock: isMock }));
    return { id: raw.task_id, requestId: raw.request_id, target: selected.target, status: raw.state as PersonalPreviewTask["status"], deletion: raw.deletion_status as PersonalPreviewTask["deletion"],
      selectionStatus: raw.selection_status as "available" | "content_cleared", modelImagePath: raw.model_image_url as string | null,
      createdAt: raw.created_at, expiresAt: raw.expires_at as string | null, hasResult: raw.result_available, mode: raw.is_mock ? "mock" : "real",
      detail: raw.error !== null && object(raw.error) ? safeMessages[String(raw.error.code)] ?? "原任务报告异常，请查询状态；不会提供替代成功图。" : raw.is_mock ? "技术模拟任务，非本人真实效果，不代表生成保真或真实费用。" : "真实供应商任务；画面与三件SKU仍待用户核对，费用与供应商删除状态未知。" };
  }
  async function availability(target: PersonalPreviewTarget, signal: AbortSignal): Promise<PersonalPreviewAvailability> {
    const generation = epoch; validateTarget(target);
    const caps = await json(`${ROOT}/capabilities`, signal); live(generation, signal);
    if (!object(caps) || !exact(caps, ["contract_version", "enabled", "available", "provider_mode", "is_mock", "real_provider_enabled", "limits", "retention", "reasons"], ["provider_model"])
      || caps.contract_version !== PERSONAL_PREVIEW_CONTRACT || typeof caps.enabled !== "boolean" || typeof caps.available !== "boolean" || typeof caps.is_mock !== "boolean"
      || typeof caps.real_provider_enabled !== "boolean" || !text(caps.provider_mode, 80) || !Array.isArray(caps.reasons) || !caps.reasons.every(reason => text(reason))
      || (caps.available && (!caps.enabled || (!caps.is_mock && !caps.real_provider_enabled))) || (caps.is_mock && caps.real_provider_enabled)) throw invalid();
    const notes = parseWithSchema(() => requireSchema().capabilityNotes(caps));
    if (![notes.purposeNote, notes.retentionNote, notes.costNote].every(note => text(note))) throw invalid();
    const capsAvailable = caps.available && caps.reasons.length === 0;
    const mode = capsAvailable ? caps.is_mock ? "mock" : "real" : "unavailable";
    if (!capsAvailable) return { available: false, reasons: reasonMessages(caps.reasons), mode, ...notes, permit: null };
    const params = new URLSearchParams({ session_id: target.sessionId, look_version_id: target.lookVersionId });
    const raw = await json(`${ROOT}/availability?${params}`, signal); live(generation, signal);
    if (!object(raw) || !exact(raw, ["contract_version", "available", "reasons", "selection_digest", "selection"]) || raw.contract_version !== PERSONAL_PREVIEW_CONTRACT || typeof raw.available !== "boolean"
      || !Array.isArray(raw.reasons) || !raw.reasons.every(reason => text(reason)) || !sha(raw.selection_digest)) throw invalid();
    if (!raw.available || raw.reasons.length > 0) return { available: false, reasons: reasonMessages(raw.reasons), mode: "unavailable", ...notes, permit: null };
    const selected = selection(raw.selection);
    if (selected.digest !== raw.selection_digest || !sameTarget(selected.target, target)) throw invalid();
    const permit = raw.available ? Object.freeze({}) : null;
    if (permit) permits.set(permit, { target: selected.target, digest: selected.digest });
    return { available: raw.available, reasons: reasonMessages(raw.reasons), mode: raw.available ? mode : "unavailable", ...notes, selection: selected.target, permit };
  }
  async function readPhoto(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
    if (!(file instanceof File) || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024) throw invalidInput();
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); const onAbort = () => { reader.abort(); reject(aborted()); };
      signal.addEventListener("abort", onAbort, { once: true });
      reader.onload = () => { signal.removeEventListener("abort", onAbort); if (reader.result instanceof ArrayBuffer) resolve(reader.result); else reject(invalidInput()); };
      reader.onerror = () => { signal.removeEventListener("abort", onAbort); reject(invalidInput()); };
      reader.onabort = () => signal.removeEventListener("abort", onAbort);
      reader.readAsArrayBuffer(file);
    });
  }
  async function upload(requestId: string, original: Original, signal: AbortSignal): Promise<PersonalPreviewTask> {
    if (original.busy || !original.file || !original.metadata) throw invalidInput();
    live(original.epoch, signal); original.busy = true; original.queriedMissing = false;
    try {
      const data = new FormData(); data.append("metadata", new Blob([original.metadata], { type: "application/json" }), "metadata.json"); data.append("photo", original.file, "personal-photo");
      const response = await fetchResponse(`${ROOT}/tasks`, signal, { method: "POST", headers: { Accept: "application/json" }, body: data });
      live(original.epoch, signal); if (!response.ok) return await error(response);
      if (![200, 202].includes(response.status)) throw invalid();
      const raw = await readJson(response); live(original.epoch, signal);
      if (!object(raw) || !exact(raw, ["task", "duplicate"]) || raw.duplicate !== (response.status === 200)) throw invalid();
      const result = parseTask(raw);
      if (result.requestId !== requestId || !sameTarget(result.target, original.target) || result.target.selectionDigest !== original.digest) throw invalid();
      originals.delete(requestId); original.file = null; original.metadata = null; return result;
    } catch (cause) {
      if (cause instanceof PersonalPreviewApiError && (cause.identityInvalid || terminalCodes.has(cause.code))) { original.file = null; original.metadata = null; originals.delete(requestId); }
      throw cause;
    } finally { original.busy = false; }
  }
  async function submit(request: PersonalPreviewSubmission, signal: AbortSignal): Promise<PersonalPreviewTask> {
    try { requireSchema(); } catch { throw new PersonalPreviewApiError(503, "PREVIEW_SCHEMA_UNAVAILABLE", "本人效果接口的完整数据结构尚未锁定，当前不会确认上传。", false, true); }
    const generation = epoch; live(generation, signal);
    if (originals.has(request.requestId)) throw new PersonalPreviewApiError(409, "PREVIEW_ORIGINAL_REQUEST_PENDING", "原请求仍待核对，请先查询原编号；不会另发提交。");
    if (!REQUEST_ID.test(request.requestId) || !object(request.permit)) throw invalidInput();
    const permit = permits.get(request.permit); if (!permit || !sameTarget(permit.target, request.target)) throw invalidInput();
    permits.delete(request.permit);
    const original: Original = { epoch: generation, target: targetCopy(permit.target), digest: permit.digest, file: request.photo, metadata: null, expiresAt: 0, queriedMissing: false, busy: true };
    let uploadStarted = false;
    originals.set(request.requestId, original);
    try {
      const bytes = await readPhoto(request.photo, signal); live(generation, signal);
      let hashed: ArrayBuffer;
      try { hashed = await crypto.subtle.digest("SHA-256", bytes); } catch { throw new PersonalPreviewApiError(0, "PREVIEW_HASH_UNAVAILABLE", "本机无法核对照片摘要，当前不会上传。请重新选择并确认。", false, true); }
      const digest = Array.from(new Uint8Array(hashed), byte => byte.toString(16).padStart(2, "0")).join(""); live(generation, signal);
      const confirmed = await json(`${ROOT}/confirmations`, signal, [201], { contract_version: PERSONAL_PREVIEW_CONTRACT, session_id: permit.target.sessionId, look_version_id: permit.target.lookVersionId,
        selection_digest: permit.digest, photo_sha256: digest, confirmed_photo_rights: true, confirmed_ai_reference: true }); live(generation, signal);
      if (!object(confirmed) || !exact(confirmed, ["confirmation_id", "confirmation_token", "issued_at", "expires_at", "selection"], ["contract_version"])
        || ("contract_version" in confirmed && confirmed.contract_version !== PERSONAL_PREVIEW_CONTRACT) || !id(confirmed.confirmation_id)
        || typeof confirmed.confirmation_token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(confirmed.confirmation_token)
        || !timestamp(confirmed.issued_at) || !timestamp(confirmed.expires_at) || Date.parse(confirmed.expires_at) <= Date.parse(confirmed.issued_at)
        || Date.parse(confirmed.expires_at) - Date.parse(confirmed.issued_at) > 600_000 || Date.parse(confirmed.expires_at) <= Date.now()) throw invalid();
      const selected = selection(confirmed.selection); if (selected.digest !== permit.digest || !sameTarget(selected.target, permit.target)) throw invalid();
      const metadata: Metadata = { contract_version: PERSONAL_PREVIEW_CONTRACT, request_id: request.requestId, session_id: permit.target.sessionId, look_version_id: permit.target.lookVersionId,
        selection_digest: permit.digest, photo_sha256: digest, confirmation_id: confirmed.confirmation_id, confirmation_token: confirmed.confirmation_token };
      original.metadata = JSON.stringify(metadata); original.expiresAt = Date.parse(confirmed.expires_at); original.busy = false;
      live(generation, signal); uploadStarted = true; return await upload(request.requestId, original, signal);
    } catch (cause) {
      if (!uploadStarted) {
        original.file = null; originals.delete(request.requestId);
        // No task upload was started: a lost confirmation reply cannot have uploaded a photo.
        if (cause instanceof PersonalPreviewApiError) throw new PersonalPreviewApiError(cause.status, cause.code, cause.message, cause.identityInvalid, true);
      }
      if (!(cause instanceof PersonalPreviewError)) throw new PersonalPreviewApiError(0, "PREVIEW_PHOTO_READ_FAILED", "本机照片无法读取，当前没有上传照片，请重新选择。", false, !uploadStarted);
      throw cause;
    }
    finally { original.busy = false; }
  }
  async function findRequest(requestId: string, signal: AbortSignal): Promise<PersonalPreviewTask | null> {
    if (!REQUEST_ID.test(requestId)) throw invalidInput(); const generation = epoch;
    try {
      const result = parseTask(await json(`${ROOT}/requests/${encodeURIComponent(requestId)}`, signal)); live(generation, signal);
      if (result.requestId !== requestId) throw invalid();
      const original = originals.get(requestId);
      if (original && (!sameTarget(original.target, result.target) || result.target.selectionDigest !== original.digest)) throw invalid();
      if (original) { original.file = null; original.metadata = null; originals.delete(requestId); }
      return result;
    } catch (cause) {
      if (cause instanceof PersonalPreviewApiError && cause.status === 404 && cause.code === "PREVIEW_NOT_FOUND") {
        live(generation, signal); const original = originals.get(requestId); if (original && !original.busy) original.queriedMissing = true; return null;
      }
      throw cause;
    }
  }
  function canRetry(requestId: string) {
    const original = originals.get(requestId);
    if (original && !original.busy && original.expiresAt > 0 && original.expiresAt <= Date.now()) { original.file = null; original.metadata = null; originals.delete(requestId); return false; }
    return !!original && original.epoch === epoch && !original.busy && original.queriedMissing && !!original.file && !!original.metadata && original.expiresAt > Date.now();
  }
  async function retry(requestId: string, signal: AbortSignal) {
    const original = originals.get(requestId);
    if (!canRetry(requestId) || !original) throw new PersonalPreviewApiError(409, "PREVIEW_RETRY_UNAVAILABLE", "无法使用有效原体重试。请先查询原请求；确认已过期时须重新核对并明确新动作。");
    return upload(requestId, original, signal);
  }
  async function task(taskId: string, signal: AbortSignal) {
    if (!id(taskId)) throw invalidInput(); const generation = epoch; const result = parseTask(await json(`${ROOT}/tasks/${encodeURIComponent(taskId)}`, signal)); live(generation, signal);
    if (result.id !== taskId) throw invalid(); return result;
  }
  async function history(signal: AbortSignal) {
    const generation = epoch; const seenCursors = new Set<string>(), seenTasks = new Set<string>(); const items: PersonalPreviewTask[] = []; let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ limit: "50" }); if (cursor) params.set("cursor", cursor);
      const raw = await json(`${ROOT}/tasks?${params}`, signal); live(generation, signal);
      if (!object(raw) || !exact(raw, ["items", "next_cursor"]) || !Array.isArray(raw.items) || raw.items.length > 50 || !(raw.next_cursor === null || text(raw.next_cursor, 1024))) throw invalid();
      for (const value of raw.items) { const result = parseTask(value); if (seenTasks.has(result.id)) throw invalid(); seenTasks.add(result.id); items.push(result); }
      if (raw.next_cursor === null) return items;
      if (seenCursors.has(raw.next_cursor)) throw invalid(); seenCursors.add(raw.next_cursor); cursor = raw.next_cursor;
    }
    throw new PersonalPreviewApiError(502, "PREVIEW_HISTORY_LIMIT", "效果历史分页未能完整读取，请保留原记录并稍后重试。");
  }
  async function image(current: PersonalPreviewTask, signal: AbortSignal) {
    requireSchema();
    if (!id(current.id) || !current.hasResult || current.deletion !== "active" || !["succeeded", "output_pending_review"].includes(current.status)) throw invalidInput();
    const generation = epoch; const response = await fetchResponse(`${ROOT}/tasks/${encodeURIComponent(current.id)}/result`, signal, { method: "GET", headers: { Accept: "image/jpeg" } });
    if (!response.ok) return error(response); if (response.status !== 200 || !/^image\/jpeg(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw invalid();
    if (!(response.headers.get("cache-control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store")) throw invalid();
    let blob: Blob;
    try { blob = await response.blob(); } catch { throw new PersonalPreviewApiError(0, "PREVIEW_NETWORK_ERROR", "本人效果图片读取未完成，可重新读取原结果；不会重新生成。"); }
    live(generation, signal); if (!blob.size || blob.type !== "image/jpeg") throw invalid(); return blob;
  }
  async function modelImage(current: PersonalPreviewTask, signal: AbortSignal) {
    const path = `${ROOT}/tasks/${encodeURIComponent(current.id)}/model-image`;
    if (!id(current.id) || current.modelImagePath !== path || current.selectionStatus !== "available" || current.deletion !== "active" || current.status === "expired") throw invalidInput();
    const generation = epoch;
    const response = await fetchResponse(path, signal, { method: "GET", headers: { Accept: "image/png" } });
    if (!response.ok) return error(response);
    if (response.status !== 200 || !/^image\/png(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
      || response.headers.get("x-content-type-options") !== "nosniff" || !sha(response.headers.get("x-content-sha256"))
      || !(response.headers.get("cache-control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store")) throw invalid();
    const blob = await response.blob(); live(generation, signal);
    if (!blob.size || blob.type !== "image/png") throw invalid();
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
    live(generation, signal); if (actual !== response.headers.get("x-content-sha256")) throw invalid();
    return blob;
  }
  async function remove(current: PersonalPreviewTask, actionId: string, signal: AbortSignal) {
    requireSchema(); if (!id(current.id) || !REQUEST_ID.test(actionId)) throw invalidInput(); const generation = epoch;
    const path = `${ROOT}/tasks/${encodeURIComponent(current.id)}`;
    const postedRaw = await json(`${path}/delete`, signal, [200], { contract_version: PERSONAL_PREVIEW_CONTRACT, delete_action_id: actionId });
    const posted = parseWithSchema(() => requireSchema().deletion(postedRaw)); live(generation, signal);
    if (posted.taskId !== current.id || !["deleting", "deleted"].includes(posted.status)) throw invalid();
    const deletionRaw = await json(`${path}/deletion`, signal); const deletion = parseWithSchema(() => requireSchema().deletion(deletionRaw)); live(generation, signal);
    if (deletion.taskId !== current.id || !["deleting", "deleted"].includes(deletion.status) || (posted.status === "deleted" && deletion.status !== "deleted")) throw invalid();
    const result = await task(current.id, signal); live(generation, signal);
    if (result.requestId !== current.requestId || !sameTarget(result.target, current.target) || result.deletion === "active" || (deletion.status === "deleted" && result.deletion !== "deleted")) throw invalid();
    return result;
  }
  return { availability, submit, findRequest, task, history, image, modelImage, remove, retry, canRetry, releaseSensitive };
}
