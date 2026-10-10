import { appPath } from "./app-path";
import type { FixedSession } from "./fixed-outfits";

export const PROFILE_CONTRACT = "consumer_profile_v1" as const;
export const PROFILE_AUTH_CONTEXT_CONTRACT = "consumer_profile_mutation_context_v1" as const;
export interface ExpectedProfileAuthorizationContext {
  context_contract: typeof PROFILE_AUTH_CONTEXT_CONTRACT; context_id: string; operation_token: string;
}
export interface ProfileAuthorizationContext extends ExpectedProfileAuthorizationContext { issued_at: string; expires_at: string }
export const PROFILE_LIMITS = {
  height_cm: { min: 100, max: 250, step: 0.5 },
  weight_kg: { min: 20, max: 300, step: 0.5 },
  budget_fen: { min: 1, max: 100000000 },
} as const;
export type ProfileStatus = "empty" | "saved" | "cleared" | "expired";
export type ProfileScope = "device" | "user";
export type ClothingProfileSize = { system: "clothing_alpha"; value: "S" | "M" | "L" | "XL" };
export type ShoeProfileSize = { system: "cn_shoe"; value: "35" | "36" | "37" | "38" | "39" | "40" };
export interface UsualSizes { top?: ClothingProfileSize | null; bottom?: ClothingProfileSize | null; shoes?: ShoeProfileSize | null }
export interface ProfileFields { height_cm?: number | null; weight_kg?: number | null; usual_sizes?: UsualSizes | null }
export interface ProfilePatch { base_profile?: ProfileFields | null; default_budget_fen?: number | null }
export interface SavedConsumerProfile {
  profile_contract: typeof PROFILE_CONTRACT; profile_id: string | null; profile_version: number;
  scope_kind: ProfileScope; status: ProfileStatus;
  base_profile: { height_cm: number | null; weight_kg: number | null; usual_sizes: Required<UsualSizes> };
  default_budget_fen: number | null; updated_at: string | null; expires_at: string | null; storage_notice: string;
  authorization_context?: ProfileAuthorizationContext;
}
export interface ProfileMutation {
  profile_action_id: string; operation: "save" | "update" | "clear"; expected_profile_version: number;
  patch: ProfilePatch; explicit_save?: boolean; explicit_default_budget?: boolean;
  expected_authorization_context?: ExpectedProfileAuthorizationContext;
}
export interface ProfileMutationReceipt {
  profile_contract: typeof PROFILE_CONTRACT; profile_action_id: string; operation: "save" | "update" | "clear" | "expire";
  profile_id: string; scope_kind: ProfileScope; version_before: number; profile_version: number;
  profile_status: "saved" | "cleared" | "expired"; changed_field_names: string[]; status: "succeeded"; created_at: string;
}
export interface ProfileBinding { snapshot_id: string; profile_id: string | null; profile_version: number; snapshot_digest: string }
export interface RequestConditions { scene?: string | null; budget_max_fen?: number | null; request_profile_overrides?: ProfileFields | null }
export type ProfileFieldSource = "saved_profile" | "current_request" | "explicit_selection" | "explicit_text";
export type ProfileFieldName = "usual_sizes.top" | "usual_sizes.bottom" | "usual_sizes.shoes" | "scene" | "budget_max_fen";
export interface EffectiveProfileSnapshot {
  base_profile: { usual_sizes: UsualSizes };
  conditions: { scene?: string; budget_max_fen?: number };
  field_sources: Partial<Record<ProfileFieldName, ProfileFieldSource>>;
}
export interface ProfileSnapshot extends ProfileBinding, EffectiveProfileSnapshot {
  profile_contract: typeof PROFILE_CONTRACT; bound_request_id: string;
  explicit_overrides: { usual_sizes: UsualSizes | null }; profile_status: ProfileStatus;
  state: "prepared" | "accepted" | "invalidated" | "expired";
  created_at: string; expires_at: string; effective_profile_snapshot: EffectiveProfileSnapshot | null;
}
export interface ProfileSnapshotResponse { profile_binding: ProfileBinding; snapshot: ProfileSnapshot }
export interface ProfilePreparedResponse extends ProfileSnapshotResponse { duplicate: boolean }
export interface ProfilePrepareRequest {
  operation: "chat" | "turn" | "restore"; session_id: string; request_id: string; request_body: Record<string, unknown>;
}

export class ProfileApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "ProfileApiError"; }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const budget = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= PROFILE_LIMITS.budget_fen.min && v <= PROFILE_LIMITS.budget_fen.max;
const timestamp = (v: unknown): v is string => typeof v === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const nullableTime = (v: unknown) => v === null || timestamp(v);
const profileStatus = (v: unknown): v is ProfileStatus => ["empty", "saved", "cleared", "expired"].includes(String(v));
const scope = (v: unknown): v is ProfileScope => v === "device" || v === "user";
const invalidResponse = () => new ProfileApiError(502, "INVALID_PROFILE_RESPONSE", "资料响应不完整，请重新读取；当前编辑与原请求已保留。");
const invalidInput = () => new ProfileApiError(422, "PROFILE_INVALID_REQUEST", "资料字段无效，请核对类型、范围、保存意图和请求身份。");
const opaqueValue = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !/\s/.test(v);
export function isExpectedProfileAuthorizationContext(v: unknown): v is ExpectedProfileAuthorizationContext {
  return object(v) && keys(v, ["context_contract", "context_id", "operation_token"])
    && v.context_contract === PROFILE_AUTH_CONTEXT_CONTRACT && opaqueValue(v.context_id) && opaqueValue(v.operation_token);
}
export function isProfileAuthorizationContext(v: unknown): v is ProfileAuthorizationContext {
  return object(v) && keys(v, ["context_contract", "context_id", "operation_token", "issued_at", "expires_at"])
    && isExpectedProfileAuthorizationContext({ context_contract: v.context_contract, context_id: v.context_id, operation_token: v.operation_token })
    && timestamp(v.issued_at) && timestamp(v.expires_at) && Date.parse(v.expires_at) > Date.parse(v.issued_at);
}

function sizes(v: unknown): v is UsualSizes {
  return object(v) && keys(v, ["top", "bottom", "shoes"]) && Object.entries(v).every(([slot, size]) => size === null || object(size)
    && keys(size, ["system", "value"]) && size.system === (slot === "shoes" ? "cn_shoe" : "clothing_alpha")
    && typeof size.value === "string" && (slot === "shoes" ? ["35", "36", "37", "38", "39", "40"] : ["S", "M", "L", "XL"]).includes(size.value));
}
export function isProfileFields(v: unknown): v is ProfileFields {
  if (!object(v) || !keys(v, ["height_cm", "weight_kg", "usual_sizes"])) return false;
  for (const field of ["height_cm", "weight_kg"] as const) {
    if (!(field in v) || v[field] === null) continue;
    const n = v[field], rule = PROFILE_LIMITS[field];
    if (typeof n !== "number" || !Number.isFinite(n) || n < rule.min || n > rule.max || !Number.isInteger(n * 2)) return false;
  }
  return !("usual_sizes" in v) || v.usual_sizes === null || sizes(v.usual_sizes);
}
export function isProfileBinding(v: unknown): v is ProfileBinding {
  return object(v) && keys(v, ["snapshot_id", "profile_id", "profile_version", "snapshot_digest"])
    && identifier(v.snapshot_id) && (v.profile_id === null || identifier(v.profile_id)) && integer(v.profile_version)
    && typeof v.snapshot_digest === "string" && /^[a-f0-9]{64}$/.test(v.snapshot_digest);
}
export function parseProfileBinding(v: unknown): ProfileBinding { if (!isProfileBinding(v)) throw invalidResponse(); return v; }
export function isRequestConditions(v: unknown): v is RequestConditions {
  return object(v) && keys(v, ["scene", "budget_max_fen", "request_profile_overrides"])
    && (!("scene" in v) || v.scene === null || typeof v.scene === "string" && v.scene.length >= 1 && v.scene.length <= 40)
    && (!("budget_max_fen" in v) || v.budget_max_fen === null || budget(v.budget_max_fen))
    && (!("request_profile_overrides" in v) || v.request_profile_overrides === null || isProfileFields(v.request_profile_overrides));
}
export function parseConsumerProfile(v: unknown): SavedConsumerProfile {
  if (!object(v) || !isProfileFields(v.base_profile) || !sizes(v.base_profile.usual_sizes)) throw invalidResponse();
  const base = v.base_profile, usual = base.usual_sizes;
  if (!object(v) || v.profile_contract !== PROFILE_CONTRACT || !(v.profile_id === null || identifier(v.profile_id))
    || !integer(v.profile_version) || !scope(v.scope_kind) || !profileStatus(v.status) || !isProfileFields(v.base_profile)
    || !Object.hasOwn(v.base_profile, "height_cm") || !Object.hasOwn(v.base_profile, "weight_kg") || !sizes(v.base_profile.usual_sizes)
    || !["top", "bottom", "shoes"].every(slot => Object.hasOwn(usual!, slot))
    || !(v.default_budget_fen === null || budget(v.default_budget_fen)) || !nullableTime(v.updated_at) || !nullableTime(v.expires_at)
    || typeof v.storage_notice !== "string" || !v.storage_notice
    || ("authorization_context" in v && !isProfileAuthorizationContext(v.authorization_context))) throw invalidResponse();
  return v as unknown as SavedConsumerProfile;
}
export function parseProfileMutationReceipt(v: unknown): ProfileMutationReceipt {
  if (!object(v) || v.profile_contract !== PROFILE_CONTRACT || !identifier(v.profile_action_id) || !["save", "update", "clear", "expire"].includes(String(v.operation))
    || !identifier(v.profile_id) || !scope(v.scope_kind) || !integer(v.version_before) || !integer(v.profile_version)
    || v.profile_version <= v.version_before || !["saved", "cleared", "expired"].includes(String(v.profile_status))
    || !Array.isArray(v.changed_field_names) || !v.changed_field_names.every(field => typeof field === "string") || v.status !== "succeeded"
    || !timestamp(v.created_at) || "patch" in v || "base_profile" in v || "authorization_context" in v || "expected_authorization_context" in v || "operation_token" in v) throw invalidResponse();
  return v as unknown as ProfileMutationReceipt;
}
function effective(v: unknown): v is EffectiveProfileSnapshot {
  return object(v) && keys(v, ["base_profile", "conditions", "field_sources"]) && object(v.base_profile) && keys(v.base_profile, ["usual_sizes"])
    && sizes(v.base_profile.usual_sizes) && object(v.conditions) && keys(v.conditions, ["scene", "budget_max_fen"])
    && (!("scene" in v.conditions) || typeof v.conditions.scene === "string") && (!("budget_max_fen" in v.conditions) || budget(v.conditions.budget_max_fen))
    && object(v.field_sources) && keys(v.field_sources, ["usual_sizes.top", "usual_sizes.bottom", "usual_sizes.shoes", "scene", "budget_max_fen"])
    && Object.values(v.field_sources).every(source => ["saved_profile", "current_request", "explicit_selection", "explicit_text"].includes(String(source)));
}
function parseSnapshotResponse(v: unknown): ProfileSnapshotResponse {
  if (!object(v) || !isProfileBinding(v.profile_binding) || !object(v.snapshot)) throw invalidResponse();
  const s = v.snapshot, b = v.profile_binding;
  if (s.profile_contract !== PROFILE_CONTRACT || !identifier(s.bound_request_id) || !profileStatus(s.profile_status)
    || !Object.entries(b).every(([key, value]) => s[key] === value) || !effective({ base_profile: s.base_profile, conditions: s.conditions, field_sources: s.field_sources })
    || !object(s.explicit_overrides) || !keys(s.explicit_overrides, ["usual_sizes"]) || !(s.explicit_overrides.usual_sizes === null || sizes(s.explicit_overrides.usual_sizes))
    || !["prepared", "accepted", "invalidated", "expired"].includes(String(s.state)) || !timestamp(s.created_at) || !timestamp(s.expires_at)
    || !(s.effective_profile_snapshot === null || effective(s.effective_profile_snapshot))) throw invalidResponse();
  return v as unknown as ProfileSnapshotResponse;
}
export function validateProfileMutation(body: ProfileMutation): void {
  if (!object(body) || !keys(body, ["profile_action_id", "operation", "expected_profile_version", "patch", "explicit_save", "explicit_default_budget", "expected_authorization_context"])
    || !identifier(body.profile_action_id) || !integer(body.expected_profile_version) || !["save", "update", "clear"].includes(body.operation)
    || !object(body.patch) || !keys(body.patch, ["base_profile", "default_budget_fen"])
    || ("base_profile" in body.patch && body.patch.base_profile !== null && !isProfileFields(body.patch.base_profile))
    || ("default_budget_fen" in body.patch && body.patch.default_budget_fen !== null && !budget(body.patch.default_budget_fen))
    || (body.explicit_save !== undefined && typeof body.explicit_save !== "boolean")
    || (body.explicit_default_budget !== undefined && typeof body.explicit_default_budget !== "boolean")
    || ("expected_authorization_context" in body && !isExpectedProfileAuthorizationContext(body.expected_authorization_context))) throw invalidInput();
  if (body.operation === "clear") { if (Object.keys(body.patch).length) throw invalidInput(); return; }
  const base = body.patch.base_profile;
  const nonempty = Object.keys(body.patch).length && !(Object.keys(body.patch).length === 1 && object(base)
    && (!Object.keys(base).length || Object.keys(base).length === 1 && object(base.usual_sizes) && !Object.keys(base.usual_sizes).length));
  if (!body.explicit_save || !nonempty || "default_budget_fen" in body.patch && body.explicit_default_budget !== true) throw invalidInput();
}

export function profileErrorMessage(code: string, status = 0): string {
  const messages: Record<string, string> = {
    PROFILE_SESSION_RESTART_REQUIRED: "旧演示对话没有资料归属，请明确开始新对话并使用我的资料。",
    PROFILE_VERSION_CONFLICT: "资料已发生变化，请重新读取并确认本次修改。",
    PROFILE_ACTION_CONFLICT: "该操作编号已用于其他修改，请重新读取资料后确认。",
    PROFILE_REQUEST_CONFLICT: "原请求的内容或资料绑定不一致，请保留原请求并查询状态。",
    PROFILE_CLEARED: "原资料准备已因清除失效，请重新确认本次条件后开始新请求。",
    PROFILE_SNAPSHOT_INVALIDATED: "原资料准备已失效，请重新确认本次条件。",
    PROFILE_SNAPSHOT_EXPIRED: "原资料准备已过期，请重新确认本次条件。",
    PROFILE_INVALID_SCENE: "当前资料服务不支持该结构化场景，请保留原表达，不改成其他场景。",
    PROFILE_BINDING_REQUIRED: "本次请求缺少资料绑定，请保留原请求并重新核对。",
    PROFILE_BINDING_INVALID: "本次资料绑定无效，请保留原请求并重新核对。",
    PROFILE_SCOPE_FORBIDDEN: "当前资料空间无法读取这条记录，请重新读取当前身份的资料。",
    PROFILE_OWNER_INVALID: "当前资料身份不可用，请重新初始化资料。",
    PROFILE_AUTH_CONTEXT_INVALID: "原保存授权无法核对，编辑与原操作已保留。请重新读取当前资料范围并明确确认。",
    PROFILE_AUTH_CONTEXT_CHANGED: "当前资料授权范围已变化，旧修改不会重发。编辑与原操作已保留，请重新确认保存范围。",
    PROFILE_AUTH_CONTEXT_EXPIRED: "原保存授权已到期。编辑与原操作已保留，可先查询原操作；未完成时须重新确认保存。",
    PROFILE_AUTH_CONTEXT_INVALIDATED: "原保存授权已因清除或身份变化失效。编辑与原操作已保留，请重新确认当前资料。",
    PROFILE_STORAGE_UNAVAILABLE: "资料存储暂不可用，编辑与原操作编号已保留，请稍后重试。",
    PROFILE_PREPARE_UNAVAILABLE: "本次资料暂时无法准备，请保留原请求后重试。",
    REQUEST_IN_PROGRESS: "原请求仍在执行，请继续查询原请求。",
  };
  if (messages[code]) return messages[code];
  if (status === 422) return "请求字段无效，请核对类型、范围与明确保存意图。";
  if (status === 429) return "请求暂未受理，请保留原编号、原体与资料绑定，稍后明确重试。";
  if (status === 404) return "当前身份下没有可读取的记录。";
  return "资料请求未完成，当前编辑与原操作编号已保留，请重试或重新读取。";
}
async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(appPath(`/api/v1/${path}`), {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  let data: unknown;
  try { data = await response.json(); } catch { throw new ProfileApiError(response.ok ? 502 : response.status, "INVALID_PROFILE_RESPONSE", profileErrorMessage("INVALID_PROFILE_RESPONSE", response.status)); }
  if (!response.ok) {
    const code = object(data) && object(data.error) && typeof data.error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.error.code) ? data.error.code : "PROFILE_REQUEST_FAILED";
    throw new ProfileApiError(response.status, code, profileErrorMessage(code, response.status));
  }
  return data;
}

let initialized = false;
let initializing: Promise<SavedConsumerProfile> | null = null;
let identityEpoch = 0;
export function resetConsumerProfileInitialization(): void { identityEpoch++; initialized = false; initializing = null; }
export async function fetchConsumerProfile(): Promise<SavedConsumerProfile> {
  const epoch = identityEpoch;
  const profile = parseConsumerProfile(await request("consumer-profile"));
  if (epoch === identityEpoch) initialized = true;
  return profile;
}
/** Deduplicate only in-flight initialization. Current profile data is always read from the server. */
export function initializeConsumerProfile(): Promise<SavedConsumerProfile> {
  if (initializing) return initializing;
  const pending = fetchConsumerProfile().finally(() => { if (initializing === pending) initializing = null; });
  initializing = pending;
  return pending;
}
async function ensureInitialized(): Promise<void> { if (!initialized) await initializeConsumerProfile(); }
export async function mutateConsumerProfile(body: ProfileMutation): Promise<ProfileMutationReceipt> {
  validateProfileMutation(body); await ensureInitialized();
  const receipt = parseProfileMutationReceipt(await request("consumer-profile/mutations", body));
  if (receipt.profile_action_id !== body.profile_action_id || receipt.operation !== body.operation) throw invalidResponse();
  return receipt;
}
export async function fetchProfileOperation(actionId: string): Promise<ProfileMutationReceipt | null> {
  if (!identifier(actionId)) throw invalidInput(); await ensureInitialized();
  try {
    const receipt = parseProfileMutationReceipt(await request(`consumer-profile/operations/${encodeURIComponent(actionId)}`));
    if (receipt.profile_action_id !== actionId) throw invalidResponse(); return receipt;
  } catch (error) { if (error instanceof ProfileApiError && error.status === 404 && error.code === "PROFILE_OPERATION_NOT_FOUND") return null; throw error; }
}
export async function prepareConsumerProfile(body: ProfilePrepareRequest): Promise<ProfilePreparedResponse> {
  if (!object(body) || !keys(body, ["operation", "session_id", "request_id", "request_body"]) || !["chat", "turn", "restore"].includes(body.operation)
    || !identifier(body.session_id) || !identifier(body.request_id) || !object(body.request_body) || "profile_binding" in body.request_body
    || ("request_conditions" in body.request_body && !isRequestConditions(body.request_body.request_conditions))) throw invalidInput();
  const id = body.operation === "restore" ? body.request_body.action_id : body.request_body.request_id;
  if (id !== body.request_id || body.operation === "chat" && body.request_body.session_id !== body.session_id) throw invalidInput();
  await ensureInitialized();
  const raw = await request("consumer-profile/prepare", body), result = parseSnapshotResponse(raw);
  if (!object(raw) || typeof raw.duplicate !== "boolean" || result.snapshot.bound_request_id !== body.request_id) throw invalidResponse();
  return { ...result, duplicate: raw.duplicate };
}
export async function fetchProfileSnapshot(snapshotId: string): Promise<ProfileSnapshotResponse> {
  if (!identifier(snapshotId)) throw invalidInput(); await ensureInitialized();
  const result = parseSnapshotResponse(await request(`consumer-profile/snapshots/${encodeURIComponent(snapshotId)}`));
  if (result.profile_binding.snapshot_id !== snapshotId) throw invalidResponse(); return result;
}
export async function createPrivateOutfitSession(): Promise<FixedSession> {
  await ensureInitialized();
  const { parseFixedSession } = await import("./fixed-outfits");
  return parseFixedSession(await request("outfits/sessions", { profile_contract: PROFILE_CONTRACT }));
}
