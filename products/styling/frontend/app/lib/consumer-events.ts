import { appPath } from "./app-path";

export type ConsumerPage = "home" | "discover" | "outfit" | "bag" | "history";
export type ConsumerEventName = "page_view" | "product_impression" | "product_detail_open" | "draft_prefill" | "message_submit" | "outfit_displayed" | "history_restore" | "example_exposure";
export type ConsumerEventInput = {
  event_name: ConsumerEventName;
  source_slot: string;
  product_id?: string;
  request_id?: string;
  look_version_id?: string;
  sku_ids?: string[];
  image_loaded?: boolean;
  visible_fraction?: number;
  dwell_ms?: number;
  canvas_visible?: boolean;
};
export type ConsumerEventBody = ConsumerEventInput & {
  schema_version: 1;
  event_id: string;
  session_id: string;
  page_view_id: string;
  page: ConsumerPage;
  occurred_at: string;
};
export type ConsumerEventRecord = { body: ConsumerEventBody; serialized: string; status: "pending" | "failed"; error?: string };
export type ConsumerEventSnapshot = { pageViewId: string; records: readonly ConsumerEventRecord[] };
const INPUT_KEYS = new Set(["event_name", "source_slot", "product_id", "request_id", "look_version_id", "sku_ids", "image_loaded", "visible_fraction", "dwell_ms", "canvas_visible"]);
const COMMON_KEYS = new Set(["schema_version", "event_id", "session_id", "page_view_id", "page", "occurred_at"]);
const EVENT_NAMES = new Set<ConsumerEventName>(["page_view", "product_impression", "product_detail_open", "draft_prefill", "message_submit", "outfit_displayed", "history_restore", "example_exposure"]);
const PAGES = new Set<ConsumerPage>(["home", "discover", "outfit", "bag", "history"]);
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
const storageKey = (sessionId: string) => `styling.consumer-events.v1:${sessionId}`;
export const consumerEventId = () => globalThis.crypto?.randomUUID?.() ?? `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Reject extra properties rather than letting drafts or business-success facts leak into telemetry. */
export function validateConsumerEventInput(input: ConsumerEventInput): void {
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !INPUT_KEYS.has(key))) throw new Error("浏览记录包含不支持的字段。");
  if (!EVENT_NAMES.has(input.event_name) || typeof input.source_slot !== "string" || !IDENTIFIER.test(input.source_slot)) throw new Error("浏览记录类型或来源无效。");
  for (const key of ["product_id", "request_id", "look_version_id"] as const) if (input[key] !== undefined && (typeof input[key] !== "string" || !IDENTIFIER.test(input[key]))) throw new Error("浏览记录标识无效。");
  if (input.sku_ids !== undefined && (!Array.isArray(input.sku_ids) || input.sku_ids.length > 3 || input.sku_ids.some(id => typeof id !== "string" || !IDENTIFIER.test(id)))) throw new Error("浏览记录商品编号无效。");
  for (const key of ["image_loaded", "canvas_visible"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error("浏览记录展示状态无效。");
  if (input.visible_fraction !== undefined && (!Number.isFinite(input.visible_fraction) || input.visible_fraction < 0 || input.visible_fraction > 1)) throw new Error("浏览记录可见比例无效。");
  if (input.dwell_ms !== undefined && (!Number.isInteger(input.dwell_ms) || input.dwell_ms < 0 || input.dwell_ms > 86_400_000)) throw new Error("浏览记录停留时间无效。");
  if ((input.event_name === "product_impression" || input.event_name === "product_detail_open") && !input.product_id) throw new Error("商品浏览记录缺少商品编号。");
  if (input.event_name === "product_impression" && (input.image_loaded !== true || (input.visible_fraction ?? 0) < .5 || (input.dwell_ms ?? 0) < 1000)) throw new Error("商品图片尚未达到曝光条件。");
  if (input.event_name === "message_submit" && !input.request_id) throw new Error("发送浏览记录缺少请求编号。");
  if (input.event_name === "outfit_displayed" && (!input.look_version_id || new Set(input.sku_ids).size !== 3 || input.image_loaded !== true || input.canvas_visible !== true)) throw new Error("搭配画布尚未达到展示条件。");
}

export function validateConsumerEventBody(body: ConsumerEventBody): void {
  if (!body || typeof body !== "object" || Object.keys(body).some(key => !INPUT_KEYS.has(key) && !COMMON_KEYS.has(key))) throw new Error("浏览记录格式无效。");
  const { schema_version, event_id, session_id, page_view_id, page, occurred_at, ...input } = body;
  validateConsumerEventInput(input);
  if (schema_version !== 1 || ![event_id, session_id, page_view_id].every(id => typeof id === "string" && IDENTIFIER.test(id)) || !PAGES.has(page) || typeof occurred_at !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(occurred_at) || !Number.isFinite(Date.parse(occurred_at))) throw new Error("浏览记录公共字段无效。");
}

/** Each transport retry sends the original serialized body, including its timestamp and event ID. */
export class ConsumerEventRecorder {
  private snapshot: ConsumerEventSnapshot = { pageViewId: "", records: [] };
  private listeners = new Set<() => void>();
  private page: ConsumerPage | null = null;
  private active = false;
  private seen = new Map<string, string>();
  private sending = new Set<string>();
  constructor(readonly sessionId: string, private transport: typeof fetch = (...args) => fetch(...args)) {
    if (typeof window === "undefined" || !IDENTIFIER.test(sessionId)) return;
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(sessionId)) ?? "[]");
      if (!Array.isArray(saved)) return;
      const records: ConsumerEventRecord[] = [];
      for (const serialized of saved) {
        if (typeof serialized !== "string") continue;
        try {
          const body = JSON.parse(serialized) as ConsumerEventBody;
          validateConsumerEventBody(body);
          if (body.session_id === sessionId && !records.some(row => row.body.event_id === body.event_id)) records.push({ body, serialized, status: "failed", error: "上次浏览记录尚未确认，可原样重试。" });
        } catch { /* Untrusted browser storage never becomes an outbound event. */ }
      }
      this.snapshot = { pageViewId: "", records };
    } catch { /* Storage can be unavailable; in-memory retry remains possible. */ }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish(records = this.snapshot.records) {
    this.snapshot = { pageViewId: this.snapshot.pageViewId, records };
    try { sessionStorage.setItem(storageKey(this.sessionId), JSON.stringify(records.map(record => record.serialized))); } catch { /* Retain the exact body in memory when storage is restricted. */ }
    this.listeners.forEach(listener => listener());
  }
  enterPage(page: ConsumerPage, active = true) {
    if (!active || !IDENTIFIER.test(this.sessionId)) { this.active = false; this.page = null; if (this.snapshot.pageViewId) { this.snapshot = { ...this.snapshot, pageViewId: "" }; this.publish(); } return; }
    if (this.active && this.page === page) return;
    this.active = true; this.page = page; this.seen.clear();
    this.snapshot = { ...this.snapshot, pageViewId: consumerEventId() };
    this.publish();
    this.emit({ event_name: "page_view", source_slot: "consumer_navigation" }, "page_view");
  }
  emit = (input: ConsumerEventInput, dedupeKey?: string): string | null => {
    validateConsumerEventInput(input);
    if (!this.active || !this.page || !this.snapshot.pageViewId) return null;
    const semanticKey = input.event_name === "product_impression" ? `product:${input.product_id}:${input.source_slot}` : dedupeKey;
    if (semanticKey && this.seen.has(semanticKey)) return this.seen.get(semanticKey)!;
    const body: ConsumerEventBody = { ...input, schema_version: 1, event_id: consumerEventId(), session_id: this.sessionId, page_view_id: this.snapshot.pageViewId, page: this.page, occurred_at: new Date().toISOString() };
    validateConsumerEventBody(body);
    const serialized = JSON.stringify(body);
    // Keep a detached copy so a caller mutating its SKU array cannot alter this event.
    const record: ConsumerEventRecord = { body: JSON.parse(serialized), serialized, status: "pending" };
    if (semanticKey) this.seen.set(semanticKey, body.event_id);
    this.publish([...this.snapshot.records, record]);
    void this.send(body.event_id);
    return body.event_id;
  };
  retry = (eventId: string) => { void this.send(eventId); };
  retryAll = () => { this.snapshot.records.filter(record => record.status === "failed").forEach(record => this.retry(record.body.event_id)); };
  private async send(eventId: string) {
    const record = this.snapshot.records.find(row => row.body.event_id === eventId);
    if (!record || this.sending.has(eventId)) return;
    this.sending.add(eventId);
    this.publish(this.snapshot.records.map(row => row.body.event_id === eventId ? { ...row, status: "pending", error: undefined } : row));
    try {
      const response = await this.transport(appPath("/api/v1/consumer-events"), { method: "POST", headers: { "Content-Type": "application/json" }, body: record.serialized });
      if (!response.ok) throw new Error(response.status === 409 ? "浏览记录编号冲突，原记录已保留，未改写为成功。" : "浏览记录暂未保存，可稍后重试。");
      const receipt: unknown = await response.json();
      if (!receipt || typeof receipt !== "object" || !("event_id" in receipt) || typeof receipt.event_id !== "string" || !IDENTIFIER.test(receipt.event_id) || !("duplicate" in receipt) || typeof receipt.duplicate !== "boolean" || !("source" in receipt) || receipt.source !== "client" || !("is_simulated" in receipt) || receipt.is_simulated !== true || !("data_origin" in receipt) || receipt.data_origin !== "runtime_demo") throw new Error("浏览记录回执无效，原记录已保留。");
      if (receipt.event_id !== eventId && !(receipt.duplicate && record.body.event_name === "product_impression")) throw new Error("浏览记录回执编号不一致，原记录已保留。");
      this.publish(this.snapshot.records.filter(row => row.body.event_id !== eventId));
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith("浏览记录") ? error.message : "浏览记录暂未保存，可稍后重试。";
      this.publish(this.snapshot.records.map(row => row.body.event_id === eventId ? { ...row, status: "failed", error: message } : row));
    } finally { this.sending.delete(eventId); }
  }
}
