import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFixedSession } from "../components/use-fixed-session";
import { FixedApiError, type FixedActionResult, type FixedSession } from "../app/lib/fixed-outfits";
import { ProfileApiError } from "../app/lib/consumer-profile";

const mocks = vi.hoisted(() => ({ read: vi.fn(), health: vi.fn(), action: vi.fn(), prepare: vi.fn() }));
vi.mock("../app/lib/fixed-outfits", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/fixed-outfits")>(),
  fetchFixedSession: mocks.read, fetchOutfitHealth: mocks.health, postFixedAction: mocks.action,
}));
vi.mock("../app/lib/consumer-profile", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/consumer-profile")>(), prepareConsumerProfile: mocks.prepare,
}));

const resources = { catalog_version: "fixture-catalog", inventory_snapshot_id: "fixture-inventory", look_asset_version: "fixture-assets", rule_set_version: "fixture-rules", attribute_vocabulary_version: "fixture-vocab" };
function saved(sessionId = "fixed-a", withCart = true): FixedSession {
  return {
    contract_version: "0.1.0", session_id: sessionId, is_simulated: true,
    state: { session_id: sessionId, state_revision: 2, current_look_version_id: null, look_version_ids: [] },
    history: [], messages: [], cart: [], events: [], conversation_revision: 4,
    cart_items: withCart ? [{ cart_action_id: "cart-original", sku_id: "M1-top-M", product_id: "M1-product-top", name: "模拟上衣", slot: "top", size: { system: "clothing_alpha", value: "M" }, quantity: 2, unit_price_fen: 24900, line_price_fen: 49800, look_version_id: null, resources, is_simulated: true }] : [],
  };
}
function completed(session = saved("fixed-a", false)): FixedActionResult {
  return { ...session, outfit: null, outcome: "action_completed", decision: { status: "action_completed" }, response: { text: "已取消这项模拟加购" } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const remove = { operation: "remove_item_from_cart" as const, sku_id: "M1-top-M", target_cart_action_id: "cart-original" };
const profileBinding = { snapshot_id: "ps-synthetic-action", profile_id: "profile-synthetic", profile_version: 2, snapshot_digest: "a".repeat(64) };
const restore = { operation: "restore_history" as const, target_look_version_id: "lv-1", request_conditions: { budget_max_fen: 80000 } };

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  mocks.read.mockReset(); mocks.action.mockReset(); mocks.health.mockReset(); mocks.prepare.mockReset();
  mocks.prepare.mockResolvedValue({ profile_binding: profileBinding });
  mocks.read.mockResolvedValue(saved());
  mocks.health.mockResolvedValue({ enabled: true, ready: false, assets_ready: true, model_configured: false, code: "MODEL_NOT_CONFIGURED" });
});

describe("fixed-session actions preserve server authority", () => {
  it("409 re-reads state, retains no automatic retry, and never repeats the mutation", async () => {
    const latest = { ...saved(), conversation_revision: 9 };
    const latestHealth = { enabled: true, ready: false, assets_ready: true, model_configured: true, code: "MODEL_CALL_BUDGET_EXHAUSTED", model_http_attempts: 12, model_http_attempt_limit: 12 };
    mocks.health.mockResolvedValueOnce({ enabled: true, ready: true, assets_ready: true, model_configured: true, code: "OK", model_http_attempts: 10, model_http_attempt_limit: 12 }).mockResolvedValueOnce(latestHealth);
    mocks.read.mockResolvedValueOnce(saved()).mockResolvedValueOnce(latest);
    mocks.action.mockRejectedValue(new FixedApiError(409, "STATE_REVISION_CONFLICT", "会话版本变化"));
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => { await result.current.perform(remove); });
    expect(mocks.action).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(result.current.session?.conversation_revision).toBe(9);
    expect(result.current.health).toEqual(latestHealth);
    expect(result.current.session?.cart_items).toEqual(latest.cart_items);
    expect(result.current.retryAction).toBeNull();
    expect(result.current.error).toContain("不会自动重做");
    await act(async () => { await result.current.retry(); });
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });

  it("an explicit transport retry reuses the entire original body including identity and both revisions", async () => {
    mocks.action.mockRejectedValueOnce(new TypeError("connection lost")).mockResolvedValueOnce(completed());
    mocks.read.mockResolvedValueOnce(saved()).mockResolvedValueOnce(saved()).mockResolvedValueOnce(saved("fixed-a", false));
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => { await result.current.perform(remove); });
    const body = mocks.action.mock.calls[0][1];
    expect(body).toMatchObject({ ...remove, action_id: expect.any(String), expected_state_revision: 2, expected_conversation_revision: 4 });
    expect(result.current.retryAction).toEqual(body);
    expect(result.current.session?.cart_items).toHaveLength(1);
    await act(async () => { await result.current.perform({ operation: "add_item_to_cart", sku_id: "different" }); });
    expect(mocks.action).toHaveBeenCalledTimes(1); // Unresolved mutation blocks another new mutation.
    await act(async () => { await result.current.retry(); });
    expect(mocks.action.mock.calls[1]).toEqual(["product-a", body]);
    expect(result.current.retryAction).toBeNull();
    expect(result.current.session?.cart_items).toHaveLength(0);
    expect(result.current.notice).toContain("不产生订单");
  });

  it("a pending or rejected removal never optimistically removes its frozen cart row", async () => {
    const request = deferred<FixedActionResult>(); mocks.action.mockReturnValue(request.promise);
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    let task!: Promise<FixedActionResult | null>;
    act(() => { task = result.current.perform(remove); });
    expect(result.current.pending).toBe(true);
    expect(result.current.session?.cart_items).toEqual(saved().cart_items);
    await act(async () => { await result.current.perform(remove); });
    expect(mocks.action).toHaveBeenCalledTimes(1);
    await act(async () => { request.reject(new FixedApiError(422, "REFERENCE_NOT_FOUND", "所选加购对象不可用")); await task; });
    expect(result.current.pending).toBe(false);
    expect(result.current.session?.cart_items).toEqual(saved().cart_items);
    expect(result.current.error).toBe("所选加购对象不可用");
    expect(result.current.notice).toBe("");
  });

  it("HTTP200 action_failed remains a failure and does not show a successful cart notice", async () => {
    mocks.action.mockResolvedValue({ ...completed(saved()), outcome: "action_failed", decision: { status: "action_failed" }, response: { text: "库存不足，未加购" } });
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => { await result.current.perform({ operation: "add_item_to_cart", sku_id: "M1-top-M" }); });
    expect(result.current.error).toBe("库存不足，未加购");
    expect(result.current.notice).toBe("");
    expect(result.current.session?.cart_items).toEqual(saved().cart_items);
  });

  it("a late initial read cannot replace a newly selected session", async () => {
    const initial = deferred<FixedSession>();
    mocks.read.mockImplementation((id: string) => id === "product-a" ? initial.promise : Promise.resolve(saved("fixed-b", false)));
    const { result, rerender } = renderHook(({ id }) => useFixedSession(id), { initialProps: { id: "product-a" } });
    rerender({ id: "product-b" });
    await waitFor(() => expect(result.current.session?.session_id).toBe("fixed-b"));
    await act(async () => { initial.resolve(saved("fixed-a")); await initial.promise; });
    expect(result.current.session?.session_id).toBe("fixed-b");
    expect(result.current.session?.cart_items).toHaveLength(0);
    expect(result.current.error).toBe("");
  });

  it("a late old-session mutation cannot refresh or overwrite the newly selected session", async () => {
    const request = deferred<FixedActionResult>();
    mocks.action.mockReturnValue(request.promise);
    mocks.read.mockImplementation((id: string) => Promise.resolve(saved(id === "product-a" ? "fixed-a" : "fixed-b", id === "product-a")));
    const { result, rerender } = renderHook(({ id }) => useFixedSession(id), { initialProps: { id: "product-a" } });
    await waitFor(() => expect(result.current.session?.session_id).toBe("fixed-a"));
    let task!: Promise<FixedActionResult | null>;
    act(() => { task = result.current.perform(remove); });
    rerender({ id: "product-b" });
    await waitFor(() => expect(result.current.session?.session_id).toBe("fixed-b"));
    await act(async () => { request.resolve(completed()); await task; });
    expect(result.current.session?.session_id).toBe("fixed-b");
    expect(result.current.pending).toBe(false);
    expect(result.current.notice).toBe("");
    expect(result.current.retryAction).toBeNull();
    expect(mocks.read.mock.calls).toEqual([["product-a"], ["product-b"]]);
  });

  it("an older read failure cannot erase the outcome of a newer successful refresh", async () => {
    const initial = deferred<FixedSession>();
    const latest = { ...saved(), conversation_revision: 8 };
    mocks.read.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(latest);
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.session?.conversation_revision).toBe(8);
    await act(async () => { initial.reject(new TypeError("older read failed")); await initial.promise.catch(() => null); });
    expect(result.current.session?.conversation_revision).toBe(8);
    expect(result.current.error).toBe("");
  });

  it("the latest refresh failure clears loading even after invalidating a still-pending initial read", async () => {
    const initial = deferred<FixedSession>();
    mocks.read.mockReturnValueOnce(initial.promise).mockRejectedValueOnce(new TypeError("current refresh failed"));
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.loading).toBe(true));
    await act(async () => { await expect(result.current.refresh()).rejects.toThrow("current refresh failed"); });
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toBeNull();
    await act(async () => { initial.resolve(saved()); await initial.promise; });
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toBeNull(); // The invalidated older read cannot become the current result.
  });

  it("refresh restores an unresolved action identity and only an explicit retry posts the original body", async () => {
    mocks.action.mockRejectedValueOnce(new TypeError("connection dropped"));
    const first = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(first.result.current.session).not.toBeNull());
    await act(async () => { await first.result.current.perform(remove); });
    const originalBody = mocks.action.mock.calls[0][1];
    expect(JSON.parse(sessionStorage.getItem("styling.pending-action.v1:product-a")!)).toEqual(originalBody);
    first.unmount();
    const refreshed = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(refreshed.result.current.retryAction).toEqual(originalBody));
    expect(mocks.action).toHaveBeenCalledTimes(1); // No mutation on mount.
    mocks.action.mockResolvedValueOnce(completed());
    mocks.read.mockResolvedValueOnce(saved()).mockResolvedValueOnce(saved("fixed-a", false));
    await act(async () => { await refreshed.result.current.retry(); });
    expect(mocks.action.mock.calls[1]).toEqual(["product-a", originalBody]);
    expect(sessionStorage.getItem("styling.pending-action.v1:product-a")).toBeNull();
    expect(refreshed.result.current.session?.cart_items).toHaveLength(0);
  });

  it("an HTTP500 keeps the same pending identity and never clears the old cart snapshot", async () => {
    mocks.action.mockRejectedValueOnce(new FixedApiError(502, "HTTP_ERROR", "服务暂时不可读"));
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => { await result.current.perform(remove); });
    expect(result.current.retryAction).toEqual(mocks.action.mock.calls[0][1]);
    expect(JSON.parse(sessionStorage.getItem("styling.pending-action.v1:product-a")!)).toEqual(result.current.retryAction);
    expect(result.current.session?.cart_items).toEqual(saved().cart_items);
    expect(result.current.notice).toBe("");
  });

  it("new restores prepare the original action identity then persist binding before POST", async () => {
    mocks.action.mockImplementation(async (_sid, body) => {
      expect(JSON.parse(sessionStorage.getItem("styling.pending-action.v1:product-a")!)).toEqual(body);
      return { ...completed(), outcome: "no_match", response: { text: "当前固定图未覆盖，不恢复旧图冒充成功" } };
    });
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => { await result.current.perform(restore); });
    const prepared = mocks.prepare.mock.calls[0][0], body = mocks.action.mock.calls[0][1];
    expect(prepared.operation).toBe("restore");
    expect(prepared.session_id).toBe("product-a");
    expect(prepared.request_id).toBe(body.action_id);
    expect(prepared.request_body).toEqual({ ...restore, action_id: body.action_id, expected_state_revision: 2, expected_conversation_revision: 4 });
    expect(prepared.request_body).not.toHaveProperty("profile_binding");
    expect(body.profile_binding).toEqual(profileBinding);
    expect(result.current.error).toContain("不恢复旧图冒充成功");
    expect(result.current.notice).toBe("");
  });

  it("a lost prepare response retains raw body and explicit retry repeats the same prepare ID and conditions", async () => {
    mocks.prepare.mockRejectedValueOnce(new TypeError("prepare transport lost")).mockResolvedValueOnce({ profile_binding: profileBinding });
    mocks.action.mockResolvedValueOnce(completed());
    const { result } = renderHook(() => useFixedSession("product-a", profileBinding));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    const input = { ...restore, request_conditions: { budget_max_fen: 80000 } };
    await act(async () => { await result.current.perform(input); });
    expect(mocks.action).not.toHaveBeenCalled();
    const raw = mocks.prepare.mock.calls[0][0];
    expect(result.current.retryAction).toEqual(raw.request_body);
    expect(JSON.parse(sessionStorage.getItem("styling.pending-action-owner.v1:product-a")!)).toEqual({ action_id: raw.request_id, profile_id: profileBinding.profile_id, profile_version: 2 });
    input.request_conditions.budget_max_fen = 150000;
    await act(async () => { await result.current.retry(); });
    expect(mocks.prepare.mock.calls[1][0]).toEqual(raw);
    expect(mocks.action.mock.calls[0][1].request_conditions.budget_max_fen).toBe(80000);
    expect(mocks.action.mock.calls[0][1].profile_binding).toEqual(profileBinding);
    expect(mocks.action.mock.calls[0][1]).not.toHaveProperty("profile_version");
    expect(sessionStorage.getItem("styling.pending-action-owner.v1:product-a")).toBeNull();
  });

  it("an unbound restore after refresh accepts the original prepared version without replacing its first marker", async () => {
    mocks.prepare.mockRejectedValueOnce(new TypeError("prepared response lost")).mockImplementationOnce(async () => {
      expect(JSON.parse(sessionStorage.getItem("styling.pending-action-owner.v1:product-a")!).profile_version).toBe(2);
      return { profile_binding: profileBinding };
    });
    mocks.action.mockResolvedValueOnce(completed());
    const first = renderHook(() => useFixedSession("product-a", profileBinding));
    await waitFor(() => expect(first.result.current.session).not.toBeNull());
    await act(async () => { await first.result.current.perform(restore); });
    const original = first.result.current.retryAction;
    first.unmount();
    const next = renderHook(() => useFixedSession("product-a", { ...profileBinding, profile_version: 3 }));
    await waitFor(() => expect(next.result.current.retryAction).toEqual(original));
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.action).not.toHaveBeenCalled();
    await act(async () => { await next.result.current.retry(); });
    expect(mocks.prepare.mock.calls[1][0]).toEqual(mocks.prepare.mock.calls[0][0]);
    expect(mocks.action).toHaveBeenCalledWith("product-a", { ...original, profile_binding: profileBinding });
    expect(next.result.current.requestBlock).toBeNull();
  });

  it.each(["version", "owner", "unrecorded"])("an unbound restore with changed or unknown original %s saves the returned binding but requires explicit confirmation", async kind => {
    const firstProfile = kind === "unrecorded" ? null : profileBinding;
    const nextProfile = kind === "version" ? { ...profileBinding, profile_version: 3 } : kind === "owner" ? { ...profileBinding, profile_id: "profile-changed" } : profileBinding;
    const returnedBinding = { ...profileBinding, profile_id: nextProfile.profile_id, profile_version: nextProfile.profile_version };
    mocks.prepare.mockRejectedValueOnce(new TypeError("first prepare never reached server")).mockResolvedValueOnce({ profile_binding: returnedBinding });
    const first = renderHook(() => useFixedSession("product-a", firstProfile));
    await waitFor(() => expect(first.result.current.session).not.toBeNull());
    await act(async () => { await first.result.current.perform(restore); });
    const original = first.result.current.retryAction;
    const firstMarker = sessionStorage.getItem("styling.pending-action-owner.v1:product-a");
    first.unmount();
    const next = renderHook(() => useFixedSession("product-a", nextProfile));
    await waitFor(() => expect(next.result.current.retryAction).toEqual(original));
    await act(async () => { await next.result.current.retry(); });
    expect(mocks.prepare.mock.calls[1][0]).toEqual(mocks.prepare.mock.calls[0][0]);
    expect(mocks.action).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("styling.pending-action-owner.v1:product-a")).toBe(firstMarker);
    expect(next.result.current.requestBlock?.code).toBe("PROFILE_PREPARATION_CHANGED");
    expect(next.result.current.retryAction).toEqual({ ...original, profile_binding: returnedBinding });
    expect(JSON.parse(sessionStorage.getItem("styling.pending-action.v1:product-a")!)).toEqual(next.result.current.retryAction);
    expect(next.result.current.error).toContain("重新编辑并确认");
    await act(async () => { await next.result.current.retry(); });
    expect(mocks.prepare).toHaveBeenCalledTimes(2); expect(mocks.action).not.toHaveBeenCalled();
    act(() => { expect(next.result.current.confirmNewAction()).toBe(true); });
    expect(sessionStorage.getItem("styling.pending-action-owner.v1:product-a")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("styling.action-archive.v1:product-a")!)[0].body).toEqual({ ...original, profile_binding: returnedBinding });
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("a bound restore rejected with 429 retries its unchanged body despite a later profile update", async () => {
    mocks.action.mockRejectedValueOnce(new FixedApiError(429, "RATE_LIMITED", "请稍后重试")).mockResolvedValueOnce(completed());
    const { result, rerender } = renderHook(({ version }) => useFixedSession("product-a", { ...profileBinding, profile_version: version }), { initialProps: { version: 2 } });
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => { await result.current.perform(restore); });
    const original = mocks.action.mock.calls[0][1];
    expect(original.profile_binding).toEqual(profileBinding);
    rerender({ version: 3 });
    await act(async () => { await result.current.retry(); });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.action.mock.calls[1]).toEqual(["product-a", original]);
    expect(result.current.requestBlock).toBeNull();
    expect(sessionStorage.getItem("styling.pending-action-owner.v1:product-a")).toBeNull();
  });

  it("a bound restore survives refresh and retries without another prepare or replacing its frozen conditions", async () => {
    mocks.action.mockRejectedValueOnce(new TypeError("action response lost"));
    const first = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(first.result.current.session).not.toBeNull());
    await act(async () => { await first.result.current.perform(restore); });
    const body = mocks.action.mock.calls[0][1];
    first.unmount();
    const next = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(next.result.current.retryAction?.profile_binding).toEqual(profileBinding));
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.action).toHaveBeenCalledTimes(1);
    mocks.action.mockResolvedValueOnce(completed());
    await act(async () => { await next.result.current.retry(); });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.action.mock.calls[1]).toEqual(["product-a", body]);
  });

  it.each(["PROFILE_CLEARED", "PROFILE_SNAPSHOT_EXPIRED", "PROFILE_SESSION_RESTART_REQUIRED"])("%s blocks retry, preserves original, and only explicit confirmation archives it", async code => {
    mocks.prepare.mockRejectedValueOnce(new ProfileApiError(409, code, "原资料准备不可继续，请重新确认"));
    const first = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(first.result.current.session).not.toBeNull());
    await act(async () => { await first.result.current.perform(restore); });
    const body = first.result.current.retryAction;
    expect(first.result.current.requestBlock?.code).toBe(code);
    first.unmount();
    const next = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(next.result.current.requestBlock?.code).toBe(code));
    await act(async () => { await next.result.current.retry(); });
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.action).not.toHaveBeenCalled();
    act(() => { expect(next.result.current.confirmNewAction()).toBe(true); });
    expect(next.result.current.retryAction).toBeNull(); expect(next.result.current.requestBlock).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("styling.action-archive.v1:product-a")!)[0].body).toEqual(body);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("PROFILE errors returned by actions preserve the prepared binding instead of falling through generic409", async () => {
    mocks.action.mockRejectedValueOnce(new FixedApiError(409, "PROFILE_CLEARED", "原准备因资料清除失效"));
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => { await result.current.perform(restore); });
    expect(result.current.requestBlock?.code).toBe("PROFILE_CLEARED");
    expect(result.current.retryAction?.profile_binding).toEqual(profileBinding);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(result.current.error).toContain("清除失效");
  });

  it("legacy pending restore without request_conditions remains compatible and never invents a binding", async () => {
    const legacy = { operation: "restore_history", target_look_version_id: "lv-1", action_id: "legacy-pending", expected_state_revision: 2, expected_conversation_revision: 4 };
    sessionStorage.setItem("styling.pending-action.v1:product-a", JSON.stringify(legacy));
    mocks.action.mockResolvedValueOnce(completed());
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.retryAction).toEqual(legacy));
    await act(async () => { await result.current.retry(); });
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.action.mock.calls[0]).toEqual(["product-a", legacy]);
  });

  it("a late preparation cannot submit an old restore after the user switches sessions", async () => {
    const waiting = deferred<{ profile_binding: typeof profileBinding }>(); mocks.prepare.mockReturnValueOnce(waiting.promise);
    const { result, rerender } = renderHook(({ id }) => useFixedSession(id), { initialProps: { id: "product-a" } });
    await waitFor(() => expect(result.current.session).not.toBeNull());
    let task!: Promise<FixedActionResult | null>;
    act(() => { task = result.current.perform(restore); });
    rerender({ id: "product-b" });
    await act(async () => { waiting.resolve({ profile_binding: profileBinding }); await task; });
    expect(mocks.action).not.toHaveBeenCalled(); expect(result.current.retryAction).toBeNull();
  });

  it.each(["missing", "forbidden"])("%s session hides cached pending body and cannot replay it under another owner", async kind => {
    const original = { ...restore, action_id: "private-old-action", expected_state_revision: 2, expected_conversation_revision: 4, profile_binding: profileBinding };
    sessionStorage.setItem("styling.pending-action.v1:product-a", JSON.stringify(original));
    if (kind === "missing") mocks.read.mockResolvedValueOnce(null);
    else mocks.read.mockRejectedValueOnce(new FixedApiError(404, "PROFILE_SCOPE_FORBIDDEN", "当前资料空间不可读"));
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.retry(); });
    expect(result.current.retryAction).toBeNull(); expect(result.current.requestBlock).toBeNull();
    expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem("styling.pending-action.v1:product-a")!)).toEqual(original);
  });

  it("cached pending body is shown only after successful current-session read", async () => {
    const original = { ...restore, action_id: "private-old-action", expected_state_revision: 2, expected_conversation_revision: 4, profile_binding: profileBinding };
    sessionStorage.setItem("styling.pending-action.v1:product-a", JSON.stringify(original));
    const reading = deferred<FixedSession>(); mocks.read.mockReturnValueOnce(reading.promise);
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.retryAction).toBeNull();
    await act(async () => { reading.resolve(saved()); await reading.promise; });
    expect(result.current.retryAction).toEqual(original);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("explicit retry first confirms current session authority and never POSTs when ownership is gone", async () => {
    mocks.action.mockRejectedValueOnce(new TypeError("action response lost"));
    const { result } = renderHook(() => useFixedSession("product-a"));
    await waitFor(() => expect(result.current.session).not.toBeNull());
    await act(async () => { await result.current.perform(restore); });
    const original = result.current.retryAction;
    mocks.read.mockRejectedValueOnce(new FixedApiError(404, "PROFILE_SCOPE_FORBIDDEN", "当前资料空间不可读"));
    await act(async () => { await result.current.retry(); });
    expect(mocks.action).toHaveBeenCalledTimes(1); expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(result.current.retryAction).toBeNull(); expect(result.current.session).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("styling.pending-action.v1:product-a")!)).toEqual(original);
  });
});
