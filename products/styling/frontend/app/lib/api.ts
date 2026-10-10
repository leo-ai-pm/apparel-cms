import { appPath } from "./app-path";
import { FixedApiError, fixedErrorMessage, fixedResponseError, parseFixedOutfit, type FixedOutfit, type FixedOutcome } from "./fixed-outfits";
import { isProfileBinding, isRequestConditions, type ProfileBinding, type RequestConditions } from "./consumer-profile";

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export type ChatDoneEvent = {
  type: "done";
  session_id: string;
  content: string;
  product_ids?: string[];
  signal_id?: string | null;
  request_id?: string;
  outcome?: FixedOutcome;
  outfit?: FixedOutfit | null;
  fixed_session_id?: string;
  state_revision?: number;
  conversation_revision?: number;
  profile_context?: ProfileContext;
};
export type ProfileContext = {
  field_sources: Record<string, string>;
  missing_fields: string[];
  clarification: { field: string; next_field: string | null; question: string } | null;
};
export type ChatEvent =
  | { type: "status"; message: string }
  | { type: "text"; content: string }
  | ChatDoneEvent
  | { type: "error"; request_id?: string; session_id?: string; error: { code: string; message: string } };

export type PreparedChatRequest = Readonly<{ request_id: string; session_id: string; message: string; budget?: string; scene?: string; request_conditions?: RequestConditions; profile_binding?: ProfileBinding }>;
export interface GenerationRequest {
  recorded: boolean;
  request_id: string;
  session_id: string;
  status: "accepted" | "running" | "succeeded" | "failed" | "not_recorded";
  outcome: FixedOutcome | null;
  error_code: string | null;
  result: Record<string, unknown> | null;
  effective_outfit: boolean;
  accepted_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export class ChatRecoveryError extends Error {
  constructor(public request_id: string, public session_id: string, public status: string) {
    super(status === "accepted" || status === "running"
      ? "连接中断，原请求仍在处理中。请查询这次请求的结果，不要重复发送。"
      : "暂时无法确认这次请求的结果，需求已保留。请先查询原请求和固定搭配历史。");
    this.name = "ChatRecoveryError";
  }
}

export interface TryonTask {
  task_id: string;
  status: "processing" | "succeeded" | "failed";
  /** Existing task metadata; prices and catalog versions are not frozen here. */
  product_ids?: string[];
  result_url?: string;
  error?: { code: string; message: string } | null;
  scene?: string;
}

export interface Product {
  product_id: string;
  name: string;
  category: string;
  price: number;
  color: string;
  image_url?: string;
}

const SESSION_KEY = "session_id";
const LAST_SESSION_KEY = "styling.last-session.v1";
const SESSION_LIST_KEY = "styling.sessions.v1";
let accountScope = "";
const storageKey = (key: string) => accountScope ? `${key}:${accountScope}` : key;
export type SavedSession = { id: string; createdAt: number };

export async function initializeAccountHistory(): Promise<void> {
  const identity = await fetch("/platform/me");
  if (!identity.ok) throw new Error("请重新登录后继续体验。");
  const account = await identity.json();
  if (typeof account.username !== "string") throw new Error("账号信息加载失败。");
  accountScope = account.username;
  const response = await fetch(appPath("/api/v1/sessions"));
  if (!response.ok) throw new Error("历史记录暂时无法加载，请刷新重试。");
  const data = await response.json();
  const remote: SavedSession[] = Array.isArray(data.sessions) ? data.sessions : [];
  const merged = new Map<string, SavedSession>();
  for (const item of remote) {
    if (typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(item.id) && Number.isFinite(item.createdAt)) merged.set(item.id, item);
  }
  const sessions = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
  try {
    localStorage.setItem(storageKey(SESSION_LIST_KEY), JSON.stringify(sessions));
    if (!localStorage.getItem(storageKey(LAST_SESSION_KEY)) && sessions.length) rememberSession(sessions[0].id);
  } catch { /* The active session still works if browser storage is restricted. */ }
}

export function getSavedSessions(): SavedSession[] {
  if (typeof window === "undefined") return [];
  try {
    const items: unknown = JSON.parse(localStorage.getItem(storageKey(SESSION_LIST_KEY)) || "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is SavedSession => !!item && typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(item.id) && Number.isFinite(item.createdAt));
  } catch { return []; }
}

/** Merge server history identifiers without selecting a different conversation. */
export async function fetchSavedSessionIndex(): Promise<SavedSession[]> {
  const response = await fetch(appPath("/api/v1/sessions"));
  if (!response.ok) throw new Error("历史会话列表暂时无法加载，请稍后重试。");
  const data: unknown = await response.json();
  if (!record(data) || !Array.isArray(data.sessions)) throw new Error("历史会话列表不完整，请稍后重试。");
  const merged = new Map<string, SavedSession>();
  for (const item of data.sessions) {
    if (!record(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id)
      || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)) throw new Error("历史会话列表不完整，请稍后重试。");
    merged.set(item.id, { id: item.id, createdAt: item.createdAt });
  }
  const sessions = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
  try { localStorage.setItem(storageKey(SESSION_LIST_KEY), JSON.stringify(sessions)); } catch { /* Read results remain usable without storage. */ }
  return sessions;
}

export function rememberSession(id: string) {
  try {
    const sessions = getSavedSessions();
    if (!sessions.some(item => item.id === id)) sessions.unshift({ id, createdAt: Date.now() });
    // Only identifiers and timestamps are stored here; content remains on the backend.
    localStorage.setItem(storageKey(SESSION_LIST_KEY), JSON.stringify(sessions));
    localStorage.setItem(storageKey(LAST_SESSION_KEY), id);
    sessionStorage.setItem(storageKey(SESSION_KEY), id);
  } catch { /* Storage-restricted browsers can still use the active conversation. */ }
}

/** Forget only this browser's active selection when the server reports another identity. */
export function forgetSessionSelection() {
  try {
    localStorage.removeItem(storageKey(LAST_SESSION_KEY));
    localStorage.removeItem(storageKey(SESSION_LIST_KEY));
    sessionStorage.removeItem(storageKey(SESSION_KEY));
  } catch { /* Server ownership remains the boundary. */ }
}

export function selectSavedSession(id: string): boolean {
  if (!getSavedSessions().some(item => item.id === id)) return false;
  rememberSession(id);
  return true;
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getSessionId(): string {
  if (typeof window === "undefined") return "";
  // Preserve each open tab; a new tab resumes the most recently selected conversation.
  let id: string | null = null;
  try { id = sessionStorage.getItem(storageKey(SESSION_KEY)) || localStorage.getItem(storageKey(LAST_SESSION_KEY)); } catch { /* Optional browser storage. */ }
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) id = newId();
  rememberSession(id);
  return id;
}

export function peekSessionId(): string | null {
  try {
    const id = sessionStorage.getItem(storageKey(SESSION_KEY)) || localStorage.getItem(storageKey(LAST_SESSION_KEY));
    return id && /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : null;
  } catch { return null; }
}

export function resetSession(): string {
  const id = newId();
  if (typeof window !== "undefined") rememberSession(id);
  return id;
}

export async function fetchHistory(sessionId: string): Promise<Message[]> {
  const resp = await fetch(appPath(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`));
  if (!resp.ok) throw new Error(`历史加载失败（${resp.status}）`);
  const data = await resp.json();
  return Array.isArray(data.messages) ? data.messages : [];
}

export async function uploadTryon(
  photo: File,
  productIds: string[],
  scene: string,
  sessionId: string,
): Promise<{ task_id: string }> {
  const form = new FormData();
  form.append("photo", photo);
  form.append("product_ids", productIds.join(","));
  form.append("scene", scene);
  form.append("session_id", sessionId);
  const resp = await fetch(appPath("/api/v1/tryon"), { method: "POST", body: form });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || "照片上传失败，请稍后重试");
  }
  return data as { task_id: string };
}

export async function fetchTryonStatus(taskId: string): Promise<TryonTask> {
  const resp = await fetch(appPath(`/api/v1/tryon/${encodeURIComponent(taskId)}`));
  if (!resp.ok) throw new Error("试穿任务查询失败");
  return (await resp.json()) as TryonTask;
}

export async function fetchTryons(sessionId: string): Promise<TryonTask[]> {
  const resp = await fetch(appPath(`/api/v1/tryon?session_id=${encodeURIComponent(sessionId)}`));
  if (!resp.ok) throw new Error("历史搭配暂时无法加载，请稍后重试。");
  const data = await resp.json();
  return Array.isArray(data.tryons) ? data.tryons : [];
}

export async function fetchProducts(ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  const resp = await fetch(appPath(`/api/v1/products?ids=${encodeURIComponent(ids.join(","))}`));
  if (!resp.ok) throw new Error("商品明细暂时无法加载，请稍后重试。");
  const data = await resp.json();
  return Array.isArray(data.products) ? data.products : [];
}

export async function fetchCart(sessionId: string): Promise<string[]> {
  const resp = await fetch(appPath(`/api/v1/cart?session_id=${encodeURIComponent(sessionId)}`));
  if (!resp.ok) throw new Error("模拟购物车暂时无法加载，请稍后重试。");
  const data = await resp.json();
  return Array.isArray(data.cart) ? data.cart : [];
}

export async function addCart(sessionId: string, productId: string): Promise<string[]> {
  const resp = await fetch(appPath("/api/v1/cart"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, product_id: productId }),
  });
  if (!resp.ok) throw new Error("加购失败，请稍后重试");
  const data = await resp.json();
  return Array.isArray(data.cart) ? data.cart : [];
}

export async function removeCart(sessionId: string, productId: string): Promise<string[]> {
  const resp = await fetch(appPath(`/api/v1/cart/${encodeURIComponent(productId)}?session_id=${encodeURIComponent(sessionId)}`), {
    method: "DELETE",
  });
  if (!resp.ok) throw new Error("取消加购失败，请稍后重试");
  const data = await resp.json();
  return Array.isArray(data.cart) ? data.cart : [];
}

export interface SignalDraft {
  signal_id: string;
  session_id: string;
  source_agent: string;
  timestamp: string;
  scene: string;
  season: string;
  preference: string;
  body_type_tag: string;
  change_reason: string;
  outfit_plan: { items: { product_id: string; name: string; category: string }[]; note?: string };
  feedback_type: string;
  user_tag: string;
  status: "draft" | "uploaded";
  uploaded_at: string | null;
}

export const FEEDBACK_TYPES = [
  { value: "intent", label: "意图" },
  { value: "simulated_cart", label: "模拟加购" },
  { value: "real_purchase", label: "真实成交" },
  { value: "out_of_stock", label: "缺货" },
  { value: "missing_image", label: "缺图" },
] as const;

export async function fetchSignals(sessionId: string): Promise<SignalDraft[]> {
  const resp = await fetch(appPath(`/api/v1/signals?session_id=${encodeURIComponent(sessionId)}`));
  if (!resp.ok) return [];
  const data = await resp.json();
  return Array.isArray(data.signals) ? data.signals : [];
}

export async function fetchRecommendedIds(sessionId: string): Promise<string[]> {
  const resp = await fetch(appPath(`/api/v1/recommendations?session_id=${encodeURIComponent(sessionId)}`));
  if (!resp.ok) throw new Error("当前方案暂时无法加载，请稍后重试。");
  const data = await resp.json();
  return Array.isArray(data.product_ids) ? data.product_ids : [];
}

export async function uploadSignal(signalId: string, feedbackType: string): Promise<SignalDraft> {
  const resp = await fetch(appPath(`/api/v1/signals/${encodeURIComponent(signalId)}/upload`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback_type: feedbackType }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || "上传失败，请稍后重试");
  }
  return (data.signal ?? data) as SignalDraft;
}

export function createChatRequest(sessionId: string, message: string, budget: string, scene: string): PreparedChatRequest {
  return Object.freeze({ session_id: sessionId, message, budget, scene, request_id: newId() });
}

/** New profile requests never double-write legacy budget/scene fields. */
export function createProfileChatRequest(sessionId: string, message: string, conditions: RequestConditions): PreparedChatRequest {
  return Object.freeze({ session_id: sessionId, message, request_id: newId(), request_conditions: structuredClone(conditions) });
}

export function isStoredChatRequest(value: unknown, sessionId: string): value is PreparedChatRequest {
  if (!record(value) || value.session_id !== sessionId || typeof value.message !== "string"
    || !/^[A-Za-z0-9_-]{1,64}$/.test(String(value.request_id))) return false;
  if (typeof value.budget === "string" && typeof value.scene === "string" && value.request_conditions === undefined) return true;
  if (!isRequestConditions(value.request_conditions) || value.budget !== undefined || value.scene !== undefined) return false;
  if (value.profile_binding !== undefined && !isProfileBinding(value.profile_binding)) return false;
  return true;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const knownOutcomes: readonly string[] = ["complete_outfit", "recommendation", "refusal", "clarification", "no_match", "action_completed", "action_failed"];

function doneEvent(value: unknown): ChatDoneEvent {
  if (!record(value) || typeof value.session_id !== "string" || typeof value.content !== "string") throw new Error("INVALID_CHAT_RESULT");
  const event: ChatDoneEvent = { type: "done", session_id: value.session_id, content: value.content };
  if (Array.isArray(value.product_ids) && value.product_ids.every(id => typeof id === "string")) event.product_ids = value.product_ids;
  event.signal_id = typeof value.signal_id === "string" ? value.signal_id : null;
  if (typeof value.request_id === "string") event.request_id = value.request_id;
  if (typeof value.fixed_session_id === "string") event.fixed_session_id = value.fixed_session_id;
  if (typeof value.outcome === "string" && knownOutcomes.includes(value.outcome)) event.outcome = value.outcome as FixedOutcome;
  if (typeof value.state_revision === "number" && Number.isSafeInteger(value.state_revision) && value.state_revision >= 0) event.state_revision = value.state_revision;
  if (typeof value.conversation_revision === "number" && Number.isSafeInteger(value.conversation_revision) && value.conversation_revision >= 0) event.conversation_revision = value.conversation_revision;
  if (value.outfit !== undefined) event.outfit = value.outfit === null ? null : parseFixedOutfit(value.outfit);
  if (record(value.profile_context) && Array.isArray(value.profile_context.missing_fields)
    && value.profile_context.missing_fields.every(field => typeof field === "string") && record(value.profile_context.field_sources)) {
    const clarification = value.profile_context.clarification;
    if (clarification === null || (record(clarification) && typeof clarification.field === "string"
      && (clarification.next_field === null || typeof clarification.next_field === "string") && typeof clarification.question === "string")) {
      event.profile_context = value.profile_context as ProfileContext;
    }
  }
  if (event.outcome === "complete_outfit" && !event.outfit) throw new Error("INVALID_CHAT_RESULT");
  return event;
}

export async function fetchGenerationRequest(sessionId: string, requestId: string): Promise<GenerationRequest | null> {
  const response = await fetch(appPath(`/api/v1/generation-requests/${encodeURIComponent(requestId)}?session_id=${encodeURIComponent(sessionId)}`));
  if (response.status === 404) return null;
  if (!response.ok) throw await fixedResponseError(response);
  const data: unknown = await response.json();
  if (!record(data) || data.session_id !== sessionId || data.request_id !== requestId || typeof data.recorded !== "boolean"
    || !["accepted", "running", "succeeded", "failed", "not_recorded"].includes(String(data.status))
    || !(data.result === null || record(data.result)) || typeof data.effective_outfit !== "boolean"
    || !(data.outcome === null || knownOutcomes.includes(String(data.outcome)))
    || !(data.error_code === null || typeof data.error_code === "string")
    || (data.recorded === false && data.status !== "not_recorded") || (data.recorded && data.status === "not_recorded")) {
    throw new FixedApiError(502, "INVALID_GENERATION_RECORD", "请求状态数据不完整，请稍后重读原请求。");
  }
  return data as unknown as GenerationRequest;
}

export function generationRequestEvent(request: GenerationRequest): ChatEvent | null {
  if (!request.recorded) return null;
  if (request.status === "failed") return {
    type: "error", request_id: request.request_id, session_id: request.session_id,
    error: { code: request.error_code || "GENERATION_FAILED", message: fixedErrorMessage(request.error_code || "GENERATION_FAILED") },
  };
  if (request.status !== "succeeded" || !request.result) return null;
  // The current consumer uses /chat. JSON turn records use response.text and the same frozen outfit.
  const result = request.result;
  const content = typeof result.content === "string" ? result.content : record(result.response) && typeof result.response.text === "string" ? result.response.text : undefined;
  return doneEvent({ ...result, content, session_id: request.session_id, request_id: request.request_id, outcome: request.outcome });
}

async function recoverChat(body: PreparedChatRequest, onEvent: (event: ChatEvent) => void): Promise<void> {
  let request: GenerationRequest | null;
  try { request = await fetchGenerationRequest(body.session_id, body.request_id); }
  catch { throw new ChatRecoveryError(body.request_id, body.session_id, "unknown"); }
  let event: ChatEvent | null;
  try { event = request ? generationRequestEvent(request) : null; }
  catch { throw new ChatRecoveryError(body.request_id, body.session_id, "invalid_result"); }
  if (event) { onEvent(event); return; }
  throw new ChatRecoveryError(body.request_id, body.session_id, request?.status || "unknown");
}

/** Never allocates an identity or repeats POST. An incomplete stream only queries its original request. */
export async function sendPreparedChat(body: PreparedChatRequest, onEvent: (event: ChatEvent) => void): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(body.request_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(body.session_id)
    || typeof body.message !== "string" || !body.message.trim() || !isStoredChatRequest(body, body.session_id)
    || (body.request_conditions !== undefined && !body.profile_binding)) {
    throw new FixedApiError(400, "INVALID_CHAT_REQUEST", "发送身份或需求不完整，请检查后再发送。");
  }
  let response: Response;
  try {
    response = await fetch(appPath("/api/v1/chat"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { return recoverChat(body, onEvent); }
  if (!response.ok) throw await fixedResponseError(response);
  if (!response.body) return recoverChat(body, onEvent);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  const consume = (raw: string) => {
    let kind = "";
    const lines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) kind = line.slice(6).trim();
      else if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
    }
    if (!lines.length || terminal) return;
    let parsed: unknown;
    try { parsed = JSON.parse(lines.join("\n")); } catch { return; }
    if (!record(parsed)) return;
    // Responses from a previous session/request must never enter this conversation.
    if ((parsed.request_id !== undefined && parsed.request_id !== body.request_id)
      || (parsed.session_id !== undefined && parsed.session_id !== body.session_id)) return;
    let event: ChatEvent | null = null;
    if (kind === "done") {
      try { event = doneEvent(parsed); } catch { return; }
      terminal = true;
    } else if (kind === "error" && record(parsed.error)) {
      const code = typeof parsed.error.code === "string" ? parsed.error.code : "UNKNOWN";
      event = { type: "error", request_id: body.request_id, session_id: body.session_id, error: { code, message: fixedErrorMessage(code) } };
      terminal = true;
    } else if (parsed.type === "status" && typeof parsed.message === "string") event = { type: "status", message: parsed.message };
    else if (parsed.type === "text" && typeof parsed.content === "string") event = { type: "text", content: parsed.content };
    if (event) onEvent(event);
  };
  try {
    while (!terminal) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // Handle both SSE newline conventions, including CR/LF split across read chunks.
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, match.index).replace(/\r\n/g, "\n"));
        buffer = buffer.slice(match.index + match[0].length);
      }
      if (done) { if (buffer.trim()) consume(buffer.replace(/\r\n/g, "\n")); break; }
    }
  } catch {
    if (!terminal) return recoverChat(body, onEvent);
    throw new Error("结果已收到，但页面处理失败，请刷新读取原记录。");
  } finally {
    reader.releaseLock();
  }
  if (!terminal) await recoverChat(body, onEvent);
}

export async function streamChat(
  sessionId: string,
  message: string,
  budget: string,
  scene: string,
  onEvent: (ev: ChatEvent) => void,
  requestId?: string,
): Promise<void> {
  const prepared = requestId ? { session_id: sessionId, message, budget, scene, request_id: requestId } : createChatRequest(sessionId, message, budget, scene);
  await sendPreparedChat(prepared, onEvent);
}
