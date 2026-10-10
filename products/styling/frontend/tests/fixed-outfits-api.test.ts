import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFixedSession, fetchOutfitHealth, formatFen, isCompleteOutfit, parseFixedActionResult,
  parseFixedOutfit, parseFixedSession, postFixedAction, type FixedActionRequest,
} from "../app/lib/fixed-outfits";
import {
  createChatRequest, fetchGenerationRequest, fetchSavedSessionIndex, generationRequestEvent, getSessionId,
  selectSavedSession, sendPreparedChat, streamChat, type ChatEvent, type GenerationRequest,
} from "../app/lib/api";

import { binding, outfit, session, result } from "./fixed-outfit-fixtures";

function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function sse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }));
}
const prepared = { session_id: "product-session", request_id: "stable-request", message: "预算800元，通勤", budget: "", scene: "" } as const;
const done = () => ({ ...prepared, content: "已选择固定搭配", product_ids: ["M1-product-top"], fixed_session_id: "fixed-session", state_revision: 1, conversation_revision: 2, outfit: outfit(), outcome: "complete_outfit" });
function generation(status: GenerationRequest["status"] = "succeeded"): GenerationRequest {
  return {
    recorded: true, request_id: prepared.request_id, session_id: prepared.session_id, status,
    outcome: status === "succeeded" ? "complete_outfit" : null, error_code: status === "failed" ? "MODEL_TIMEOUT" : null,
    result: status === "succeeded" ? done() : null, effective_outfit: status === "succeeded",
  };
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("frozen fixed outfit bindings", () => {
  it("keeps only the frozen profile binding/source metadata, with no backfill for old looks", () => {
    const summary = { profile_contract: "consumer_profile_v1", recorded: true, snapshot_id: "ps-look", profile_id: "profile-look", profile_version: 2, snapshot_digest: "a".repeat(64), field_sources: { "usual_sizes.top": "saved_profile", budget_max_fen: "explicit_text" } };
    expect(parseFixedOutfit({ ...outfit(), profile_snapshot: summary }).profile_snapshot).toEqual(summary);
    expect(parseFixedOutfit(outfit()).profile_snapshot).toBeUndefined();
    expect(() => parseFixedOutfit({ ...outfit(), profile_snapshot: { ...summary, height_cm: 165 } })).toThrow();
    expect(() => parseFixedOutfit({ ...outfit(), profile_snapshot: { ...summary, snapshot_digest: "A".repeat(64) } })).toThrow();
    expect(() => parseFixedOutfit({ ...outfit(), profile_snapshot: { ...summary, field_sources: { height_cm: "saved_profile" } } })).toThrow();
    expect(() => parseFixedOutfit({ ...outfit(), profile_snapshot: { ...summary, field_sources: { scene: "guessed" } } })).toThrow();
  });

  it("private-session ownership404 remains an error, not a legacy empty session", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: "PROFILE_SCOPE_FORBIDDEN" } }, 404))
      .mockResolvedValueOnce(json({ error: { code: "SESSION_NOT_FOUND" } }, 404));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchFixedSession("private-session")).rejects.toMatchObject({ status: 404, code: "PROFILE_SCOPE_FORBIDDEN" });
    expect(await fetchFixedSession("legacy-missing")).toBeNull();
    expect(fetcher.mock.calls[0][1]?.credentials).toBe("same-origin");
  });

  it("profile restore posts the entire binding and maps clear errors without rewriting identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: "PROFILE_CLEARED" } }, 409));
    vi.stubGlobal("fetch", fetcher);
    const body: FixedActionRequest = { operation: "restore_history", target_look_version_id: "lv-1", action_id: "restore-original", expected_state_revision: 2, expected_conversation_revision: 4,
      request_conditions: { budget_max_fen: 80000 }, profile_binding: { snapshot_id: "ps-look", profile_id: null, profile_version: 0, snapshot_digest: "a".repeat(64) } };
    await expect(postFixedAction("private-session", body)).rejects.toMatchObject({ code: "PROFILE_CLEARED", message: expect.stringContaining("清除失效") });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(body);
    expect(fetcher.mock.calls[0][1]?.credentials).toBe("same-origin");
  });

  it("uses three named slots, integer fen, accepted asset SHA and each version's own historical snapshot", () => {
    const frozen = parseFixedSession(session());
    expect(frozen.history[0].total_price_fen).toBe(79700);
    expect(formatFen(frozen.history[0].total_price_fen)).toBe("¥797");
    expect(formatFen(79701)).toBe("¥797.01");
    expect(frozen.history[0].inventory_snapshot).toEqual(outfit().inventory_snapshot);
    expect(isCompleteOutfit(frozen.history[0])).toBe(true); // Expired historical snapshot stays historical evidence.
    expect(frozen.history[0].items.top.image_url).toBeUndefined(); // No P-product fallback.
  });

  it.each([
    ["wrong slot", (v: ReturnType<typeof outfit>) => { v.items.top.slot = "shoes"; }],
    ["wrong price", (v: ReturnType<typeof outfit>) => { v.total_price_fen = 1; }],
    ["fractional fen", (v: ReturnType<typeof outfit>) => { v.items.top.price_fen = 0.5; }],
    ["bad SHA", (v: ReturnType<typeof outfit>) => { v.image_sha256 = "missing"; }],
    ["candidate image", (v: ReturnType<typeof outfit>) => { v.acceptance_status = "pending"; }],
    ["foreign image URL", (v: ReturnType<typeof outfit>) => { v.image_url = "/product-images/P001.png"; }],
    ["wrong SKU list", (v: ReturnType<typeof outfit>) => { v.sku_ids[1] = "other"; }],
    ["different resource version", (v: ReturnType<typeof outfit>) => { v.resources.look_asset_version = "other"; }],
    ["current inventory pasted on old history", (v: ReturnType<typeof outfit>) => { v.inventory_snapshot.inventory_snapshot_id = "today"; }],
  ])("rejects %s instead of counting it as a complete outfit", (_name, mutate) => {
    const v = outfit(); mutate(v);
    expect(isCompleteOutfit(v)).toBe(false);
    expect(() => parseFixedOutfit(v)).toThrow("固定搭配数据不完整");
  });

  it("marks an old missing snapshot as unrecorded without inventing timestamps", () => {
    const old: Record<string, unknown> = { ...outfit() };
    delete old.inventory_snapshot;
    expect(parseFixedOutfit(old).inventory_snapshot).toEqual({ recorded: false });
  });

  it("rejects a current version that is absent from this session's frozen history", () => {
    const value = session(); value.state.current_look_version_id = "lv-other";
    expect(() => parseFixedSession(value)).toThrow("固定搭配数据不完整");
  });

  it("rejects incomplete success and permits truthful no-match/action failure outcomes", () => {
    expect(() => parseFixedActionResult({ ...result(), outcome: "complete_outfit" })).toThrow();
    expect(parseFixedActionResult({ ...result(), outcome: "no_match" }).outfit).toBeNull();
    expect(parseFixedActionResult({ ...result(), outcome: "action_failed" }).outcome).toBe("action_failed");
  });

  it("keeps frozen single-item cart price, quantity, source version and precise cancellation identity", () => {
    const cart = { cart_action_id: "cart-source", sku_id: "M1-T-M", product_id: "M1-product-top", name: "模拟上衣", slot: "top", size: { system: "clothing_alpha", value: "M" }, quantity: 2, unit_price_fen: 24900, line_price_fen: 49800, look_version_id: null, resources: { ...binding }, is_simulated: true };
    expect(parseFixedSession({ ...session(), cart_items: [cart] }).cart_items).toEqual([cart]);
    expect(() => parseFixedSession({ ...session(), cart_items: [{ ...cart, line_price_fen: 24900 }] })).toThrow();
  });
});

describe("fixed HTTP reads and actions", () => {
  it("only a 404 is a new unmapped session; server failures stay failures", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({ error: { code: "FIXED_DISABLED", message: "private" } }, 503));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchFixedSession("new session")).toBeNull();
    await expect(fetchFixedSession("new session")).rejects.toMatchObject({ status: 503, code: "FIXED_DISABLED" });
    expect(fetcher.mock.calls[0][0]).toBe("/api/v1/outfits/sessions/new%20session");
  });

  it("retains a truthful unhealthy 503 capability response", async () => {
    const health = { enabled: true, ready: false, assets_ready: true, model_configured: true, code: "MODEL_CALL_BUDGET_EXHAUSTED", model_http_attempts: 12, model_http_attempt_limit: 12 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(health, 503)));
    expect(await fetchOutfitHealth()).toEqual(health);
  });

  it("sends one atomic bundle action, reuses exact ID/revisions/body for explicit retries", async () => {
    const fetcher = vi.fn().mockImplementation(async () => json(result())); vi.stubGlobal("fetch", fetcher);
    const body: FixedActionRequest = { action_id: "same-action", operation: "add_bundle_to_cart", target_look_version_id: "lv-1", expected_state_revision: 1, expected_conversation_revision: 2 };
    await postFixedAction("product-session", body);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await postFixedAction("product-session", body);
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body);
  });

  it("returns safe conflict metadata without resubmitting or treating HTTP as business success", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: { code: "STATE_REVISION_CONFLICT", message: "private internal trace" } }, 409));
    vi.stubGlobal("fetch", fetcher);
    await expect(postFixedAction("session", { action_id: "action", operation: "remove_item_from_cart", sku_id: "M1-T-M", target_cart_action_id: "cart-source", expected_state_revision: 1, expected_conversation_revision: 2 })).rejects.toMatchObject({ status: 409, code: "STATE_REVISION_CONFLICT", message: "会话已变化，请先重读最新状态，再决定是否重新操作。" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("stable generation identity and stream recovery", () => {
  it("allocates once per explicit send and preserves all done fields across split CRLF frames", async () => {
    const body = createChatRequest("product-session", "新表达", "", "");
    expect(Object.isFrozen(body)).toBe(true);
    expect(body.request_id).not.toBe(createChatRequest("product-session", "新表达", "", "").request_id);
    const value = { ...done(), request_id: body.request_id };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(["event: done\r", `\ndata: ${JSON.stringify(value)}\r\n\r`, "\n"])));
    const events: ChatEvent[] = [];
    await sendPreparedChat(body, e => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", request_id: body.request_id, outcome: "complete_outfit", fixed_session_id: "fixed-session", state_revision: 1, conversation_revision: 2, outfit: outfit() });
  });

  it("preserves request/session identity on a real error and does not query or resend a known terminal", async () => {
    const value = { request_id: prepared.request_id, session_id: prepared.session_id, error: { code: "CATALOG_REFERENCE_UNSUPPORTED", message: "ignored upstream text" } };
    const fetcher = vi.fn().mockResolvedValue(sse([`event: error\ndata: ${JSON.stringify(value)}\n\n`])); vi.stubGlobal("fetch", fetcher);
    const callback = vi.fn(); await sendPreparedChat(prepared, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ type: "error", request_id: prepared.request_id, session_id: prepared.session_id, error: expect.objectContaining({ code: "CATALOG_REFERENCE_UNSUPPORTED" }) }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("queries a normal EOF lacking done and consumes the persisted result without a second POST", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(sse(['event: chunk\ndata: {"type":"text","content":"半句"}\n\n'])).mockResolvedValueOnce(json(generation()));
    vi.stubGlobal("fetch", fetcher); const events: ChatEvent[] = [];
    await sendPreparedChat(prepared, e => events.push(e));
    expect(fetcher.mock.calls[1][0]).toBe("/api/v1/generation-requests/stable-request?session_id=product-session");
    expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
    expect(events[1]).toMatchObject({ type: "done", content: "已选择固定搭配", request_id: prepared.request_id });
  });

  it("queries after transport rejection and presents a persisted failure rather than a new request", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(json(generation("failed")));
    vi.stubGlobal("fetch", fetcher); const callback = vi.fn(); await sendPreparedChat(prepared, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ type: "error", error: expect.objectContaining({ code: "MODEL_TIMEOUT" }) }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["running", "accepted"] as const)("keeps %s unresolved with the same identity and no automatic resubmission", async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(sse([])).mockResolvedValueOnce(json(generation(status)));
    vi.stubGlobal("fetch", fetcher); const callback = vi.fn();
    await expect(sendPreparedChat(prepared, callback)).rejects.toMatchObject({ name: "ChatRecoveryError", status, request_id: prepared.request_id });
    expect(callback).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not manufacture success for an unknown or old unrecorded request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sse([])).mockResolvedValueOnce(json({}, 404)));
    await expect(sendPreparedChat(prepared, vi.fn())).rejects.toMatchObject({ name: "ChatRecoveryError", status: "unknown" });
    expect(generationRequestEvent({ ...generation(), recorded: false, status: "not_recorded", result: null, outcome: null, effective_outfit: false })).toBeNull();
  });

  it("ignores a terminal from another request and queries the original identity", async () => {
    const wrong = { ...done(), request_id: "other-request" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sse([`event: done\ndata: ${JSON.stringify(wrong)}\n\n`])).mockResolvedValueOnce(json(generation("running"))));
    const callback = vi.fn(); await expect(sendPreparedChat(prepared, callback)).rejects.toMatchObject({ status: "running" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects a status record owned by another session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...generation(), session_id: "foreign" })));
    await expect(fetchGenerationRequest(prepared.session_id, prepared.request_id)).rejects.toMatchObject({ code: "INVALID_GENERATION_RECORD" });
  });

  it("keeps old streamChat callers and optional stable request IDs compatible", async () => {
    const fetcher = vi.fn().mockResolvedValue(sse(['event: done\ndata: {"session_id":"legacy-session","content":"旧文本完成"}\n\n']));
    vi.stubGlobal("fetch", fetcher); const callback = vi.fn();
    await streamChat("legacy-session", "你好", "", "", callback, "stable-legacy");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).request_id).toBe("stable-legacy");
    expect(callback).toHaveBeenCalledWith({ type: "done", session_id: "legacy-session", content: "旧文本完成", signal_id: null });
  });

  it("keeps an explicit HTTP409 unresolved and never silently allocates another ID", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ detail: "duplicate" }, 409)); vi.stubGlobal("fetch", fetcher);
    await expect(sendPreparedChat(prepared, vi.fn())).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("server-backed history index", () => {
  it("makes stored server sessions selectable while preserving the active session and omitting remote content", async () => {
    const current = getSessionId();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ sessions: [{ id: "saved_real_session", createdAt: 123, extra: "not persisted" }] })));
    const rows = await fetchSavedSessionIndex();
    expect(rows).toContainEqual({ id: "saved_real_session", createdAt: 123 });
    expect(getSessionId()).toBe(current);
    expect(localStorage.getItem("styling.sessions.v1")).not.toContain("not persisted");
    expect(selectSavedSession("saved_real_session")).toBe(true);
    expect(getSessionId()).toBe("saved_real_session");
  });

  it("keeps history failures distinct from an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 503)));
    await expect(fetchSavedSessionIndex()).rejects.toThrow("历史会话列表暂时无法加载");
  });
});
