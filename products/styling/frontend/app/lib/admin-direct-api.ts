import { appPath } from "./app-path";
import { AdminError, type Handoff } from "./admin-api";
import { parseAdminJson } from "./admin-context";

export type DirectHandoffBinding = Pick<Handoff, "id" | "version" | "metadata" | "approval_identity_kind" | "source_approval_ref">;
export type DirectApprovalRef = { approval_record_id: string };
export type DirectSupplementRef = { supplement_id: string; digest: string };
export interface DirectReceipt {
  receipt_schema: "pa-direct-receipt/1";
  transport_schema: "pa-direct-delivery/1";
  direct_receive_id: string;
  source_product: "personal_styling";
  target_product: "product_management";
  source_instance_id: string;
  target_instance_id: string;
  authorized_scope: string;
  handoff_id: string;
  revision: number;
  payload_digest: string;
  source_approval_ref: DirectApprovalRef;
  status: "received";
  received_at: string;
  verification_id: string;
  supplement_id: string | null;
  supplement_digest: string | null;
}
export interface DirectSupplementReceipt {
  receipt_schema: "pa-direct-supplement-receipt/1";
  direct_receive_id: string;
  supplement_id: string;
  digest: string;
  received_at: string;
  verification_id: string;
  status: "received";
}
export interface DirectAttempt {
  attempt_id: string;
  operation: "send" | "lookup" | "supplement";
  status: "sending" | "unconfirmed" | "received" | "not_sent";
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
}
export type DirectSupplementDelivery = DirectSupplementRef & { last_error: string | null } & (
  { status: "received"; receipt: DirectSupplementReceipt } | { status: "sending" | "unconfirmed"; receipt: null }
);
export interface DirectNotStarted {
  transport: "direct";
  handoff_id: string;
  revision: number;
  status: "not_started";
  receipt: null;
  current_supplement: null;
  supplement_delivery: null;
  attempts: [];
  transmission_actor_subject?: null;
}
interface DirectStartedBase {
  transport: "direct";
  delivery_id: string;
  handoff_id: string;
  revision: number;
  operation_in_progress: boolean;
  retry_after_seconds: number;
  source_instance_id: string;
  target_instance_id: string;
  authorized_scope: string;
  payload_digest: string;
  source_approval_ref: DirectApprovalRef;
  first_supplement: DirectSupplementRef | null;
  current_supplement: DirectSupplementRef | null;
  last_error: string | null;
  supplement_delivery: DirectSupplementDelivery | null;
  attempts: DirectAttempt[];
  transmission_actor_subject?: string;
}
export type DirectStarted = DirectStartedBase & ({ status: "received"; receipt: DirectReceipt } | { status: "sending" | "unconfirmed"; receipt: null });
export type DirectDelivery = DirectNotStarted | DirectStarted;
export type DirectActionBody = { request_id: string; expected_revision: number };
export type DirectSendBody = DirectActionBody & { include_supplement: boolean };
export type DirectContextActionBody = DirectActionBody & {
  admin_action_contract: "styling_admin_action_v1";
  expected_admin_context: { context_contract: "styling_admin_context_v1"; context_id: string };
};
export type DirectContextSendBody = DirectContextActionBody & { include_supplement: boolean };
export interface EvidenceExport extends DirectSupplementRef {
  handoff_id: string;
  revision: number;
  metadata_digest: string;
  rule_version: "styling-frozen-redaction-v1";
  status: "registered";
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: readonly string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v) && v !== "." && v !== "..";
const subject = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(v);
const integer = (v: unknown, min = 1): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const code = (v: unknown): v is string => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(v);
const nullableCode = (v: unknown) => v === null || code(v);
const approval = (v: unknown): v is DirectApprovalRef => object(v) && exact(v, ["approval_record_id"]) && id(v.approval_record_id);
const supplement = (v: unknown): v is DirectSupplementRef => object(v) && exact(v, ["supplement_id", "digest"]) && id(v.supplement_id) && sha(v.digest);
const sameSupplement = (a: DirectSupplementRef | null, b: DirectSupplementRef | null) => a === null || b === null ? a === b : a.supplement_id === b.supplement_id && a.digest === b.digest;
const utc = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v)) return false;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 19) === v.slice(0, 19) && d.getTime() <= Date.now() + 300000;
};
const invalid = (receipt = false) => new AdminError(502, receipt ? "DIRECT_RECEIPT_MISMATCH" : "DIRECT_RESPONSE_INVALID", receipt ? "回执与原交接身份不一致，不能记为已接收；请保留原记录并重新查询。" : "直连响应不符合约定，未记为成功；请保留原记录并重新查询。");

function assertBinding(handoff: DirectHandoffBinding): void {
  if (!id(handoff.id) || !integer(handoff.version) || !object(handoff.metadata) || !sha(handoff.metadata.payload_digest)) throw invalid();
  if (handoff.approval_identity_kind !== "account_bound" || !approval(handoff.source_approval_ref)) throw new AdminError(422, "APPROVAL_IDENTITY_LEGACY", "此批准缺少服务端账户绑定证据，不能直接发送或补签旧记录。");
}

const receiptFields = ["receipt_schema", "transport_schema", "direct_receive_id", "source_product", "target_product", "source_instance_id", "target_instance_id", "authorized_scope", "handoff_id", "revision", "payload_digest", "source_approval_ref", "status", "received_at", "verification_id", "supplement_id", "supplement_digest"];
function validateReceipt(value: unknown, dto: DirectStartedBase): value is DirectReceipt {
  if (!object(value) || !exact(value, receiptFields) || value.receipt_schema !== "pa-direct-receipt/1" || value.transport_schema !== "pa-direct-delivery/1"
    || value.source_product !== "personal_styling" || value.target_product !== "product_management" || value.status !== "received"
    || !id(value.direct_receive_id) || !id(value.verification_id) || !utc(value.received_at) || !integer(value.revision)
    || !approval(value.source_approval_ref) || value.source_approval_ref.approval_record_id !== dto.source_approval_ref.approval_record_id
    || value.supplement_id !== (dto.first_supplement?.supplement_id ?? null) || value.supplement_digest !== (dto.first_supplement?.digest ?? null)) return false;
  return (["source_instance_id", "target_instance_id", "authorized_scope", "handoff_id", "revision", "payload_digest"] as const).every(k => value[k] === dto[k]);
}
function validateLate(value: unknown, dto: DirectStartedBase, receipt: DirectReceipt | null): value is DirectSupplementDelivery | null {
  if (value === null) return true;
  if (!receipt || dto.first_supplement !== null || !object(value) || !exact(value, ["supplement_id", "digest", "status", "receipt", "last_error"])
    || !id(value.supplement_id) || !sha(value.digest) || !nullableCode(value.last_error)) return false;
  if (value.status === "sending" || value.status === "unconfirmed") return value.receipt === null;
  const r = value.receipt;
  return value.status === "received" && value.last_error === null && object(r)
    && exact(r, ["receipt_schema", "direct_receive_id", "supplement_id", "digest", "received_at", "verification_id", "status"])
    && r.receipt_schema === "pa-direct-supplement-receipt/1" && r.status === "received" && r.direct_receive_id === receipt.direct_receive_id
    && r.supplement_id === value.supplement_id && r.digest === value.digest && id(r.verification_id) && utc(r.received_at);
}
function attempt(v: unknown): v is DirectAttempt {
  return object(v) && exact(v, ["attempt_id", "operation", "status", "error_code", "started_at", "finished_at"])
    && id(v.attempt_id) && ["send", "lookup", "supplement"].includes(String(v.operation)) && ["sending", "unconfirmed", "received", "not_sent"].includes(String(v.status))
    && nullableCode(v.error_code) && utc(v.started_at) && (v.finished_at === null ? v.status === "sending" : utc(v.finished_at) && Date.parse(v.finished_at) >= Date.parse(v.started_at))
    && (v.status !== "received" || v.error_code === null);
}

/** Strict source-ledger DTO validation; legacy transport is never promoted into direct success. */
export function parseDirectDelivery(value: unknown, handoff: DirectHandoffBinding): DirectDelivery {
  assertBinding(handoff);
  if (!object(value) || value.transport !== "direct" || value.handoff_id !== handoff.id || value.revision !== handoff.version || !integer(value.revision)) throw invalid();
  if (value.status === "not_started") {
    if (!exact(value, ["transport", "handoff_id", "revision", "status", "receipt", "current_supplement", "supplement_delivery", "attempts", ...(Object.hasOwn(value, "transmission_actor_subject") ? ["transmission_actor_subject"] : [])])
      || (Object.hasOwn(value, "transmission_actor_subject") && value.transmission_actor_subject !== null)
      || value.receipt !== null || value.current_supplement !== null || value.supplement_delivery !== null || !Array.isArray(value.attempts) || value.attempts.length !== 0) throw invalid();
    return value as unknown as DirectNotStarted;
  }
  const fields = ["transport", "delivery_id", "handoff_id", "revision", "status", "operation_in_progress", "retry_after_seconds", "source_instance_id", "target_instance_id", "authorized_scope", "payload_digest", "source_approval_ref", "first_supplement", "receipt", "current_supplement", "last_error", "supplement_delivery", "attempts"];
  if (Object.hasOwn(value, "transmission_actor_subject")) fields.push("transmission_actor_subject");
  if (!exact(value, fields) || (Object.hasOwn(value, "transmission_actor_subject") && !subject(value.transmission_actor_subject)) || !["sending", "unconfirmed", "received"].includes(String(value.status)) || !id(value.delivery_id)
    || !id(value.source_instance_id) || !id(value.target_instance_id) || !id(value.authorized_scope) || value.payload_digest !== handoff.metadata.payload_digest
    || !approval(value.source_approval_ref) || value.source_approval_ref.approval_record_id !== handoff.source_approval_ref!.approval_record_id
    || typeof value.operation_in_progress !== "boolean" || !integer(value.retry_after_seconds, 0) || value.operation_in_progress !== (value.retry_after_seconds > 0)
    || (value.first_supplement !== null && !supplement(value.first_supplement)) || (value.current_supplement !== null && !supplement(value.current_supplement))
    || !nullableCode(value.last_error) || !Array.isArray(value.attempts) || !value.attempts.every(attempt)
    || new Set(value.attempts.map(a => a.attempt_id)).size !== value.attempts.length) throw invalid();
  const dto = value as unknown as DirectStarted;
  if (dto.status === "received" ? dto.last_error !== null || !validateReceipt(value.receipt, dto) : value.receipt !== null) throw invalid(true);
  if (!validateLate(value.supplement_delivery, dto, dto.receipt)) throw invalid(true);
  const current = dto.current_supplement;
  if (dto.status !== "received" && (current !== null || dto.supplement_delivery !== null)) throw invalid(true);
  if (dto.status === "received" && dto.first_supplement !== null && !sameSupplement(current, dto.first_supplement)) throw invalid(true);
  if (current !== null && !sameSupplement(current, dto.first_supplement) && (!dto.supplement_delivery || !sameSupplement(current, dto.supplement_delivery))) throw invalid(true);
  if (dto.supplement_delivery?.status === "received" && !sameSupplement(current, dto.supplement_delivery)) throw invalid(true);
  return dto;
}

const messages: Record<string, string> = {
  ADMIN_CONTEXT_REQUIRED: "管理上下文缺失，请重新读取身份；不会退回旧发送方式。",
  ADMIN_CONTEXT_INVALID: "管理上下文格式不符合契约，请重新读取身份。",
  ADMIN_ACTION_INVALID: "原动作格式无效，未自动修补或发送。",
  ADMIN_AUTH_CONTEXT_CHANGED: "管理会话已变化，原动作仅可查询；请重新核对当前身份和对象。",
  ADMIN_ACTION_CONTEXT_CONFLICT: "原动作属于另一个管理上下文，只能查询原事实，不能更换上下文重放。",
  ADMIN_ACTION_BODY_CONFLICT: "原编号已绑定其他内容，请保留原动作核对，不自动改写。",
  ADMIN_ACTION_IN_PROGRESS: "原动作仍在处理，仅可查询已存状态，不重复执行。",
  ADMIN_ACTION_LEGACY_UNBOUND: "历史动作缺原上下文，只能读取，不能补签或重放。",
  ADMIN_OPERATION_NOT_FOUND: "当前身份查不到原动作；这不表示目标未接收，也不允许自动发送。",
  ADMIN_AUTH_UNAVAILABLE: "权威管理身份暂不可用，新写操作保持关闭。",
  ADMIN_OPERATION_STORAGE_UNAVAILABLE: "管理动作账本暂不可用，不能将读取失败当作空记录。",
  DIRECT_SESSION_INVALID: "管理登录已失效，请重新登录后查询原交接状态。",
  APPROVAL_IDENTITY_LEGACY: "该历史批准缺少账户绑定来源，不能补签或直接发送。",
  DIRECT_SCOPE_FORBIDDEN: "管理账户或授权范围已变化，当前不能操作。",
  DIRECT_DELIVERY_NOT_FOUND: "尚无该原身份的直连记录，请核对所选交接包。",
  DIRECT_REVISION_CONFLICT: "交接修订不一致，请重新读取并人工核对，不会自动改版本重试。",
  DIRECT_REQUEST_CONFLICT: "动作编号已绑定不同内容，请保留原动作并核对。",
  DIRECT_IDENTITY_CONFLICT: "直连源、目标或原身份发生冲突，不能改写已有交接。",
  DIRECT_FROZEN_CONFLICT: "冻结原体或回执不一致，不能重写原身份。",
  DIRECT_SEND_IN_PROGRESS: "该交接仍有操作在途，请稍后查询原状态。",
  DIRECT_SEND_INELIGIBLE: "该交接当前不符合发送资格，请核对来源状态。",
  DIRECT_RECEIPT_REQUIRED: "须先查询并确认原接收回执，再追加冻结补充。",
  DIRECT_SUPPLEMENT_ALREADY_PRESENT: "首次信封已包含补充，不能通过晚补修改它。",
  DIRECT_SUPPLEMENT_CONFLICT: "晚补身份或摘要冲突，原首次回执保持。",
  DIRECT_TIMEOUT: "产品管理服务响应超时，接收尚未确认，请先查询原身份。",
  DIRECT_UNREACHABLE: "产品管理服务不可达，接收尚未确认。",
  DIRECT_RESPONSE_INVALID: "直连响应不符合协议，未记为成功，请查询原身份。",
  DIRECT_RECEIPT_MISMATCH: "回执与原交接身份不一致，不能记为已接收。",
  DIRECT_REMOTE_REJECTED: "产品管理服务拒绝本次交接，请保留原身份核对。",
  DIRECT_RECEIPT_NOT_FOUND: "产品管理尚无该原身份的接收记录，仍为未确认。",
  DIRECT_INTERRUPTED: "直连操作中断，接收尚未确认，请查询原身份。",
  DIRECT_STORAGE_UNAVAILABLE: "直连存储暂不可用，不能当成空记录或成功。",
  DIRECT_INPUT_TOO_LARGE: "交接或补充超过大小限制，未发送，请联系后端核对。",
  EVIDENCE_EXPORT_NOT_FOUND: "冻结补充尚未登记，请先明确登记后再下载。",
  EVIDENCE_INCOMPLETE: "冻结出处不完整，不能从当前记录补造历史。",
  EVIDENCE_PRIVACY_BLOCKED: "冻结内容触发隐私保护，本次导出已阻断，原件保持。",
  EVIDENCE_FORBIDDEN: "当前账户无权读取该冻结补充。",
  APPROVAL_BINDING_CONFLICT: "批准来源与冻结内容绑定不一致，请联系后端核对。",
};
export function directErrorMessage(errorCode: string, status = 0): string {
  if (messages[errorCode]) return messages[errorCode];
  if (["DIRECT_NOT_CONFIGURED", "DIRECT_CONFIGURATION_INVALID", "DIRECT_TARGET_NOT_CONFIGURED", "DIRECT_TARGET_INVALID"].includes(errorCode)) return "直接交接服务或目标尚未正确配置，请联系后端负责人。";
  if (status === 401) return "管理员登录已失效，请重新登录后查询原状态。";
  if (status === 403) return "当前管理身份无权执行此操作。";
  if (status === 409) return "操作或记录发生冲突，请保留原内容并重新读取核对。";
  if (status === 422) return "本次请求或冻结证据不符合服务端要求，请保留原内容并核对错误代码。";
  if (status === 503) return "直连接口或存储暂不可用，接收尚未确认，请稍后读取原状态。";
  return "直连操作未完成，请保留原记录并查询核对。";
}
const abort = (error: unknown) => object(error) && error.name === "AbortError";
async function responseError(response: Response): Promise<AdminError> {
  const data: unknown = await response.json().catch(() => null);
  const errorCode = object(data) && object(data.error) && code(data.error.code) ? data.error.code : response.status === 401 ? "UNAUTHORIZED" : `HTTP_${response.status}`;
  return new AdminError(response.status, errorCode, directErrorMessage(errorCode, response.status));
}
async function request(handoff: DirectHandoffBinding, suffix: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<Response> {
  assertBinding(handoff);
  try {
    const response = await fetch(appPath(`/api/v1/admin/handoffs/${encodeURIComponent(handoff.id)}/${suffix}`), {
      method, credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await responseError(response);
    if (response.redirected) throw invalid();
    return response;
  } catch (error) {
    if (error instanceof AdminError || abort(error)) throw error;
    throw new AdminError(0, "NETWORK_ERROR", "网络中断，操作结果未确认；请先读取原记录，不会自动重新发送。");
  }
}
async function jsonResponse(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw invalid();
  try { return parseAdminJson(await response.text()); } catch (error) { if (abort(error)) throw error; throw invalid(); }
}
type AnyDirectAction = DirectActionBody | DirectSendBody | DirectContextActionBody | DirectContextSendBody;
function contextAction(body: unknown): body is DirectContextActionBody | DirectContextSendBody {
  return object(body) && (Object.hasOwn(body, "admin_action_contract") || Object.hasOwn(body, "expected_admin_context"));
}
function validateAction(body: AnyDirectAction, handoff: DirectHandoffBinding, send: boolean): void {
  const fields = send ? ["request_id", "expected_revision", "include_supplement"] : ["request_id", "expected_revision"];
  const bound = contextAction(body);
  if (bound) fields.push("admin_action_contract", "expected_admin_context");
  if (!object(body) || !exact(body, fields)
    || (bound && (body.admin_action_contract !== "styling_admin_action_v1" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.request_id)
      || !object(body.expected_admin_context) || !exact(body.expected_admin_context, ["context_contract", "context_id"])
      || body.expected_admin_context.context_contract !== "styling_admin_context_v1" || typeof body.expected_admin_context.context_id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.expected_admin_context.context_id)))
    || !id(body.request_id) || !integer(body.expected_revision) || body.expected_revision !== handoff.version || (send && (!("include_supplement" in body) || typeof body.include_supplement !== "boolean"))) throw new AdminError(422, "INVALID_REQUEST", "直连动作字段或修订无效；原动作与交接包保持，未发送请求。");
}
export async function getDirectDelivery(handoff: DirectHandoffBinding, signal?: AbortSignal): Promise<DirectDelivery> {
  return parseDirectDelivery(await jsonResponse(await request(handoff, "direct-delivery", "GET", undefined, signal)), handoff);
}
function validateActionResponse(response: Response, body: AnyDirectAction): void {
  if (contextAction(body) && (response.headers.get("x-styling-admin-action-contract") !== "styling_admin_action_v1"
    || response.headers.get("x-styling-admin-request-id") !== body.request_id || !response.headers.get("cache-control")?.split(",").some(v => v.trim().toLowerCase() === "no-store"))) throw invalid();
}
async function action(handoff: DirectHandoffBinding, suffix: string, body: AnyDirectAction, signal?: AbortSignal): Promise<DirectDelivery> {
  validateAction(body, handoff, suffix === "direct-send");
  const response = await request(handoff, suffix, "POST", body, signal);
  validateActionResponse(response, body);
  return parseDirectDelivery(await jsonResponse(response), handoff);
}
export const sendDirectHandoff = (handoff: DirectHandoffBinding, body: DirectSendBody | DirectContextSendBody, signal?: AbortSignal) => action(handoff, "direct-send", body, signal);
export const reconcileDirectHandoff = (handoff: DirectHandoffBinding, body: DirectActionBody | DirectContextActionBody, signal?: AbortSignal) => action(handoff, "direct-reconcile", body, signal);
export const appendDirectSupplement = (handoff: DirectHandoffBinding, body: DirectActionBody | DirectContextActionBody, signal?: AbortSignal) => action(handoff, "direct-supplement", body, signal);

export function parseEvidenceExport(value: unknown, handoff: DirectHandoffBinding): EvidenceExport {
  assertBinding(handoff);
  if (!object(value) || !exact(value, ["supplement_id", "digest", "handoff_id", "revision", "metadata_digest", "rule_version", "status"])
    || !id(value.supplement_id) || !sha(value.digest) || value.handoff_id !== handoff.id || value.revision !== handoff.version
    || !sha(value.metadata_digest) || value.rule_version !== "styling-frozen-redaction-v1" || value.status !== "registered") throw invalid();
  return value as unknown as EvidenceExport;
}
export async function registerEvidenceExport(handoff: DirectHandoffBinding, bodyOrSignal?: DirectContextActionBody | AbortSignal, signal?: AbortSignal): Promise<EvidenceExport> {
  const body = bodyOrSignal && !(bodyOrSignal instanceof AbortSignal) ? bodyOrSignal : undefined;
  if (body) { if (!contextAction(body)) throw invalid(); validateAction(body, handoff, false); }
  const response = await request(handoff, "evidence-export", "POST", body, body ? signal : bodyOrSignal as AbortSignal | undefined);
  if (body) validateActionResponse(response, body);
  return parseEvidenceExport(await jsonResponse(response), handoff);
}

/** Download original bytes; never JSON.stringify a parsed projection back into its export. */
export async function downloadEvidenceExport(handoff: DirectHandoffBinding, expected?: EvidenceExport | DirectSupplementRef, signal?: AbortSignal): Promise<{ blob: Blob; fileName: string; digest: string }> {
  if (expected && (!id(expected.supplement_id) || !sha(expected.digest))) throw invalid();
  if (expected && "handoff_id" in expected) parseEvidenceExport(expected, handoff);
  const response = await request(handoff, "evidence-export", "GET", undefined, signal);
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw invalid();
  const headerDigest = response.headers.get("x-content-sha256");
  if (!sha(headerDigest) || (expected && expected.digest !== headerDigest)) throw invalid();
  let bytes: ArrayBuffer;
  try { bytes = await response.arrayBuffer(); } catch (error) { if (abort(error)) throw error; throw new AdminError(0, "DOWNLOAD_FAILED", "冻结补充下载中断，未提供不完整文件，请重新读取。"); }
  if (bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) throw invalid();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
  if (digest !== headerDigest) throw invalid();
  let content: unknown;
  try { content = parseAdminJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!object(content) || !exact(content, ["supplement_schema", "handoff_id", "revision", "payload_digest", "approved_at", "approved_by", "window_start", "window_end", "evidence_revisions", "evidence_digest", "evidence_digest_version", "source_snapshot", "provenance", "source_proof"])
    || content.supplement_schema !== "pa-frozen-evidence/1" || content.handoff_id !== handoff.id || content.revision !== handoff.version || content.payload_digest !== handoff.metadata.payload_digest
    || !utc(content.approved_at) || content.approved_at !== handoff.metadata.approved_at || content.approved_by !== handoff.metadata.approved_by
    || !object(content.source_proof) || !exact(content.source_proof, ["kind", "metadata_digest", "exported_by"])
    || content.source_proof.kind !== "approved_metadata_projection" || !sha(content.source_proof.metadata_digest) || !id(content.source_proof.exported_by)
    || (expected && "metadata_digest" in expected && content.source_proof.metadata_digest !== expected.metadata_digest)) throw invalid();
  return { blob: new Blob([bytes], { type: "application/json" }), fileName: `${expected?.supplement_id ?? handoff.id}.evidence.json`, digest };
}
