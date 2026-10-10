import { appPath } from "./app-path";
import { isProfileBinding, isRequestConditions, profileErrorMessage, type ProfileBinding, type RequestConditions, type ProfileFieldName, type ProfileFieldSource } from "./consumer-profile";
import { normalizeProductImageFields, type ProductImageDisplay, type ProductImageUseRef } from "./product-images";
export type { ProductImageDisplay, ProductImageUseRef } from "./product-images";

export interface FixedProfileSnapshot extends ProfileBinding {
  profile_contract: "consumer_profile_v1";
  recorded: true;
  field_sources: Partial<Record<ProfileFieldName, ProfileFieldSource>>;
}

export const FIXED_SLOTS = ["top", "bottom", "shoes"] as const;
export type FixedSlot = typeof FIXED_SLOTS[number];
export type FixedSize = { system: string; value: string };
export type FixedResources = {
  catalog_version: string;
  inventory_snapshot_id: string;
  look_asset_version: string;
  rule_set_version: string;
  attribute_vocabulary_version: string;
};
export type FixedInventorySnapshot =
  | { recorded: false; inventory_snapshot_id?: string }
  | { recorded: true; inventory_snapshot_id: string; captured_at: string; valid_until: string; sha256: string; is_simulated: true };

export interface FixedOutfitItem {
  sku_id: string;
  product_id: string;
  name: string;
  slot: FixedSlot;
  size: FixedSize;
  price_fen: number;
  is_simulated: true;
  image_url?: string | null;
  image_use_ref?: ProductImageUseRef | null;
}

export interface FixedOutfit {
  contract_version: string;
  tenant_id?: string;
  session_id: string;
  look_id: string;
  look_version_id: string;
  version_no: number;
  parent_look_version_id: string | null;
  restored_from_look_version_id: string | null;
  items: Record<FixedSlot, FixedOutfitItem>;
  sku_ids: string[];
  item_prices_fen: Record<string, number>;
  total_price_fen: number;
  image_url: string;
  image_sha256: string;
  look_asset_version: string;
  model_asset_version: string;
  model_identity_id: string;
  pose_id: string;
  background_id: string;
  view: string;
  resources: FixedResources;
  inventory_snapshot: FixedInventorySnapshot;
  origin: Record<string, unknown>;
  rights_confirmed: true;
  acceptance_status: "accepted_by_user";
  is_simulated: true;
  image_kind: "fixed_model_complete_outfit";
  disclaimer: string;
  created_at: string;
  profile_snapshot?: FixedProfileSnapshot;
  product_image_display?: ProductImageDisplay;
}

export interface FixedCartItem {
  cart_action_id: string;
  sku_id: string;
  product_id: string;
  name: string;
  slot: FixedSlot;
  size: FixedSize;
  quantity: number;
  unit_price_fen: number;
  line_price_fen: number;
  look_version_id: string | null;
  resources: FixedResources;
  is_simulated: true;
}

export interface FixedState {
  [key: string]: unknown;
  session_id: string;
  state_revision: number;
  current_look_version_id: string | null;
  look_version_ids: string[];
}

export interface FixedSession {
  contract_version: string;
  session_id: string;
  state: FixedState;
  history: FixedOutfit[];
  messages: { role: "user" | "assistant"; content: string }[];
  cart: Record<string, unknown>[];
  cart_items: FixedCartItem[];
  events: Record<string, unknown>[];
  conversation_revision: number;
  is_simulated: true;
}

export interface OutfitHealth {
  enabled: boolean;
  ready: boolean;
  assets_ready: boolean;
  model_configured: boolean;
  code: string;
  model?: string;
  mode?: string;
  live_model_verified?: boolean;
  accepted_look_count?: number;
  accepted_asset_version?: string;
  inventory_snapshot_id?: string;
  captured_at?: string;
  valid_until?: string;
  supported_sizes?: Record<FixedSlot, string>;
  minimum_complete_price_fen?: number;
  model_http_attempts?: number;
  model_http_attempt_limit?: number;
  is_simulated?: boolean;
  image_generation?: string;
}

export type ActionIdentity = {
  action_id: string;
  expected_state_revision: number;
  expected_conversation_revision: number;
  request_conditions?: RequestConditions;
  profile_binding?: ProfileBinding;
};
export type FixedActionRequest = ActionIdentity & (
  | { operation: "view_history" | "restore_history" | "add_bundle_to_cart"; target_look_version_id: string }
  | { operation: "add_item_to_cart"; sku_id: string; quantity?: number; cart_size?: FixedSize }
  | { operation: "remove_item_from_cart"; sku_id: string; target_cart_action_id?: string }
);
export type FixedOutcome = "complete_outfit" | "recommendation" | "refusal" | "clarification" | "no_match" | "action_completed" | "action_failed";
export interface FixedActionResult {
  session_id: string;
  outcome: FixedOutcome;
  outfit: FixedOutfit | null;
  state: FixedState;
  history: FixedOutfit[];
  cart: Record<string, unknown>[];
  cart_items: FixedCartItem[];
  events: Record<string, unknown>[];
  conversation_revision: number;
  decision: { status: string; request_id?: string; [key: string]: unknown };
  response: { text: string; [key: string]: unknown };
  is_simulated: true;
}

export class FixedApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "FixedApiError";
  }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/i.test(v);
const time = (v: unknown): v is string => typeof v === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const nullableId = (v: unknown) => v === null || text(v);
const size = (v: unknown): v is FixedSize => object(v) && text(v.system) && text(v.value);
const resources = (v: unknown): v is FixedResources => object(v) && ["catalog_version", "inventory_snapshot_id", "look_asset_version", "rule_set_version", "attribute_vocabulary_version"].every(k => text(v[k]));
const invalid = () => new FixedApiError(502, "INVALID_FIXED_RESPONSE", "固定搭配数据不完整，请刷新重读；当前方案和草稿已保留。");

function profileSnapshot(v: unknown): v is FixedProfileSnapshot {
  if (!object(v) || v.profile_contract !== "consumer_profile_v1" || v.recorded !== true
    || !Object.keys(v).every(k => ["profile_contract", "recorded", "snapshot_id", "profile_id", "profile_version", "snapshot_digest", "field_sources"].includes(k))
    || !isProfileBinding({ snapshot_id: v.snapshot_id, profile_id: v.profile_id, profile_version: v.profile_version, snapshot_digest: v.snapshot_digest })
    || !object(v.field_sources) || !Object.keys(v.field_sources).every(k => ["usual_sizes.top", "usual_sizes.bottom", "usual_sizes.shoes", "scene", "budget_max_fen"].includes(k))) return false;
  return Object.values(v.field_sources).every(source => ["explicit_text", "explicit_selection", "current_request", "saved_profile"].includes(String(source)));
}

function isSnapshot(v: unknown, binding: string): v is FixedInventorySnapshot {
  if (!object(v)) return false;
  if (v.recorded === false) return v.inventory_snapshot_id === undefined || v.inventory_snapshot_id === binding;
  return v.recorded === true && v.inventory_snapshot_id === binding && time(v.captured_at) && time(v.valid_until)
    && Date.parse(v.valid_until) > Date.parse(v.captured_at) && hash(v.sha256) && v.is_simulated === true;
}

/** Validate the frozen binding. Historical expiry never invalidates a previously recorded picture. */
export function isCompleteOutfit(v: unknown): v is FixedOutfit {
  if (!object(v) || !text(v.contract_version) || !text(v.session_id) || !text(v.look_id) || !text(v.look_version_id)
    || !integer(v.version_no) || v.version_no < 1 || !nullableId(v.parent_look_version_id) || !nullableId(v.restored_from_look_version_id)
    || !object(v.items) || Object.keys(v.items).length !== 3 || !Array.isArray(v.sku_ids) || v.sku_ids.length !== 3
    || !object(v.item_prices_fen) || !integer(v.total_price_fen) || !resources(v.resources)
    || v.image_url !== `/api/v1/outfits/assets/${encodeURIComponent(v.look_id)}` || !hash(v.image_sha256)
    || v.look_asset_version !== v.resources.look_asset_version || !text(v.model_asset_version) || !text(v.model_identity_id)
    || !text(v.pose_id) || !text(v.background_id) || v.view !== "front_full_body" || !object(v.origin)
    || v.rights_confirmed !== true || v.acceptance_status !== "accepted_by_user" || v.is_simulated !== true
    || v.image_kind !== "fixed_model_complete_outfit" || !text(v.disclaimer) || !time(v.created_at)
    || (v.profile_snapshot !== undefined && !profileSnapshot(v.profile_snapshot))
    || !isSnapshot(v.inventory_snapshot, v.resources.inventory_snapshot_id)) return false;
  let total = 0;
  const ids: string[] = [];
  for (const slot of FIXED_SLOTS) {
    const item = v.items[slot];
    if (!object(item) || item.slot !== slot || !text(item.sku_id) || !text(item.product_id) || !text(item.name)
      || !size(item.size) || !integer(item.price_fen) || item.is_simulated !== true
      || v.item_prices_fen[item.sku_id] !== item.price_fen) return false;
    ids.push(item.sku_id);
    total += item.price_fen;
  }
  const skuIds = v.sku_ids;
  return new Set(ids).size === 3 && ids.every((id, index) => skuIds[index] === id) && total === v.total_price_fen;
}

export function parseFixedOutfit(value: unknown): FixedOutfit {
  // Old frozen responses may predate the inventory registration field. Do not borrow today's snapshot.
  const v = object(value) && value.inventory_snapshot === undefined ? { ...value, inventory_snapshot: { recorded: false } } : value;
  if (!isCompleteOutfit(v)) throw invalid();
  return normalizeProductImageFields(v);
}

function parseCartItem(v: unknown): FixedCartItem {
  if (!object(v) || !text(v.cart_action_id) || !text(v.sku_id) || !text(v.product_id) || !text(v.name)
    || !FIXED_SLOTS.includes(v.slot as FixedSlot) || !size(v.size) || !integer(v.quantity) || v.quantity < 1
    || !integer(v.unit_price_fen) || !integer(v.line_price_fen) || v.line_price_fen !== v.quantity * v.unit_price_fen
    || !nullableId(v.look_version_id) || !resources(v.resources) || v.is_simulated !== true) throw invalid();
  return v as unknown as FixedCartItem;
}

function parseCommon(value: unknown): Record<string, unknown> & { history: FixedOutfit[]; cart_items: FixedCartItem[] } {
  if (!object(value) || !text(value.session_id) || !object(value.state) || !text(value.state.session_id)
    || value.state.session_id !== value.session_id || !integer(value.state.state_revision)
    || !nullableId(value.state.current_look_version_id) || !Array.isArray(value.state.look_version_ids)
    || !value.state.look_version_ids.every(text) || !integer(value.conversation_revision)
    || !Array.isArray(value.history) || !Array.isArray(value.cart_items) || !Array.isArray(value.cart) || !value.cart.every(object)
    || !Array.isArray(value.events) || !value.events.every(object) || value.is_simulated !== true) throw invalid();
  const history = value.history.map(parseFixedOutfit);
  const ids = history.map(v => v.look_version_id);
  if (new Set(ids).size !== ids.length || history.some(v => v.session_id !== value.session_id)
    || value.state.look_version_ids.some(id => !ids.includes(id))
    || (value.state.current_look_version_id !== null && !ids.includes(value.state.current_look_version_id))) throw invalid();
  return { ...value, history, cart_items: value.cart_items.map(parseCartItem) };
}

export function parseFixedSession(value: unknown): FixedSession {
  const v = parseCommon(value);
  if (!text(v.contract_version) || !Array.isArray(v.messages)
    || !v.messages.every(m => object(m) && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")) throw invalid();
  return v as unknown as FixedSession;
}

const outcomes: readonly string[] = ["complete_outfit", "recommendation", "refusal", "clarification", "no_match", "action_completed", "action_failed"];
export function parseFixedActionResult(value: unknown): FixedActionResult {
  const v = parseCommon(value);
  if (typeof v.outcome !== "string" || !outcomes.includes(v.outcome) || !object(v.decision) || !text(v.decision.status)
    || !object(v.response) || typeof v.response.text !== "string") throw invalid();
  const outfit = v.outfit == null ? null : parseFixedOutfit(v.outfit);
  if ((v.outcome === "complete_outfit" && !outfit) || (outfit && !v.history.some(item => item.look_version_id === outfit.look_version_id))) throw invalid();
  return { ...v, outfit } as unknown as FixedActionResult;
}

export function fixedErrorMessage(code: string, status = 0): string {
  if (code.startsWith("PROFILE_")) return profileErrorMessage(code, status);
  const messages: Record<string, string> = {
    STATE_REVISION_CONFLICT: "会话已变化，请先重读最新状态，再决定是否重新操作。",
    IDEMPOTENCY_CONFLICT: "操作编号已用于不同内容，请先重读原操作结果。",
    REQUEST_IN_PROGRESS: "这次操作仍在处理中，请先查询原操作状态。",
    INVENTORY_SNAPSHOT_STALE: "模拟库存快照已过期，暂不能恢复或加购；历史方案仍可查看。",
    MODEL_CALL_BUDGET_EXHAUSTED: "本轮模型调用额度已用尽；可以继续查看已有搭配与历史。",
    CATALOG_REFERENCE_UNSUPPORTED: "你引用的是 P 编号灵感商品，当前固定搭配服务使用独立的 M1V2 商品目录。需求已保留，请调整后再发送。",
    NO_API_KEY: "当前搭配服务暂未就绪，无法生成方案。需求已保留，可稍后再试。",
    GENERATION_INTERRUPTED: "本次请求处理被中断，请先查看固定搭配历史，核对是否已保存版本。需求已保留。",
    CLIENT_DISCONNECTED: "连接中断，本次生成未完成。需求已保留。",
    REFERENCE_NOT_FOUND: "所选商品或搭配已不可用，请先重读最新状态。",
    CART_ITEM_NOT_FOUND: "这项模拟加购已不存在，请刷新购物袋。",
  };
  return messages[code] || (status === 409 ? "操作状态发生冲突，请先重读最新记录；不会自动重新执行。" : "当前服务暂时无法完成请求，请稍后重读。需求和已有方案已保留。");
}

export async function fixedResponseError(response: Response): Promise<FixedApiError> {
  const data: unknown = await response.json().catch(() => null);
  const code = object(data) && object(data.error) && typeof data.error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.error.code)
    ? data.error.code : response.status === 409 ? "CONFLICT" : "HTTP_ERROR";
  return new FixedApiError(response.status, code, fixedErrorMessage(code, response.status));
}

export async function fetchFixedSession(sessionId: string): Promise<FixedSession | null> {
  const response = await fetch(appPath(`/api/v1/outfits/sessions/${encodeURIComponent(sessionId)}`), { credentials: "same-origin", cache: "no-store" });
  if (response.status === 404) { const error = await fixedResponseError(response); if (error.code.startsWith("PROFILE_")) throw error; return null; }
  if (!response.ok) throw await fixedResponseError(response);
  return parseFixedSession(await response.json());
}

export async function fetchOutfitHealth(): Promise<OutfitHealth> {
  const response = await fetch(appPath("/api/v1/outfits/health"));
  if (!response.ok && response.status !== 503) throw await fixedResponseError(response);
  const v: unknown = await response.json();
  if (!object(v) || ![v.enabled, v.ready, v.assets_ready, v.model_configured].every(x => typeof x === "boolean") || !text(v.code)) throw invalid();
  if (v.ready && (!integer(v.minimum_complete_price_fen) || !integer(v.model_http_attempts) || !integer(v.model_http_attempt_limit)
    || !integer(v.accepted_look_count) || !time(v.captured_at) || !time(v.valid_until)
    || !object(v.supported_sizes) || !FIXED_SLOTS.every(slot => text((v.supported_sizes as Record<string, unknown>)[slot])))) throw invalid();
  if (response.status === 503 && v.ready) throw invalid();
  return v as unknown as OutfitHealth;
}

/** One user action, one immutable body. Callers retain it for an explicit transport retry. */
export async function postFixedAction(sessionId: string, body: FixedActionRequest): Promise<FixedActionResult> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(body.action_id) || !integer(body.expected_state_revision) || !integer(body.expected_conversation_revision)) {
    throw new FixedApiError(400, "INVALID_ACTION", "操作身份不完整，请刷新重读后再操作。");
  }
  if ((body.profile_binding !== undefined && !isProfileBinding(body.profile_binding)) || (body.request_conditions !== undefined && !isRequestConditions(body.request_conditions))) {
    throw new FixedApiError(422, "PROFILE_BINDING_INVALID", "资料绑定或本次条件无效，请保留原操作后重新确认。");
  }
  const response = await fetch(appPath(`/api/v1/outfits/sessions/${encodeURIComponent(sessionId)}/actions`), {
    method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw await fixedResponseError(response);
  return parseFixedActionResult(await response.json());
}

export function formatFen(fen: number): string {
  if (!integer(fen)) return "价格未记录";
  return `¥${(fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: fen % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
