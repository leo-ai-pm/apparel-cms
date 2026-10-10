import { getSavedSessions } from "../app/lib/api";

export const emptyConsumerProfile = { profile_contract: "consumer_profile_v1", profile_id: null, profile_version: 0, scope_kind: "device", status: "empty", base_profile: { height_cm: null, weight_kg: null, usual_sizes: { top: null, bottom: null, shoes: null } }, default_budget_fen: null, updated_at: null, expires_at: null, storage_notice: "本设备当前浏览器资料" };
export function preparedProfileFixture(requestId: string, version = 0) {
  const binding = { snapshot_id: `snap-${requestId}`, profile_id: null, profile_version: version, snapshot_digest: "a".repeat(64) };
  return { profile_binding: binding, duplicate: false, snapshot: { ...binding, profile_contract: "consumer_profile_v1", bound_request_id: requestId, base_profile: { usual_sizes: {} }, conditions: {}, field_sources: {}, explicit_overrides: { usual_sizes: {} }, profile_status: "empty", state: "prepared", created_at: "2026-10-10T00:00:00Z", expires_at: "2026-10-11T00:00:00Z", effective_profile_snapshot: null } };
}

/** New independent routes in old P-product/photograph fixtures; no fixed recommendation is invented. */
export function legacyConsumerRoute(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
  const path = new URL(String(input), "http://localhost").pathname;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (path === "/api/v1/consumer-profile") return json(emptyConsumerProfile);
  if (path === "/api/v1/consumer-profile/prepare" && init?.method === "POST") return json(preparedProfileFixture(JSON.parse(String(init.body)).request_id));
  if (path === "/api/v1/outfits/sessions" && init?.method === "POST") {
    const session_id = crypto.randomUUID();
    return json({ contract_version: "0.1.0", session_id, state: { session_id, state_revision: 0, current_look_version_id: null, look_version_ids: [] }, history: [], messages: [], cart: [], cart_items: [], events: [], conversation_revision: 0, is_simulated: true });
  }
  if (path.startsWith("/api/v1/outfits/sessions/")) return json({ error: { code: "SESSION_NOT_FOUND", message: "新会话尚无固定映射" } }, 404);
  if (path === "/api/v1/outfits/health") return json({ enabled: false, ready: false, assets_ready: false, model_configured: false, code: "FIXED_STYLING_DISABLED" }, 503);
  if (path === "/api/v1/sessions") return json({ sessions: getSavedSessions() });
  if (path === "/api/v1/consumer-events" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    return json({ event_id: body.event_id, duplicate: false, source: "client", data_origin: "runtime_demo", is_simulated: true });
  }
}

/** Browsing can emit its whitelist observations, but it must not submit a demand or commerce action. */
export function isBusinessWrite([input, init]: [RequestInfo | URL, RequestInit?]): boolean {
  const path = new URL(String(input), "http://localhost").pathname;
  return Boolean(init?.method && init.method !== "GET" && !["/api/v1/consumer-events", "/api/v1/consumer-profile/prepare", "/api/v1/outfits/sessions"].includes(path));
}
