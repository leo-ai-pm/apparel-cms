import { appPath } from "@/app/lib/app-path";
import { AdminError, responseError } from "@/app/lib/admin-api";

export const ADMIN_ACTION_CONTRACT = "styling_admin_action_v1" as const;
export const ADMIN_CONTEXT_CONTRACT = "styling_admin_context_v1" as const;
export type AdminIdentity = {
  identity_contract: "styling_admin_identity_v1";
  subject: string; role: "styling-manager"; audience: "personal_styling";
  scope: string; source_instance_id: string; auth_method: "password_single_account" | "demo_server";
  approval_identity_kind: "account_bound"; expires_at: string;
  authorization_context: { context_contract: typeof ADMIN_CONTEXT_CONTRACT; context_id: string; expires_at: string };
};
export type AdminOperationKind = "approve" | "reject" | "retry" | "evidence_export" | "direct_send" | "direct_reconcile" | "direct_supplement" | "logout";
export type AdminOperation = {
  operation_contract: typeof ADMIN_ACTION_CONTRACT; request_id: string; actor_subject: string;
  operation_kind: AdminOperationKind; context_binding: "bound" | "legacy_unbound";
  operation_context_ref: string | null; body_digest: string | null;
  state: "pending" | "completed" | "failed" | "unconfirmed";
  outcome: "created" | "reused_frozen" | "received" | "unconfirmed" | "queued" | "completed" | "failed" | null;
  accepted_at: string | null; completed_at: string | null;
  result_ref: { kind: "handoff" | "frozen_evidence" | "direct_delivery" | "demand_occurrence" | "demand_turn"; id: string; revision: number | null } | null;
};
export type AdminAction = Readonly<{
  action_contract: "styling_admin_pending_v1"; identity: AdminIdentity; path: string;
  kind: AdminOperationKind; operation_kind: AdminOperationKind; request_id: string;
  body: Readonly<Record<string, unknown>>; body_json: string;
}>;

const subjectPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const contextPattern = /^[A-Za-z0-9_-]{43}$/;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => own(value, key));
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function id(value: unknown): value is string { return typeof value === "string" && idPattern.test(value); }
function invalid(status = 200): AdminError {
  return new AdminError(status, "INVALID_ADMIN_RESPONSE", "管理响应无法验证，当前不能提交或按此判断成功，请重新读取核对。");
}
const abort = (error: unknown) => error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";

/** Reject duplicate object keys, including escaped aliases, before JSON.parse can discard them. */
export function parseAdminJson(raw: string): unknown {
  if (typeof raw !== "string" || raw.length > 2_000_000) throw invalid();
  let cursor = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(raw[cursor] ?? "~")) cursor += 1; };
  function string(): string {
    const start = cursor;
    if (raw[cursor++] !== '"') throw invalid();
    while (cursor < raw.length) {
      const char = raw[cursor++];
      if (char === '"') return JSON.parse(raw.slice(start, cursor)) as string;
      if (char === "\\") cursor += 1;
      else if (char.charCodeAt(0) < 32) throw invalid();
    }
    throw invalid();
  }
  function value(depth: number): unknown {
    if (depth > 64) throw invalid();
    whitespace();
    if (raw[cursor] === '"') return string();
    if (raw[cursor] === "{") {
      cursor += 1; whitespace();
      const result: Record<string, unknown> = Object.create(null);
      if (raw[cursor] === "}") { cursor += 1; return result; }
      while (true) {
        whitespace(); const key = string(); whitespace();
        if (own(result, key) || raw[cursor++] !== ":") throw invalid();
        result[key] = value(depth + 1); whitespace();
        if (raw[cursor] === "}") { cursor += 1; return result; }
        if (raw[cursor++] !== ",") throw invalid();
      }
    }
    if (raw[cursor] === "[") {
      cursor += 1; whitespace(); const result: unknown[] = [];
      if (raw[cursor] === "]") { cursor += 1; return result; }
      while (true) {
        result.push(value(depth + 1)); whitespace();
        if (raw[cursor] === "]") { cursor += 1; return result; }
        if (raw[cursor++] !== ",") throw invalid();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(cursor));
    if (!match) throw invalid();
    cursor += match[0].length;
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) throw invalid();
    return parsed;
  }
  try {
    const result = value(0); whitespace();
    if (cursor !== raw.length) throw invalid();
    return result;
  } catch { throw invalid(); }
}

/** Strict UTC RFC3339 with real calendar validation and the backend's six-digit precision. */
function utc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) return false;
  const parts = match.slice(1, 7).map(Number);
  const [year, month, day, hours, minutes, seconds] = parts;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) return false;
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hours, minutes, seconds, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function orderedTime(value: string): string {
  const [base, fraction = ""] = value.slice(0, -1).split(".");
  return `${base}.${fraction.padEnd(6, "0")}Z`;
}
export function parseAdminIdentity(value: unknown): AdminIdentity | null {
  if (!object(value) || !exact(value, ["identity_contract", "subject", "role", "audience", "scope", "source_instance_id", "auth_method", "approval_identity_kind", "expires_at", "authorization_context"])) return null;
  const context = value.authorization_context;
  if (value.identity_contract !== "styling_admin_identity_v1" || value.role !== "styling-manager" || value.audience !== "personal_styling" ||
    !["password_single_account", "demo_server"].includes(value.auth_method as string) || value.approval_identity_kind !== "account_bound" ||
    ![value.subject, value.scope, value.source_instance_id].every(item => typeof item === "string" && subjectPattern.test(item)) ||
    !utc(value.expires_at) || !object(context) || !exact(context, ["context_contract", "context_id", "expires_at"]) ||
    context.context_contract !== ADMIN_CONTEXT_CONTRACT || typeof context.context_id !== "string" || !contextPattern.test(context.context_id) ||
    context.expires_at !== value.expires_at) return null;
  return value as unknown as AdminIdentity;
}
function liveIdentity(identity: AdminIdentity): void {
  if (!parseAdminIdentity(identity)) throw invalid(0);
  const remaining = Date.parse(identity.expires_at) - Date.now();
  if (remaining <= 0) throw responseError(401, { error: { code: "ADMIN_SESSION_EXPIRED" } });
  if (remaining > 8 * 60 * 60 * 1000) throw invalid();
}
export function adminIdentityNamespace(identity: AdminIdentity): string {
  if (!parseAdminIdentity(identity)) throw invalid(0);
  return JSON.stringify([identity.source_instance_id, identity.scope, identity.subject, identity.authorization_context.context_id]);
}
export const adminContextNamespace = adminIdentityNamespace;
export function sameAdminIdentity(a: AdminIdentity | null | undefined, b: AdminIdentity | null | undefined): boolean {
  return !!a && !!b && !!parseAdminIdentity(a) && !!parseAdminIdentity(b) && a.auth_method === b.auth_method && adminIdentityNamespace(a) === adminIdentityNamespace(b) && a.expires_at === b.expires_at;
}

const resultKinds: Record<AdminOperationKind, NonNullable<AdminOperation["result_ref"]>["kind"] | null> = {
  approve: "handoff", reject: "demand_occurrence", retry: "demand_turn", evidence_export: "frozen_evidence",
  direct_send: "direct_delivery", direct_reconcile: "direct_delivery", direct_supplement: "direct_delivery", logout: null,
};
export function parseAdminOperation(value: unknown, requestId?: string, identity?: AdminIdentity): AdminOperation | null {
  if (!object(value) || !exact(value, ["operation_contract", "request_id", "actor_subject", "operation_kind", "context_binding", "operation_context_ref", "body_digest", "state", "outcome", "accepted_at", "completed_at", "result_ref"]) ||
    value.operation_contract !== ADMIN_ACTION_CONTRACT || !id(value.request_id) || (requestId !== undefined && value.request_id !== requestId) ||
    typeof value.actor_subject !== "string" || !subjectPattern.test(value.actor_subject) ||
    (identity !== undefined && (!parseAdminIdentity(identity) || value.actor_subject !== identity.subject)) ||
    typeof value.operation_kind !== "string" || !own(resultKinds, value.operation_kind) ||
    typeof value.context_binding !== "string" || !["bound", "legacy_unbound"].includes(value.context_binding) ||
    typeof value.state !== "string" || !["pending", "completed", "failed", "unconfirmed"].includes(value.state)) return null;
  const kind = value.operation_kind as AdminOperationKind;
  if (value.context_binding === "bound" ?
    !uuidPattern.test(value.request_id) || typeof value.operation_context_ref !== "string" || !shaPattern.test(value.operation_context_ref) ||
      typeof value.body_digest !== "string" || !shaPattern.test(value.body_digest) || !utc(value.accepted_at) ||
      (["completed", "failed"].includes(value.state) && !utc(value.completed_at)) :
    value.operation_context_ref !== null || value.body_digest !== null) return null;
  if ((value.accepted_at !== null && !utc(value.accepted_at)) || (value.completed_at !== null && !utc(value.completed_at)) ||
    (typeof value.accepted_at === "string" && typeof value.completed_at === "string" && orderedTime(value.completed_at) < orderedTime(value.accepted_at))) return null;
  if (value.state === "pending" ? value.outcome !== null || value.completed_at !== null :
    value.state === "failed" ? value.outcome !== "failed" : value.state === "unconfirmed" ? value.outcome !== "unconfirmed" :
      typeof value.outcome !== "string" || !["created", "reused_frozen", "received", "queued", "completed"].includes(value.outcome)) return null;
  const result = value.result_ref;
  if (kind === "logout" && result !== null) return null;
  if (result !== null && (!object(result) || !exact(result, ["kind", "id", "revision"]) ||
    typeof result.kind !== "string" || !["handoff", "frozen_evidence", "direct_delivery", "demand_occurrence", "demand_turn"].includes(result.kind) || !id(result.id) ||
    (result.revision !== null && !positive(result.revision)))) return null;
  return value as unknown as AdminOperation;
}

function actionPath(path: string): { path: string; kind: AdminOperationKind; objectId: string | null } | null {
  if (typeof path !== "string") return null;
  const route = path.replace(/^\/+/, "");
  if (route === "logout") return { path: route, kind: "logout", objectId: null };
  const match = /^(groups|occurrences|turns|handoffs)\/([^/?#]+)\/(approve|reject|retry|evidence-export|direct-send|direct-reconcile|direct-supplement)$/.exec(route);
  if (!match) return null;
  let objectId: string;
  try { objectId = decodeURIComponent(match[2]); } catch { return null; }
  if (!id(objectId) || objectId === "." || objectId === ".." || encodeURIComponent(objectId) !== match[2]) return null;
  const routes: Record<string, AdminOperationKind> = { "groups/approve": "approve", "occurrences/reject": "reject", "turns/retry": "retry", "handoffs/evidence-export": "evidence_export", "handoffs/direct-send": "direct_send", "handoffs/direct-reconcile": "direct_reconcile", "handoffs/direct-supplement": "direct_supplement" };
  const kind = routes[`${match[1]}/${match[3]}`];
  return kind ? { path: route, kind, objectId } : null;
}
function reviewTime(value: unknown): value is string {
  return typeof value === "string" && utc(value.replace(/\+00:00$/, "Z"));
}
function normalizeReviewTime(value: string): string {
  const [base, fraction = ""] = value.replace(/\+00:00$/, "Z").slice(0, -1).split(".");
  return /^0*$/.test(fraction) ? `${base}Z` : `${base}.${fraction.padEnd(6, "0")}Z`;
}
function reviewBody(value: Record<string, unknown>, approval: boolean): boolean {
  const fields = ["note", "days", "expected_occurrence_ids", "expected_revisions", "expected_evidence_digest", "expected_revision", "window_start", "window_end"];
  if (Object.keys(value).some(key => !fields.includes(key)) || typeof value.note !== "string" || Array.from(value.note.trim()).length < 2 || Array.from(value.note).length > 500 ||
    (own(value, "days") && value.days !== 0 && value.days !== 7) || (own(value, "expected_revision") && value.expected_revision !== null && !positive(value.expected_revision)) ||
    (own(value, "expected_evidence_digest") && value.expected_evidence_digest !== null && (typeof value.expected_evidence_digest !== "string" || !shaPattern.test(value.expected_evidence_digest))) ||
    ["window_start", "window_end"].some(key => own(value, key) && value[key] !== null && !reviewTime(value[key]))) return false;
  const ids = value.expected_occurrence_ids;
  if (own(value, "expected_occurrence_ids") && (!Array.isArray(ids) || ids.length > 10000 || !ids.every(id) || new Set(ids).size !== ids.length)) return false;
  const revisions = value.expected_revisions;
  if (own(value, "expected_revisions") && revisions !== null && (!object(revisions) || !Object.entries(revisions).every(([key, revision]) => id(key) && positive(revision)))) return false;
  if (!approval) return true;
  return (value.days === 0 || value.days === 7) && Array.isArray(ids) && ids.length > 0 && object(revisions) &&
    Object.keys(revisions).length === ids.length && ids.every(item => own(revisions, item)) && typeof value.expected_evidence_digest === "string" && shaPattern.test(value.expected_evidence_digest) &&
    reviewTime(value.window_end) && (value.days === 0 ? !own(value, "window_start") || value.window_start === null :
      reviewTime(value.window_start) && orderedTime(normalizeReviewTime(value.window_start)) < orderedTime(normalizeReviewTime(value.window_end)));
}
function businessBody(kind: AdminOperationKind, value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false;
  if (kind === "approve" || kind === "reject") return reviewBody(value, kind === "approve");
  if (kind === "logout" || kind === "retry") return Object.keys(value).length === 0;
  return Object.keys(value).every(key => key === "expected_revision" || (kind === "direct_send" && key === "include_supplement")) &&
    positive(value.expected_revision) && (!own(value, "include_supplement") || typeof value.include_supplement === "boolean");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function validJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => validJson(item, depth + 1));
  return object(value) && Object.keys(value).every(key => key !== "__proto__" && validJson(value[key], depth + 1));
}
export function createAdminAction(identity: AdminIdentity, path: string, business: Record<string, unknown> = {}, requestId: string = crypto.randomUUID()): AdminAction {
  liveIdentity(identity);
  const route = actionPath(path);
  if (!route || !uuidPattern.test(requestId) || !validJson(business) || !businessBody(route.kind, business)) throw new AdminError(0, "ADMIN_ACTION_INVALID", "本次管理动作或字段无效，请核对原内容。");
  const snapshot = JSON.parse(JSON.stringify(identity)) as AdminIdentity;
  const body: Record<string, unknown> = {
    ...JSON.parse(JSON.stringify(business)), admin_action_contract: ADMIN_ACTION_CONTRACT, request_id: requestId,
    expected_admin_context: { context_contract: ADMIN_CONTEXT_CONTRACT, context_id: snapshot.authorization_context.context_id },
  };
  return freeze({ action_contract: "styling_admin_pending_v1", identity: snapshot, path: route.path,
    kind: route.kind, operation_kind: route.kind, request_id: requestId, body, body_json: JSON.stringify(body) });
}
export function parseStoredAdminAction(value: unknown, identity?: AdminIdentity): AdminAction | null {
  try {
    const saved: unknown = typeof value === "string" ? parseAdminJson(value) : value;
    if (!object(saved) || !exact(saved, ["action_contract", "identity", "path", "kind", "operation_kind", "request_id", "body", "body_json"]) ||
      saved.action_contract !== "styling_admin_pending_v1" || !parseAdminIdentity(saved.identity) || !object(saved.body) || typeof saved.body_json !== "string" ||
      typeof saved.path !== "string" || typeof saved.request_id !== "string" || !uuidPattern.test(saved.request_id) || !validJson(saved)) return null;
    const owner = saved.identity as AdminIdentity;
    const route = actionPath(saved.path);
    if (!route || route.path !== saved.path || route.kind !== saved.kind || saved.kind !== saved.operation_kind || (identity && !sameAdminIdentity(owner, identity))) return null;
    const body = saved.body;
    const context = body.expected_admin_context;
    if (body.admin_action_contract !== ADMIN_ACTION_CONTRACT || body.request_id !== saved.request_id || !object(context) ||
      !exact(context, ["context_contract", "context_id"]) || context.context_contract !== ADMIN_CONTEXT_CONTRACT || context.context_id !== owner.authorization_context.context_id ||
      JSON.stringify(parseAdminJson(saved.body_json)) !== JSON.stringify(body) || saved.body_json !== JSON.stringify(body)) return null;
    const business = Object.fromEntries(Object.entries(body).filter(([key]) => !["admin_action_contract", "request_id", "expected_admin_context"].includes(key)));
    if (!businessBody(route.kind, business)) return null;
    return freeze(saved as unknown as AdminAction);
  } catch { return null; }
}
export function serializeAdminAction(action: AdminAction): string {
  if (!parseStoredAdminAction(action)) throw new AdminError(0, "ADMIN_ACTION_INVALID", "原管理动作无法验证，不能存储或重建。");
  return JSON.stringify(action);
}

/** Python sort_keys semantics, including numeric-looking keys that JSON.stringify would reorder. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Mirrors admin-json-v1's validated model defaults, not original HTTP byte hashing. */
export function canonicalAdminAction(action: AdminAction): string {
  if (!parseStoredAdminAction(action)) throw new AdminError(0, "ADMIN_ACTION_INVALID", "原管理动作无法验证，不能计算动作关联。");
  let body: Record<string, unknown> = { ...action.body };
  if (action.kind === "approve" || action.kind === "reject") {
    body = { days: 7, expected_occurrence_ids: [], expected_revisions: null, expected_evidence_digest: null,
      expected_revision: null, window_start: null, window_end: null, ...body };
    for (const key of ["window_start", "window_end"]) {
      if (typeof body[key] === "string") body[key] = normalizeReviewTime(body[key]);
    }
  } else if (action.kind === "direct_send" && !own(body, "include_supplement")) body.include_supplement = true;
  return canonicalJson({ method: "POST", path: `/api/v1/admin/${decodeURIComponent(action.path)}`, body });
}
async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function adminActionBodyDigest(action: AdminAction): Promise<string> { return sha256(canonicalAdminAction(action)); }

async function request(path: string, body?: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(appPath(`/api/v1/admin/${path}`), {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
    });
  } catch (error) {
    if (abort(error)) throw error;
    throw new AdminError(0, "NETWORK_ERROR", "管理请求未确认，请保留原动作，先查询本人操作与当前对象；不会自动补发。");
  }
}
async function readResponse(response: Response): Promise<unknown> {
  let result: unknown;
  try { result = parseAdminJson(await response.text()); }
  catch (error) {
    if (abort(error)) throw error;
    if (!response.ok) throw responseError(response.status, null);
    throw invalid(response.status);
  }
  // Authentication and authority failures take precedence over any body/header claiming success.
  if (!response.ok) throw responseError(response.status, result);
  if (response.redirected || !response.headers.get("content-type")?.toLowerCase().includes("application/json") ||
    !response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "no-store")) throw invalid(response.status);
  return result;
}
export async function getAdminIdentity(signal?: AbortSignal): Promise<AdminIdentity> {
  const response = await request("me", undefined, signal);
  const identity = parseAdminIdentity(await readResponse(response));
  if (!identity) throw invalid(response.status);
  liveIdentity(identity);
  return freeze(identity);
}
export const fetchAdminMe = getAdminIdentity;
/** Strict raw-JSON read for the new-mode boundary; private DTO validation remains at the domain caller. */
export async function readAdminContextResource(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (typeof path !== "string") throw invalid(0);
  const route = path.replace(/^\/+/, "");
  let pathname: string;
  try { pathname = decodeURIComponent(route.split("?")[0]); } catch { throw invalid(0); }
  if (!route || route.includes("#") || pathname.includes("\\") || pathname.split("/").some(part => part === "." || part === "..") || /^[a-z][a-z0-9+.-]*:/i.test(route)) throw invalid(0);
  const response = await request(route, undefined, signal);
  const value = await readResponse(response);
  if (!object(value)) throw invalid(response.status);
  return value;
}
export async function getAdminOperation(requestId: string, identity: AdminIdentity, signal?: AbortSignal): Promise<AdminOperation> {
  liveIdentity(identity);
  if (!id(requestId)) throw new AdminError(0, "ADMIN_ACTION_INVALID", "原操作编号无效，不能查询或重建。");
  const response = await request(`operations/${encodeURIComponent(requestId)}`, undefined, signal);
  const operation = parseAdminOperation(await readResponse(response), requestId, identity);
  if (!operation) throw invalid(response.status);
  return freeze(operation);
}
function assertActionResponse(action: AdminAction, value: unknown): Record<string, unknown> {
  if (!object(value)) throw invalid();
  const route = actionPath(action.path)!;
  if (action.kind === "logout" && (!exact(value, ["status"]) || value.status !== "logged_out")) throw invalid();
  if (action.kind === "reject" && (!exact(value, ["status", "revision"]) || value.status !== "rejected" || !positive(value.revision))) throw invalid();
  if (action.kind === "retry") {
    if (!exact(value, ["id", "status", "error_code", "extraction_attempts"]) || value.id !== route.objectId ||
      typeof value.status !== "string" || !["extracted", "no_explicit_demand", "negative_preference", "needs_review", "extraction_failed", "extracting"].includes(value.status) ||
      !positive(value.extraction_attempts) || (value.error_code !== null && (typeof value.error_code !== "string" || !/^[A-Z_]{0,128}$/.test(value.error_code)))) throw invalid();
    if (value.status === "extraction_failed") throw new AdminError(200, "ADMIN_EXTRACTION_FAILED", "原提炼动作已记录失败，请读取原交流与操作事实，不会自动重试。");
  }
  if (action.kind === "approve" && (!id(value.id) || !positive(value.version) || (own(value, "group_key") && value.group_key !== route.objectId))) throw invalid();
  if (action.kind === "evidence_export" && (!exact(value, ["supplement_id", "digest", "handoff_id", "revision", "metadata_digest", "rule_version", "status"]) ||
    !id(value.supplement_id) || value.handoff_id !== route.objectId || value.revision !== action.body.expected_revision ||
    typeof value.digest !== "string" || !shaPattern.test(value.digest) || typeof value.metadata_digest !== "string" || !shaPattern.test(value.metadata_digest) ||
    typeof value.rule_version !== "string" || value.rule_version.length < 1 || value.rule_version.length > 128 || value.status !== "registered")) throw invalid();
  if (action.kind.startsWith("direct_") && (value.transport !== "direct" || value.handoff_id !== route.objectId ||
    value.revision !== action.body.expected_revision || typeof value.status !== "string" || !["sending", "unconfirmed", "received"].includes(value.status))) throw invalid();
  return value;
}
export function executeAdminAction(action: AdminAction, signal?: AbortSignal): Promise<Record<string, unknown>>;
export function executeAdminAction<T>(action: AdminAction, signal: AbortSignal | undefined, validate: (value: unknown) => T): Promise<T>;
export async function executeAdminAction<T>(action: AdminAction, signal?: AbortSignal, validate?: (value: unknown) => T): Promise<T | Record<string, unknown>> {
  if (!parseStoredAdminAction(action)) throw new AdminError(0, "ADMIN_ACTION_INVALID", "原管理动作无法验证，不能替换内容或重建提交。");
  liveIdentity(action.identity);
  const response = await request(action.path, action.body_json, signal);
  const result = await readResponse(response);
  if (response.headers.get("x-styling-admin-action-contract") !== ADMIN_ACTION_CONTRACT || response.headers.get("x-styling-admin-request-id") !== action.request_id) throw invalid(response.status);
  const dto = assertActionResponse(action, result);
  return validate ? validate(dto) : dto;
}
/** Associate original facts even after a new session; this does not grant POST replay. */
export async function adminOperationMatchesAction(action: AdminAction, identity: AdminIdentity, operation: AdminOperation): Promise<boolean> {
  if (!parseStoredAdminAction(action) || !parseAdminIdentity(identity) ||
    action.identity.source_instance_id !== identity.source_instance_id || action.identity.scope !== identity.scope || action.identity.subject !== identity.subject ||
    !parseAdminOperation(operation, action.request_id, identity) || operation.operation_kind !== action.kind || operation.context_binding !== "bound") return false;
  if (operation.state === "completed") {
    const outcomes = action.kind === "approve" ? ["created", "reused_frozen"] : action.kind.startsWith("direct_") ? ["received"] : ["completed"];
    if (!outcomes.includes(operation.outcome ?? "")) return false;
  }
  const ref = operation.result_ref;
  if (ref) {
    if (ref.kind !== resultKinds[action.kind]) return false;
    if ((action.kind === "reject" || action.kind === "retry") && ref.id !== actionPath(action.path)!.objectId) return false;
    if ((action.kind === "evidence_export" || action.kind.startsWith("direct_")) && ref.revision !== null && ref.revision !== action.body.expected_revision) return false;
  }
  try {
    const contextRef = await sha256(action.identity.authorization_context.context_id);
    return contextRef === operation.operation_context_ref && await adminActionBodyDigest(action) === operation.body_digest;
  } catch { return false; }
}
export async function canReplayAdminAction(action: AdminAction, identity: AdminIdentity, operation: AdminOperation): Promise<boolean> {
  if (!sameAdminIdentity(action.identity, identity) || action.kind === "logout" || operation.state === "pending") return false;
  try { liveIdentity(identity); } catch { return false; }
  return adminOperationMatchesAction(action, identity, operation);
}
