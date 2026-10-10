import { appPath } from "./app-path";

export type DemandAttributes = {
  season?: string | null;
  scene?: string | null;
  category?: string | null;
  fit?: string | null;
  silhouette?: string | null;
};
export type FieldSources = Partial<Record<keyof DemandAttributes, string[]>>;

export interface Occurrence {
  id: string;
  turn_id: string;
  group_key: string;
  title: string;
  description: string;
  attributes: DemandAttributes;
  review_state: "pending" | "approved" | "rejected";
  reason: string;
  revision: number;
  lifecycle: "active" | "excluded" | "retracted" | "replaced";
  normalizer_version: string;
  context_turn_ids: string[];
  field_sources: FieldSources;
}

export interface Evidence extends Occurrence {
  session_id: string;
  text: string;
  created_at: string;
  extractor: string;
  data_origin: string;
}

export interface Turn {
  id: string;
  session_id: string;
  text: string;
  status: "extracted" | "no_explicit_demand" | "negative_preference" | "needs_review" | "extraction_failed" | "extracting";
  extractor: string;
  data_origin: string;
  created_at: string;
  error_code: string;
  extraction_attempts: number;
  negative_preferences: { text: string; attributes: DemandAttributes }[];
  occurrences: Occurrence[];
}

export interface TurnDetail extends Turn {
  occurrences: Occurrence[];
  context_turns: Omit<Turn, "occurrences">[];
  revision_history: {
    occurrence_id: string;
    revision: number;
    action: string;
    actor: string;
    created_at: string;
    snapshot: Record<string, unknown>;
  }[];
}

/** Directly referenced user turn and every demand occurrence of that turn. */
export interface SourceSnapshot {
  turn: Omit<Turn, "occurrences">;
  occurrences: Occurrence[];
}

export interface HandoffMetadata {
  // Historical approvals have an empty metadata object.
  window_start?: string | null;
  window_end?: string | null;
  approved_by?: string;
  approved_at?: string;
  evidence_revisions?: Record<string, number>;
  evidence_digest?: string;
  evidence_digest_version?: string;
  source_snapshot?: SourceSnapshot[];
  payload_digest?: string;
  provenance?: Record<string, {
    normalizer_version: string;
    context_turn_ids: string[];
    field_sources: FieldSources;
  }>;
}

export interface Handoff {
  id: string;
  group_key: string | null;
  title: string | null;
  version: number;
  status: "approved" | "sending" | "failed" | "received";
  created_at: string;
  last_error: string;
  occurrences: number;
  needs_review: boolean;
  review_reasons: string[];
  send_eligible: boolean;
  send_in_progress: boolean;
  retry_after_seconds: number;
  received_at: string | null;
  metadata: HandoffMetadata;
  approval_identity_kind?: "account_bound" | "legacy_shared_role";
  source_approval_ref?: { approval_record_id: string } | null;
}

export interface HandoffPayload {
  schema_version: string;
  handoff_id: string;
  revision: number;
  source_agent: string;
  target_agent: string;
  data_origin: string;
  approved_at: string;
  review_note: string;
  demand: {
    group_key: string;
    title: string;
    description: string;
    attributes: DemandAttributes;
    occurrences: number;
    session_count: number;
    window_days: number;
    material: string | null;
    craft: string | null;
    knowledge_status: string;
  };
  evidence: {
    occurrence_id: string;
    turn_id: string;
    session_ref: string;
    text: string;
    created_at: string;
    extractor: string;
    data_origin: string;
  }[];
}

export interface SendAttempt {
  id: string;
  handoff_id: string;
  status: "sending" | "failed" | "received" | "unconfirmed";
  attempted_at: string;
  finished_at: string | null;
  error_code: string;
  receipt: {
    handoff_id?: string;
    status?: string;
    revision?: number;
    payload_digest?: string;
  };
}

export interface Audit {
  id: string;
  action: string;
  target_id: string;
  actor: string;
  note: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  created_at: string;
}

export interface HandoffDetail extends Handoff {
  payload: HandoffPayload;
  send_attempts: SendAttempt[];
  audit: Audit[];
}

export interface Group {
  key: string;
  title: string;
  description: string;
  attributes: DemandAttributes;
  count: number;
  session_count: number;
  pending: number;
  last_seen: string;
  data_origins: string[];
  handoff: Handoff | null;
}

export interface GroupDetail {
  window_start: string | null;
  window_end: string;
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
  pagination_mode: "paged" | "legacy_full";
  evidence: Evidence[];
  handoffs: Handoff[];
}

export interface ApprovalSet {
  group_key: string;
  days: 0 | 7;
  window_start: string | null;
  window_end: string;
  active_count: number;
  expected_occurrence_ids: string[];
  expected_revisions: Record<string, number>;
  evidence_digest: string;
  evidence_digest_version?: string;
  source_snapshot?: SourceSnapshot[];
  approval_eligibility: ApprovalEligibility;
}

export interface BlockedSource {
  turn_id: string;
  occurrence_id: string;
  revision: number;
  review_state: Occurrence["review_state"];
  lifecycle: Occurrence["lifecycle"];
}

export interface ApprovalEligibility {
  policy: "pause-inactive-sources-v1";
  eligible: boolean;
  reason_codes: "source_inactive"[];
  blocked_sources: BlockedSource[];
  message: string;
}

export interface Overview {
  scope: string;
  days: number;
  window_start: string | null;
  window_end: string;
  updated_at: string;
  receiver_configured: boolean;
  groups: Group[];
  groups_total: number;
  page: number;
  page_size: number;
  has_more: boolean;
  // The overview omits occurrences; the paged ledger includes them.
  turns: Omit<Turn, "occurrences">[];
  images: {
    id: string;
    session_id: string;
    status: string;
    scene: string;
    product_ids: string[];
    result_url: string;
    file_exists: boolean;
    file_name: string;
    bytes: number | null;
    created_at: string;
    updated_at: string;
    error: string;
    historical_model: string | null;
    api_attempts: number | null;
    cost: number | null;
  }[];
  counts: {
    turns: number;
    occurrences: number;
    groups: number;
    pending: number;
    pending_handoffs: number;
    tasks: number;
    succeeded: number;
    failed: number;
    processing: number;
  };
  storage: { database: string; results: string; uploads: string; raw_photo_policy: string };
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  // The turns response includes scope and a window; handoffs/audit do not.
  scope?: string;
  window_start?: string | null;
  window_end?: string;
}

export class AdminError extends Error {
  readonly approval_eligibility: ApprovalEligibility | null;
  readonly retryable: boolean;

  constructor(readonly status: number, readonly code: string, message: string, eligibility?: unknown, retryable = false) {
    const parsed = parseApprovalEligibility(eligibility);
    const blocked = status === 409 && code === "SOURCE_APPROVAL_BLOCKED" && parsed?.eligible === false;
    super(code === "SOURCE_APPROVAL_BLOCKED" ?
      blocked ? eligibilityMessages.paused : status === 409 ? eligibilityMessages.unknown : statusMessages[status] ?? eligibilityMessages.unknown : message);
    this.name = "AdminError";
    this.approval_eligibility = blocked ? parsed : null;
    this.retryable = retryable === true;
  }
}

const statusCodes: Record<number, string> = {
  401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT",
  422: "INVALID_REQUEST", 429: "RATE_LIMITED", 500: "INTERNAL",
  502: "RECEIVER_UNCONFIRMED", 503: "NOT_CONFIGURED",
};
const statusMessages: Record<number, string> = {
  401: "管理员密码不正确或登录已失效，请重新登录。",
  403: "当前管理身份无权执行此操作，请核对授权范围。",
  404: "记录不存在，请刷新列表后重试。",
  409: "记录或证据状态已变化，请重新加载后核对。",
  422: "请求字段无效，请核对填写内容和筛选范围。",
  429: "登录尝试过多，请5分钟后重试。",
  500: "后台暂时无法处理请求，请稍后重试。",
  502: "接收未确认，请查看发送尝试并核对伙伴接口后重试。",
  503: "后台或接收接口尚未配置，请联系后端负责人。",
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const eligibilityMessages = {
  allowed: "当前来源未触发暂停；仍须人工核对全部证据与出处。",
  paused: "引用来源含已排除或无效记录，相关新审批已暂停；重新核对不会解除，请等待人工复核。",
  unknown: "审批资格响应缺失或异常，当前不能批准，请联系后端核对；重新核对不能解除暂停。",
};

/** Recognize the confirmed policy only; malformed or contradictory data never grants approval. */
export function parseApprovalEligibility(value: unknown): ApprovalEligibility | null {
  const eligibility = object(value);
  if (!eligibility || eligibility.policy !== "pause-inactive-sources-v1" || typeof eligibility.eligible !== "boolean" ||
      !Array.isArray(eligibility.reason_codes) || !Array.isArray(eligibility.blocked_sources) ||
      eligibility.blocked_sources.length > 10000) return null;
  const reasons = eligibility.reason_codes;
  const sources = eligibility.blocked_sources;
  const allowed = eligibility.eligible;
  if (allowed ? reasons.length !== 0 || sources.length !== 0 || eligibility.message !== eligibilityMessages.allowed :
      reasons.length !== 1 || reasons[0] !== "source_inactive" || sources.length === 0 || eligibility.message !== eligibilityMessages.paused) return null;
  const blocked: BlockedSource[] = [];
  const seen = new Set<string>();
  for (const value of sources) {
    const source = object(value);
    if (!source || typeof source.turn_id !== "string" || !/^[\w.-]{1,128}$/.test(source.turn_id) ||
        typeof source.occurrence_id !== "string" || !/^[\w.-]{1,128}$/.test(source.occurrence_id) ||
        !Number.isSafeInteger(source.revision) || (source.revision as number) < 1 ||
        !["pending", "approved", "rejected"].includes(source.review_state as string) ||
        !["active", "excluded", "retracted", "replaced"].includes(source.lifecycle as string) ||
        (source.lifecycle === "active" && source.review_state !== "rejected") || seen.has(source.occurrence_id)) return null;
    seen.add(source.occurrence_id);
    blocked.push({
      turn_id: source.turn_id, occurrence_id: source.occurrence_id, revision: source.revision as number,
      review_state: source.review_state as BlockedSource["review_state"], lifecycle: source.lifecycle as BlockedSource["lifecycle"],
    });
  }
  return {
    policy: "pause-inactive-sources-v1", eligible: allowed, reason_codes: allowed ? [] : ["source_inactive"],
    blocked_sources: blocked, message: allowed ? eligibilityMessages.allowed : eligibilityMessages.paused,
  };
}

function eligibilityFingerprint(value: ApprovalEligibility): string {
  return JSON.stringify({
    ...value,
    blocked_sources: [...value.blocked_sources].sort((a, b) => a.turn_id.localeCompare(b.turn_id) || a.occurrence_id.localeCompare(b.occurrence_id)),
  });
}

const adminContextErrors: Record<string, { status: number; message: string }> = {
  ADMIN_CONTEXT_REQUIRED: { status: 422, message: "请先读取当前管理上下文；原内容保留，不会降级提交。" },
  ADMIN_CONTEXT_INVALID: { status: 422, message: "管理上下文格式无效，请重新读取身份并核对原内容。" },
  ADMIN_ACTION_INVALID: { status: 422, message: "管理动作格式无效，请保留原内容并核对。" },
  ADMIN_AUTH_REQUIRED: { status: 401, message: "管理登录已失效，请重新登录后查询原操作。" },
  ADMIN_SESSION_EXPIRED: { status: 401, message: "管理会话已到期，请重新登录后查询原操作。" },
  ADMIN_SESSION_REVOKED: { status: 401, message: "管理会话已撤销，请重新登录后查询原操作。" },
  ADMIN_FORBIDDEN: { status: 403, message: "当前管理身份无权执行此操作，请核对授权范围。" },
  ADMIN_ORIGIN_FORBIDDEN: { status: 403, message: "当前页面来源未获授权，请联系负责人核对配置。" },
  ADMIN_AUTH_CONTEXT_CHANGED: { status: 409, message: "管理会话已变化；原内容保留，请先查询原操作并重新核对。" },
  ADMIN_ACTION_CONTEXT_CONFLICT: { status: 409, message: "原动作属于另一管理上下文，只能查询原事实，不能替换上下文重放。" },
  ADMIN_ACTION_BODY_CONFLICT: { status: 409, message: "原动作编号已绑定不同内容，请保留原动作并重新核对。" },
  ADMIN_ACTION_IN_PROGRESS: { status: 409, message: "原管理动作仍在处理中，请只查询原操作，不重复提交。" },
  ADMIN_ACTION_LEGACY_UNBOUND: { status: 409, message: "该历史动作没有新上下文绑定，只能读取原事实，不能补签或重放。" },
  ADMIN_OPERATION_NOT_FOUND: { status: 404, message: "未找到该本人管理操作；这不能证明远端未收到，也不授权补发。" },
  ADMIN_LEGACY_MUTATION_DISABLED: { status: 409, message: "当前模式已关闭旧发送入口，请使用已授权的新管理操作。" },
  ADMIN_FEATURE_DISABLED: { status: 409, message: "该管理功能当前关闭，不能通过其他入口绕过。" },
  ADMIN_AUTH_UNAVAILABLE: { status: 503, message: "管理身份权威记录暂不可用，当前不能提交，请稍后重新读取。" },
  ADMIN_OPERATION_STORAGE_UNAVAILABLE: { status: 503, message: "管理操作权威记录暂不可用，请先查询原操作，不能按本地缓存判断成功。" },
};

export function responseError(status: number, result: unknown): AdminError {
  const data = object(result);
  const error = object(data?.error);
  const candidate = error?.message ?? data?.detail;
  const code = typeof error?.code === "string" && /^[A-Z_]{1,64}$/.test(error.code)
    ? error.code : statusCodes[status] ?? "REQUEST_FAILED";
  const fallback = statusMessages[status] ?? "操作未完成，请刷新后重试。";
  const contextError = adminContextErrors[code];
  if (contextError) {
    const retryable = contextError.status === status && status === 503 && error?.retryable === true;
    return new AdminError(status, code, contextError.status === status ? contextError.message : fallback, undefined, retryable);
  }
  if (code === "SOURCE_APPROVAL_BLOCKED") {
    const eligibility = parseApprovalEligibility(data?.approval_eligibility);
    // A domain pause is valid only with a verified blocked result on HTTP409.
    if (status === 409 && eligibility?.eligible === false) return new AdminError(status, code, eligibilityMessages.paused, eligibility);
    return new AdminError(status, code, status === 409 ? eligibilityMessages.unknown : fallback);
  }
  // Authentication/configuration/internal errors use fixed wording. For business
  // failures, show the safe contract message, never HTML, stack traces or secrets.
  const safeMessage = typeof candidate === "string" && candidate.length <= 300 &&
    !/[<>\r\n]|(?:https?:\/\/)|(?:\/(?:Users|home|private|tmp)\/)|(?:traceback|stack|password|secret|token|authorization|api[_ -]?key|cookie)/i.test(candidate);
  return new AdminError(status, code, ![401, 500, 503].includes(status) && safeMessage ? candidate : fallback);
}

function isAbort(error: unknown): boolean {
  // DOMException can originate in another browser realm and need not inherit
  // this module's Error constructor.
  return object(error)?.name === "AbortError";
}

async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const route = path.replace(/^\/+/, "");
  if (!route || route.includes("#") || route.split("?")[0].split("/").includes("..")) {
    throw new AdminError(0, "INVALID_REQUEST", "管理接口路径无效。");
  }
  let encoded: string | undefined;
  if (body !== undefined) {
    try { encoded = JSON.stringify(body); }
    catch { throw new AdminError(0, "INVALID_REQUEST", "请求内容无效，请核对填写内容。"); }
  }
  try {
    return await fetch(appPath(`/api/v1/admin/${route}`), {
      cache: "no-store",
      credentials: "same-origin",
      signal,
      ...(body === undefined ? {} : {
        method: "POST", headers: { "content-type": "application/json" }, body: encoded,
      }),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new AdminError(0, "NETWORK_ERROR", "无法连接本地后端，请检查服务后重试；写操作请先刷新记录核对结果。");
  }
}

export async function adminApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await request(path, body, signal);
  let result: unknown;
  try { result = await response.json(); }
  catch (error) {
    if (isAbort(error)) throw error;
    if (!response.ok) throw responseError(response.status, null);
    throw new AdminError(response.status, "INVALID_RESPONSE", "后端响应格式异常，请刷新重试；写操作请先核对记录状态。");
  }
  if (!response.ok) throw responseError(response.status, result);
  if (!object(result)) throw new AdminError(response.status, "INVALID_RESPONSE", "后端响应格式异常，请刷新重试；写操作请先核对记录状态。");
  return result as T;
}

export async function adminExport(id: string, signal?: AbortSignal): Promise<{ blob: Blob; fileName: string }> {
  const response = await request(`handoffs/${encodeURIComponent(id)}/export`, undefined, signal);
  if (!response.ok) {
    let result: unknown = null;
    try { result = await response.json(); } catch (error) { if (isAbort(error)) throw error; }
    throw responseError(response.status, result);
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new AdminError(response.status, "INVALID_RESPONSE", "交接包响应格式异常，未下载文件，请刷新后重试。");
  }
  let blob: Blob;
  try { blob = await response.blob(); }
  catch (error) {
    if (isAbort(error)) throw error;
    throw new AdminError(response.status, "DOWNLOAD_FAILED", "交接包下载未完成，请重试并核对导出记录。");
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const fileName = filename && /^[\w.-]+\.json$/i.test(filename)
    ? filename : `${id.replace(/[^\w.-]/g, "") || "handoff"}.json`;
  return { blob, fileName };
}

export function adminQuery(values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function formatAdminTime(value: string | null | undefined): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间格式异常";
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

export function activeEvidence(detail: GroupDetail | Evidence[]): Evidence[] {
  const evidence = Array.isArray(detail) ? detail : detail.evidence;
  return evidence.filter(item => item.lifecycle === "active" && item.review_state !== "rejected");
}

/** Local read witness only; the backend must still bind sources in its write transaction. */
export function sourceTurnFingerprint(turn: TurnDetail): string {
  return JSON.stringify({
    id: turn.id,
    text: turn.text,
    occurrences: [...turn.occurrences].sort((a, b) => a.id.localeCompare(b.id)).map(item => ({
      id: item.id,
      revision: item.revision,
      lifecycle: item.lifecycle,
      rejected: item.review_state === "rejected",
      attributes: Object.entries(item.attributes).sort(([a], [b]) => a.localeCompare(b)),
      field_sources: Object.entries(item.field_sources).sort(([a], [b]) => a.localeCompare(b))
        .map(([field, ids]) => [field, [...(ids ?? [])].sort()]),
    })),
  });
}

export function sourceReviewWitness(e: Evidence, turns: Record<string, TurnDetail>): Record<string, string> | null {
  if (!Array.isArray(e.context_turn_ids) || !object(e.field_sources)) return null;
  const fieldRefs = Object.values(e.field_sources);
  if (fieldRefs.some(ids => !Array.isArray(ids))) return null;
  const refs = [...e.context_turn_ids, ...fieldRefs.flat()];
  if (refs.some(id => typeof id !== "string" || !id.trim())) return null;
  const external = [...new Set(refs)].filter(id => id !== e.turn_id).sort() as string[];
  const witness: Record<string, string> = {};
  for (const id of external) {
    if (!Object.hasOwn(turns, id)) return null;
    const turn = turns[id];
    if (!turn || turn.id !== id || turn.session_id !== e.session_id ||
        typeof turn.text !== "string" || !turn.text.trim() || !Array.isArray(turn.occurrences)) return null;
    witness[id] = sourceTurnFingerprint(turn);
  }
  return witness;
}

export interface ApprovalBody {
  note: string;
  days: 0 | 7;
  expected_occurrence_ids: string[];
  expected_revisions: Record<string, number>;
  expected_evidence_digest: string;
  window_start?: string;
  window_end: string;
}

function utcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return false;
  const date = new Date(value);
  // Date parsing alone can normalize invalid calendar dates; reject them.
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

function preciseUtc(value: string): string {
  const time = value.replace(/(?:Z|\+00:00)$/, "");
  const [seconds, fraction = ""] = time.split(".");
  return `${seconds}.${fraction.padEnd(6, "0")}`;
}

function validApprovalSet(value: unknown): value is ApprovalSet {
  const set = object(value);
  if (!set || typeof set.group_key !== "string" || !set.group_key.trim() || set.group_key !== set.group_key.trim() ||
      ![0, 7].includes(set.days as number) || !utcTimestamp(set.window_end) ||
      !Number.isSafeInteger(set.active_count) || (set.active_count as number) < 0 ||
      !Array.isArray(set.expected_occurrence_ids) || set.expected_occurrence_ids.length > 10000 ||
      set.active_count !== set.expected_occurrence_ids.length ||
      typeof set.evidence_digest !== "string" || !/^[0-9a-f]{64}$/.test(set.evidence_digest) ||
      !parseApprovalEligibility(set.approval_eligibility)) return false;
  if (set.days === 0 ? set.window_start !== null :
      !utcTimestamp(set.window_start) || preciseUtc(set.window_start) >= preciseUtc(set.window_end)) return false;
  const revisions = object(set.expected_revisions);
  const ids = set.expected_occurrence_ids;
  if (!revisions || Object.keys(revisions).length !== ids.length ||
      ids.some(id => typeof id !== "string" || !id.trim() || id !== id.trim()) || new Set(ids).size !== ids.length) return false;
  return ids.every(id => Object.hasOwn(revisions, id) && Number.isSafeInteger(revisions[id]) && (revisions[id] as number) >= 1);
}

/** Compare complete server baselines, never substitute a later baseline for a checked one. */
export function approvalSetsEqual(a: unknown, b: unknown): boolean {
  if (!validApprovalSet(a) || !validApprovalSet(b)) return false;
  return a.group_key === b.group_key && a.days === b.days &&
    a.window_start === b.window_start && a.window_end === b.window_end &&
    a.active_count === b.active_count && a.evidence_digest === b.evidence_digest &&
    eligibilityFingerprint(parseApprovalEligibility(a.approval_eligibility)!) === eligibilityFingerprint(parseApprovalEligibility(b.approval_eligibility)!) &&
    a.expected_occurrence_ids.every(id => Object.hasOwn(b.expected_revisions, id) && a.expected_revisions[id] === b.expected_revisions[id]);
}

/** Only explicit human checks of every baseline ID at its exact revision count. */
export function checkedCoverage(set: ApprovalSet, checked: Readonly<Record<string, number>>): boolean {
  if (!validApprovalSet(set) || !set.approval_eligibility.eligible || set.active_count === 0 || !object(checked) ||
      Object.keys(checked).length !== set.active_count) return false;
  return set.expected_occurrence_ids.every(id => Object.hasOwn(checked, id) && checked[id] === set.expected_revisions[id]);
}

/** Preserve the server's UTC precision; cumulative queries freeze their cutoff too. */
export function windowQuery(window: { window_start: string | null; window_end: string }): { window_start?: string; window_end: string } {
  return { ...(window.window_start === null ? {} : { window_start: window.window_start }), window_end: window.window_end };
}

export function approvalBody(set: ApprovalSet, note: string): ApprovalBody {
  if (!validApprovalSet(set) || set.active_count === 0) {
    throw new AdminError(0, "INVALID_REQUEST", "完整批准集合无效或没有有效证据，请重新开始核对。");
  }
  if (!set.approval_eligibility.eligible) {
    throw new AdminError(409, "SOURCE_APPROVAL_BLOCKED", eligibilityMessages.paused, set.approval_eligibility);
  }
  return {
    note,
    days: set.days,
    expected_occurrence_ids: [...set.expected_occurrence_ids],
    expected_revisions: { ...set.expected_revisions },
    expected_evidence_digest: set.evidence_digest,
    ...windowQuery(set),
  };
}
