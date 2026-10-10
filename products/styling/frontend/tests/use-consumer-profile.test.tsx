import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILE_AUTH_CONTEXT_CONTRACT, ProfileApiError, type ProfileMutation, type ProfileMutationReceipt, type SavedConsumerProfile } from "../app/lib/consumer-profile";
import { useConsumerProfile } from "../app/lib/use-consumer-profile";

const api = vi.hoisted(() => ({ initialize: vi.fn(), current: vi.fn(), mutate: vi.fn(), operation: vi.fn() }));
vi.mock("../app/lib/consumer-profile", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/consumer-profile")>(),
  initializeConsumerProfile: api.initialize, fetchConsumerProfile: api.current,
  mutateConsumerProfile: api.mutate, fetchProfileOperation: api.operation,
}));

const empty = (): SavedConsumerProfile => ({ profile_contract: "consumer_profile_v1", profile_id: null, profile_version: 0, scope_kind: "device", status: "empty", base_profile: { height_cm: null, weight_kg: null, usual_sizes: { top: null, bottom: null, shoes: null } }, default_budget_fen: null, updated_at: null, expires_at: null, storage_notice: "测试夹具：本设备当前浏览器" });
const saved = (version = 1, top: "S" | "M" | "L" = "M"): SavedConsumerProfile => ({ ...empty(), profile_id: "profile-1", profile_version: version, status: "saved", base_profile: { ...empty().base_profile, usual_sizes: { top: { system: "clothing_alpha", value: top }, bottom: null, shoes: null } }, updated_at: "2026-10-10T00:00:00+00:00", expires_at: "2027-04-08T00:00:00+00:00" });
const cleared = (version: number): SavedConsumerProfile => ({ ...empty(), profile_id: "profile-1", profile_version: version, status: "cleared" });
function receipt(body: ProfileMutation, version = 1): ProfileMutationReceipt { return { profile_contract: "consumer_profile_v1", profile_action_id: body.profile_action_id, operation: body.operation, profile_id: "profile-1", scope_kind: "device", version_before: version - 1, profile_version: version, profile_status: body.operation === "clear" ? "cleared" : "saved", changed_field_names: [], status: "succeeded", created_at: "2026-10-10T00:00:00+00:00" }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
const withContext = (profile: SavedConsumerProfile, token = "synthetic-token-a", contextId = "synthetic-context-a"): SavedConsumerProfile => ({ ...profile, authorization_context: {
  context_contract: PROFILE_AUTH_CONTEXT_CONTRACT, context_id: contextId, operation_token: token,
  issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(),
} });
const boundMutation = (): ProfileMutation => ({ profile_action_id: "synthetic-old-save", operation: "update", expected_profile_version: 1,
  patch: { default_budget_fen: 50000 }, explicit_save: true, explicit_default_budget: true,
  expected_authorization_context: { context_contract: PROFILE_AUTH_CONTEXT_CONTRACT, context_id: "synthetic-context-a", operation_token: "synthetic-original-token" },
});
function seedBound(body = boundMutation(), extraOwner: Record<string, unknown> = {}) {
  sessionStorage.setItem("styling.pending-profile.v1:/", JSON.stringify({ body, owner: { profile_id: "profile-1", scope_kind: "device", authorization_expires_at: new Date(Date.now() + 600000).toISOString(), ...extraOwner } }));
  return body;
}
beforeEach(() => { sessionStorage.clear(); Object.values(api).forEach(mock => mock.mockReset()); api.initialize.mockResolvedValue(empty()); api.current.mockImplementation(async () => await api.initialize.mock.results.at(-1)?.value ?? empty()); api.operation.mockResolvedValue(null); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });

describe("ACTX 原动作授权上下文（合成接口状态机，非真实服务验收）", () => {
  it("新空资料保存冻结最初GET的三项授权，预检新token不替换原动作", async () => {
    const initial = withContext(empty()); api.initialize.mockResolvedValue(initial);
    api.current.mockResolvedValueOnce(withContext(empty(), "synthetic-new-token")).mockResolvedValueOnce(withContext(saved(1), "synthetic-after-save"));
    api.mutate.mockImplementation(async body => receipt(body, 1));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { expect(await result.current.mutate("save", { default_budget_fen: 80000 }, true)).toBe(true); });
    const body = api.mutate.mock.calls[0][0];
    expect(body.expected_authorization_context).toEqual({ context_contract: PROFILE_AUTH_CONTEXT_CONTRACT, context_id: "synthetic-context-a", operation_token: "synthetic-token-a" });
    expect(body.expected_authorization_context).not.toHaveProperty("expires_at");
    expect(body).not.toHaveProperty("owner"); expect(result.current.profile?.default_budget_fen).toBeNull();
    expect(sessionStorage.getItem("styling.pending-profile.v1:/")).toBeNull();
  });

  it("empty/version0的context在POST前改变也阻止旧patch，保留原操作且不能跨范围查询", async () => {
    api.initialize.mockResolvedValue(withContext(empty()));
    api.current.mockResolvedValue(withContext(empty(), "synthetic-token-b", "synthetic-context-b"));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { expect(await result.current.mutate("save", { default_budget_fen: 80000 }, true)).toBe(false); });
    const original = result.current.pendingMutation;
    expect(original?.patch.default_budget_fen).toBe(80000); expect(result.current.identityRevision).toBe(1);
    expect(result.current.canReplayPending).toBe(false); expect(api.mutate).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.retryMutation()).toBe(false); });
    expect(result.current.pendingMutation).toEqual(original); expect(api.operation).not.toHaveBeenCalled();
    expect(result.current.error).toContain("授权范围已变化");
  });

  it("空资料保存响应丢失后跨刷新按同context恢复，先GET再query404再原token原体POST", async () => {
    api.initialize.mockResolvedValue(withContext(empty())); api.current.mockResolvedValue(withContext(empty(), "synthetic-refresh-token"));
    api.mutate.mockRejectedValueOnce(new TypeError("response lost"));
    const first = renderHook(() => useConsumerProfile()); await waitFor(() => expect(first.result.current.ready).toBe(true));
    await act(async () => { await first.result.current.mutate("save", { default_budget_fen: 50000 }, true); });
    const original = structuredClone(api.mutate.mock.calls[0][0]);
    expect(JSON.parse(sessionStorage.getItem("styling.pending-profile.v1:/")!).body).toEqual(original); first.unmount();
    api.initialize.mockResolvedValue(withContext(empty(), "synthetic-second-init-token"));
    const next = renderHook(() => useConsumerProfile()); await waitFor(() => expect(next.result.current.pendingMutation).toEqual(original));
    expect(next.result.current.canReplayPending).toBe(true);
    api.current.mockResolvedValueOnce(withContext(empty(), "synthetic-retry-read-token")).mockResolvedValueOnce(withContext(saved(1)));
    api.mutate.mockImplementationOnce(async body => receipt(body, 1));
    await act(async () => { expect(await next.result.current.retryMutation()).toBe(true); });
    expect(api.mutate.mock.calls[1][0]).toEqual(original);
    expect(api.current.mock.invocationCallOrder.at(-2)!).toBeLessThan(api.operation.mock.invocationCallOrder.at(-1)!);
    expect(api.operation.mock.invocationCallOrder.at(-1)!).toBeLessThan(api.mutate.mock.invocationCallOrder.at(-1)!);
    expect(next.result.current.pendingMutation).toBeNull();
  });

  it.each(["saved", "cleared"])("原token已过期而动作早已成功时只查回执，随后GET当前%s，不重放patch", async state => {
    const original = seedBound(boundMutation(), { authorization_expires_at: "2020-01-01T00:00:00Z" });
    const current = withContext(state === "cleared" ? cleared(3) : saved(3));
    api.initialize.mockResolvedValue(current); api.current.mockResolvedValue(current); api.operation.mockResolvedValue(receipt(original, 2));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.pendingMutation).toEqual(original));
    expect(result.current.canReplayPending).toBe(false);
    await act(async () => { expect(await result.current.retryMutation()).toBe(true); });
    expect(api.mutate).not.toHaveBeenCalled(); expect(result.current.profile?.status).toBe(state);
    expect(result.current.profile?.default_budget_fen).toBeNull(); expect(result.current.notice).toContain("之后已发生变化");
  });

  it.each(["expired", "cleared", "updated", "invalidated", "unknown-expiry"])("原动作404后%s不能用刚读的新token继续POST", async kind => {
    const metadata = kind === "expired" ? { authorization_expires_at: "2020-01-01T00:00:00Z" } : kind === "invalidated" ? { authorization_blocked: true } : kind === "unknown-expiry" ? { authorization_expires_at: undefined } : {};
    const original = seedBound(boundMutation(), metadata);
    const current = withContext(kind === "cleared" ? cleared(2) : saved(kind === "updated" ? 2 : 1), "synthetic-fresh-token");
    api.initialize.mockResolvedValue(current); api.current.mockResolvedValue(current);
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.pendingMutation).toEqual(original));
    await act(async () => { expect(await result.current.retryMutation()).toBe(false); });
    expect(api.operation).toHaveBeenCalledWith(original.profile_action_id); expect(api.mutate).not.toHaveBeenCalled();
    expect(result.current.pendingMutation).toEqual(original); expect(result.current.canReplayPending).toBe(false);
    expect(JSON.parse(sessionStorage.getItem("styling.pending-profile.v1:/")!).body).toEqual(original);
    expect(result.current.error).not.toContain("synthetic-original-token");
  });

  it("旧无context pending遇到新schema只查原回执，404不补令牌；后来查到成功仍可完成", async () => {
    const original = boundMutation(); delete original.expected_authorization_context; seedBound(original);
    api.initialize.mockResolvedValue(withContext(saved(1))); api.current.mockResolvedValue(withContext(saved(1)));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.pendingMutation).toEqual(original));
    expect(result.current.canReplayPending).toBe(false);
    await act(async () => { expect(await result.current.retryMutation()).toBe(false); });
    expect(api.mutate).not.toHaveBeenCalled(); expect(result.current.error).toContain("未记录保存授权");
    expect(result.current.pendingMutation).not.toHaveProperty("expected_authorization_context");
    api.operation.mockResolvedValue(receipt(original, 2)); api.current.mockResolvedValue(withContext(saved(2)));
    await act(async () => { expect(await result.current.retryMutation()).toBe(true); });
    expect(api.mutate).not.toHaveBeenCalled(); expect(result.current.pendingMutation).toBeNull();
  });

  it.each(["PROFILE_AUTH_CONTEXT_INVALID", "PROFILE_AUTH_CONTEXT_CHANGED", "PROFILE_AUTH_CONTEXT_EXPIRED", "PROFILE_AUTH_CONTEXT_INVALIDATED"])("服务端%s保存原动作并封闭旧写入，显式结束后新保存才取新ID及新授权", async code => {
    api.initialize.mockResolvedValue(withContext(saved(1))); api.current.mockResolvedValue(withContext(saved(1), "synthetic-new-token"));
    api.mutate.mockRejectedValueOnce(new ProfileApiError(code.endsWith("INVALID") || code.endsWith("CHANGED") ? 403 : 409, code, "原保存授权不可继续"));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { expect(await result.current.mutate("update", { default_budget_fen: 80000 }, true)).toBe(false); });
    const original = result.current.pendingMutation;
    expect(result.current.canReplayPending).toBe(false); expect(original?.expected_authorization_context?.operation_token).toBe("synthetic-token-a");
    await act(async () => { expect(await result.current.retryMutation()).toBe(false); });
    expect(api.mutate).toHaveBeenCalledTimes(1); expect(result.current.pendingMutation).toEqual(original);
    await act(async () => { result.current.discardPendingMutation(); });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(api.mutate).toHaveBeenCalledTimes(1);
    api.current.mockResolvedValueOnce(withContext(saved(1), "synthetic-new-token")).mockResolvedValueOnce(withContext(saved(2)));
    api.mutate.mockImplementationOnce(async body => receipt(body, 2));
    await act(async () => { expect(await result.current.mutate("update", { default_budget_fen: 80000 }, true)).toBe(true); });
    expect(api.mutate.mock.calls[1][0].profile_action_id).not.toBe(original?.profile_action_id);
    expect(api.mutate.mock.calls[1][0].expected_authorization_context.operation_token).toBe("synthetic-new-token");
  });

  it("授权读取降级为无context时不把新pending当旧协议写入", async () => {
    const original = seedBound(); api.initialize.mockResolvedValue(withContext(saved(1))); api.current.mockResolvedValue(saved(1));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.pendingMutation).toEqual(original));
    await act(async () => { expect(await result.current.retryMutation()).toBe(false); });
    expect(api.mutate).not.toHaveBeenCalled(); expect(result.current.pendingMutation).toEqual(original); expect(result.current.canReplayPending).toBe(false);
  });

  it("POST事务才发现空主体context变化时，403后重读当前范围并保留旧动作", async () => {
    api.initialize.mockResolvedValue(withContext(empty()));
    api.current.mockResolvedValueOnce(withContext(empty())).mockResolvedValueOnce(withContext(empty(), "synthetic-token-b", "synthetic-context-b"));
    api.mutate.mockRejectedValueOnce(new ProfileApiError(403, "PROFILE_AUTH_CONTEXT_CHANGED", "当前授权范围已变化"));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { expect(await result.current.mutate("save", { default_budget_fen: 80000 }, true)).toBe(false); });
    expect(result.current.profile?.authorization_context?.context_id).toBe("synthetic-context-b");
    expect(result.current.identityRevision).toBe(1); expect(result.current.canReplayPending).toBe(false);
    expect(result.current.pendingMutation).toEqual(api.mutate.mock.calls[0][0]); expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toContain("资料范围已变化");
  });

  it("旧无context动作的已知profile不属当前范围时不查询他人同ID记录", async () => {
    const original = boundMutation(); delete original.expected_authorization_context; seedBound(original);
    const other = withContext({ ...saved(1), profile_id: "profile-b" }, "synthetic-token-b", "synthetic-context-b");
    api.initialize.mockResolvedValue(other); api.current.mockResolvedValue(other);
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.pendingMutation).toEqual(original));
    await act(async () => { expect(await result.current.retryMutation()).toBe(false); });
    expect(api.operation).not.toHaveBeenCalled(); expect(api.mutate).not.toHaveBeenCalled();
    expect(result.current.error).toContain("未查询或重发"); expect(result.current.pendingMutation).toEqual(original);
  });
});

describe("真实资料控制器的前端状态机（接口替身不代表服务端验收）", () => {
  it("StrictMode只初始化一次，不创建操作；初始读取失败不当空资料", async () => {
    api.initialize.mockRejectedValue(new Error("离线"));
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useConsumerProfile(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(api.initialize).toHaveBeenCalledTimes(1);
    expect(result.current.profile).toBeNull(); expect(result.current.ready).toBe(false);
    await act(async () => { expect(await result.current.mutate("save", { default_budget_fen: 80000 }, true)).toBe(false); });
    expect(api.mutate).not.toHaveBeenCalled();
    api.current.mockResolvedValue(empty());
    await act(async () => { await result.current.refresh(); });
    expect(result.current.ready).toBe(true);
  });

  it("保存回执后读取权威资料，不从本次patch或旧回执恢复字段", async () => {
    api.mutate.mockImplementation(async body => receipt(body, 1));
    api.current.mockResolvedValue(saved(2, "L"));
    const { result } = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { expect(await result.current.mutate("save", { base_profile: { usual_sizes: { top: { system: "clothing_alpha", value: "S" } } } })).toBe(true); });
    expect(result.current.profile?.base_profile.usual_sizes.top?.value).toBe("L");
    expect(result.current.profile?.profile_version).toBe(2);
    expect(result.current.notice).toContain("之后已发生变化");
    expect(api.current).toHaveBeenCalledTimes(2);
    expect(api.mutate.mock.calls[0][0]).toMatchObject({ expected_profile_version: 0, explicit_save: true });
  });

  it("网络未知结果先查询操作；404后显式重试保持原ID与逐字段body", async () => {
    api.initialize.mockResolvedValue(saved(1));
    api.mutate.mockRejectedValueOnce(new TypeError("网络中断")).mockImplementation(async body => receipt(body, 2));
    api.current.mockResolvedValue(saved(2));
    const { result } = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const patch = { default_budget_fen: 80000 };
    await act(async () => { expect(await result.current.mutate("save", patch, true)).toBe(false); });
    const original = structuredClone(api.mutate.mock.calls[0][0]); patch.default_budget_fen = 50000;
    expect(api.operation).toHaveBeenCalledWith(original.profile_action_id);
    expect(result.current.pendingMutation).toEqual(original);
    expect(result.current.ready).toBe(false);
    await act(async () => { expect(await result.current.retryMutation()).toBe(true); });
    expect(api.mutate).toHaveBeenCalledTimes(2);
    expect(api.mutate.mock.calls[1][0]).toEqual(original);
    expect(result.current.pendingMutation).toBeNull();
  });

  it("先前保存回执重放晚于清除，当前仍保持cleared且不重发保存", async () => {
    api.initialize.mockResolvedValue(saved(1));
    api.mutate.mockRejectedValue(new TypeError("响应丢失"));
    const { result } = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.mutate("update", { default_budget_fen: 80000 }, true); });
    const original = api.mutate.mock.calls[0][0];
    api.current.mockResolvedValue(cleared(3));
    await act(async () => { await result.current.refresh(); });
    api.operation.mockResolvedValue(receipt(original, 2));
    await act(async () => { expect(await result.current.retryMutation()).toBe(true); });
    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(result.current.profile?.status).toBe("cleared");
    expect(result.current.profile?.default_budget_fen).toBeNull();
    expect(result.current.notice).toContain("之后已发生变化");
  });

  it("409只重读，不自动造新动作覆盖；再次明确保存才基于新版本", async () => {
    api.initialize.mockResolvedValue(saved(1));
    api.mutate.mockRejectedValueOnce(new ProfileApiError(409, "PROFILE_VERSION_CONFLICT", "版本冲突"));
    api.current.mockResolvedValue(saved(2, "L"));
    const { result } = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { expect(await result.current.mutate("update", { default_budget_fen: 50000 }, true)).toBe(false); });
    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(result.current.pendingMutation).toBeNull();
    expect(result.current.profile?.profile_version).toBe(2);
    expect(result.current.error).toContain("请核对后再次明确保存");
    api.mutate.mockImplementation(async body => receipt(body, 3)); api.current.mockResolvedValue(saved(3));
    await act(async () => { await result.current.mutate("update", { default_budget_fen: 50000 }, true); });
    expect(api.mutate.mock.calls[1][0].expected_profile_version).toBe(2);
    expect(api.mutate.mock.calls[1][0].profile_action_id).not.toBe(api.mutate.mock.calls[0][0].profile_action_id);
  });

  it("低版本GET不会复活更高的已清除状态", async () => {
    api.initialize.mockResolvedValue(cleared(4)); api.current.mockResolvedValue(saved(2));
    const { result } = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.profile?.status).toBe("cleared"); expect(result.current.profile?.profile_version).toBe(4);
  });

  it("切换身份epoch后丢弃旧保存回调，已知profile ID变化通知调用者", async () => {
    const old = deferred<ProfileMutationReceipt>();
    api.initialize.mockResolvedValue(saved(2)); api.mutate.mockReturnValue(old.promise);
    const { result, rerender } = renderHook(({ scope }) => useConsumerProfile(scope), { initialProps: { scope: "A" } });
    await waitFor(() => expect(result.current.ready).toBe(true));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.mutate("update", { default_budget_fen: 50000 }, true); });
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
    api.initialize.mockResolvedValue(empty()); rerender({ scope: "B" });
    await waitFor(() => expect(result.current.profile?.status).toBe("empty"));
    await act(async () => { old.resolve(receipt(api.mutate.mock.calls[0][0], 3)); expect(await pending).toBe(false); });
    expect(result.current.profile?.status).toBe("empty"); expect(api.current).toHaveBeenCalledTimes(1);
    api.current.mockResolvedValue(saved(3)); await act(async () => { await result.current.refresh(); });
    api.current.mockResolvedValue(empty()); await act(async () => { await result.current.refresh(); });
    expect(result.current.identityRevision).toBe(1); expect(result.current.pendingMutation).toBeNull();
  });

  it("回到可见窗口时单飞重读；失败关闭ready，不轮询", async () => {
    const pendingRead = deferred<SavedConsumerProfile>(); api.current.mockReturnValue(pendingRead.promise);
    const { result } = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(api.current).toHaveBeenCalledTimes(1);
    await act(async () => { pendingRead.reject(new Error("暂时离线")); });
    expect(result.current.ready).toBe(false); expect(result.current.error).toContain("读取失败");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
    expect(api.current).toHaveBeenCalledTimes(1);
  });

  it("clear回执到达立即隐藏旧默认，GET失败仍不假称清除已核对", async () => {
    api.initialize.mockResolvedValue(saved()); api.mutate.mockImplementation(async body => receipt(body, 2));
    const read = deferred<SavedConsumerProfile>(); api.current.mockResolvedValueOnce(saved()).mockReturnValue(read.promise);
    const { result } = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(result.current.ready).toBe(true));
    let mutation!: Promise<boolean>; act(() => { mutation = result.current.mutate("clear", {}); });
    await waitFor(() => expect(result.current.profile).toBeNull());
    await act(async () => { read.reject(new Error("GET失败")); expect(await mutation).toBe(false); });
    expect(result.current.ready).toBe(false); expect(result.current.notice).toBe("");
    expect(result.current.pendingMutation?.operation).toBe("clear");
  });

  it("刷新恢复已知相同资料的待操作原体，先GET当前，再显式查询与原体重试", async () => {
    api.initialize.mockResolvedValue(saved(1)); api.mutate.mockRejectedValueOnce(new TypeError("断线"));
    const first = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    await act(async () => { await first.result.current.mutate("update", { default_budget_fen: 50000 }, true); });
    const original = structuredClone(api.mutate.mock.calls[0][0]); first.unmount();
    const restored = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(restored.result.current.pendingMutation).toEqual(original));
    expect(api.mutate).toHaveBeenCalledTimes(1); expect(restored.result.current.canReplayPending).toBe(true);
    api.mutate.mockImplementation(async body => receipt(body, 2)); api.current.mockResolvedValue(saved(2));
    await act(async () => { await restored.result.current.retryMutation(); });
    expect(api.mutate.mock.calls[1][0]).toEqual(original);
    expect(sessionStorage.getItem("styling.pending-profile.v1:/")).toBeNull();
  });

  it("刷新后空资料主体归属无法确认，只查旧操作，404不跨主体重播", async () => {
    api.mutate.mockRejectedValueOnce(new TypeError("断线"));
    const first = renderHook(() => useConsumerProfile()); await waitFor(() => expect(first.result.current.ready).toBe(true));
    await act(async () => { await first.result.current.mutate("save", { default_budget_fen: 50000 }, true); });
    first.unmount();
    const restored = renderHook(() => useConsumerProfile());
    await waitFor(() => expect(restored.result.current.pendingMutation).not.toBeNull());
    expect(restored.result.current.canReplayPending).toBe(false);
    await act(async () => { expect(await restored.result.current.retryMutation()).toBe(false); });
    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(restored.result.current.error).toContain("空资料归属无法核对");
    await act(async () => { restored.result.current.discardPendingMutation(); });
    expect(restored.result.current.pendingMutation).toBeNull();
  });

  it("保存与回读期间identityReady保持，当前读取失败才关闭；更换profile不恢复旧pending", async () => {
    api.initialize.mockResolvedValue(saved(1)); const later = deferred<ProfileMutationReceipt>(); api.mutate.mockReturnValue(later.promise);
    const { result, unmount } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.identityReady).toBe(true));
    let mutation!: Promise<boolean>; act(() => { mutation = result.current.mutate("update", { default_budget_fen: 80000 }, true); });
    expect(result.current.identityReady).toBe(true); expect(result.current.ready).toBe(false);
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
    await act(async () => { later.reject(new TypeError("断线")); await mutation; });
    expect(result.current.identityReady).toBe(true); unmount();
    api.initialize.mockResolvedValue({ ...saved(1), profile_id: "profile-2" });
    const next = renderHook(() => useConsumerProfile()); await waitFor(() => expect(next.result.current.ready).toBe(true));
    expect(next.result.current.pendingMutation).toBeNull();
    expect(next.result.current.notice).toContain("保存范围已经变化");
    expect(api.mutate).toHaveBeenCalledTimes(1);
  });

  it("回执版本高于GET当前版本时不宣称已保存，保留原动作等待核对", async () => {
    api.mutate.mockImplementation(async body => receipt(body, 1)); api.current.mockResolvedValue(empty());
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { expect(await result.current.mutate("save", { default_budget_fen: 50000 }, true)).toBe(false); });
    expect(result.current.notice).toBe(""); expect(result.current.pendingMutation).not.toBeNull();
    expect(result.current.error).toContain("当前读取尚未核对"); expect(result.current.identityReady).toBe(false);
  });

  it("刷新后首次GET失败，人工读取恢复时仍能找回同归属的待操作", async () => {
    api.initialize.mockResolvedValueOnce(saved(1)); api.mutate.mockRejectedValue(new TypeError("断线"));
    const first = renderHook(() => useConsumerProfile()); await waitFor(() => expect(first.result.current.ready).toBe(true));
    await act(async () => { await first.result.current.mutate("update", { default_budget_fen: 50000 }, true); });
    const original = first.result.current.pendingMutation; first.unmount();
    api.initialize.mockRejectedValue(new Error("初读离线"));
    const second = renderHook(() => useConsumerProfile()); await waitFor(() => expect(second.result.current.status).toBe("error"));
    api.current.mockResolvedValue(saved(1));
    await act(async () => { await second.result.current.refresh(); });
    expect(second.result.current.pendingMutation).toEqual(original);
    expect(second.result.current.canReplayPending).toBe(true); expect(api.mutate).toHaveBeenCalledTimes(1);
  });

  it("内存旧操作404后先核归属：A与B相同修订也不能把A的patch写入B", async () => {
    api.initialize.mockResolvedValue(saved(1)); api.mutate.mockRejectedValueOnce(new TypeError("断线"));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.mutate("update", { default_budget_fen: 50000 }, true); });
    expect(result.current.pendingMutation).not.toBeNull();
    const other = { ...saved(1, "L"), profile_id: "profile-B", default_budget_fen: 90000 };
    api.current.mockResolvedValue(other);
    await act(async () => { expect(await result.current.retryMutation()).toBe(false); });
    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(result.current.profile).toEqual(other); expect(result.current.identityRevision).toBe(1);
    expect(result.current.pendingMutation).toBeNull();
    expect(sessionStorage.getItem("styling.pending-profile.v1:/")).toBeNull();
  });

  it("新保存也先GET核对已知归属，不等待focus识别Cookie变化，不重写原修订", async () => {
    api.initialize.mockResolvedValue(saved(1));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    const other = { ...saved(1), profile_id: "profile-B" }; api.current.mockResolvedValue(other);
    await act(async () => { expect(await result.current.mutate("update", { default_budget_fen: 50000 }, true)).toBe(false); });
    expect(api.mutate).not.toHaveBeenCalled();
    expect(result.current.profile?.profile_id).toBe("profile-B"); expect(result.current.identityRevision).toBe(1);
  });

  it("内存空owner的旧动作404也不重播，只有查询已有回执可完成核对", async () => {
    api.mutate.mockRejectedValueOnce(new TypeError("断线"));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.mutate("save", { default_budget_fen: 50000 }, true); });
    const original = api.mutate.mock.calls[0][0];
    await act(async () => { expect(await result.current.retryMutation()).toBe(false); });
    expect(api.mutate).toHaveBeenCalledTimes(1); expect(result.current.canReplayPending).toBe(false);
    api.operation.mockResolvedValue(receipt(original, 1)); api.current.mockResolvedValue(saved(1));
    await act(async () => { expect(await result.current.retryMutation()).toBe(true); });
    expect(api.mutate).toHaveBeenCalledTimes(1); expect(result.current.pendingMutation).toBeNull();
  });

  it("尚未完成的focus读取不能代替POST前强制核对，也不能晚到复活A", async () => {
    api.initialize.mockResolvedValue(saved(1)); api.mutate.mockRejectedValueOnce(new TypeError("断线"));
    const { result } = renderHook(() => useConsumerProfile()); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.mutate("update", { default_budget_fen: 50000 }, true); });
    const focusRead = deferred<SavedConsumerProfile>(); const freshRead = deferred<SavedConsumerProfile>();
    api.current.mockReturnValueOnce(focusRead.promise).mockReturnValueOnce(freshRead.promise);
    act(() => { window.dispatchEvent(new Event("focus")); });
    let retry!: Promise<boolean>; act(() => { retry = result.current.retryMutation(); });
    await waitFor(() => expect(api.current).toHaveBeenCalledTimes(3));
    expect(api.mutate).toHaveBeenCalledTimes(1);
    const other = { ...saved(1), profile_id: "profile-B" };
    await act(async () => { freshRead.resolve(other); expect(await retry).toBe(false); });
    await act(async () => { focusRead.resolve(saved(1)); });
    expect(result.current.profile?.profile_id).toBe("profile-B"); expect(api.mutate).toHaveBeenCalledTimes(1);
  });
});
