import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash, webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DemandReview from "../app/admin/DemandReview";
import { useAdminAction, saveAdminNote } from "../app/admin/use-admin-action";
import type { AdminContextAccess } from "../app/admin/AdminContextBoundary";
import { AdminError, type ApprovalSet, type Evidence, type GroupDetail, type TurnDetail } from "../app/lib/admin-api";
import { adminIdentityNamespace, adminActionBodyDigest, createAdminAction, serializeAdminAction, type AdminAction, type AdminIdentity, type AdminOperation } from "../app/lib/admin-context";
const mock = vi.hoisted(() => ({ execute: vi.fn(), operation: vi.fn() }));
vi.mock("../app/lib/admin-context", async original => ({ ...await original<typeof import("../app/lib/admin-context")>(), executeAdminAction: mock.execute, getAdminOperation: mock.operation }));
const expiry = new Date(Date.now() + 3600000).toISOString();
const identity = (context = "a"): AdminIdentity => ({ identity_contract: "styling_admin_identity_v1", subject: "manager-one", role: "styling-manager", audience: "personal_styling", scope: "scope-one", source_instance_id: "source-one", auth_method: "password_single_account", approval_identity_kind: "account_bound", expires_at: expiry, authorization_context: { context_contract: "styling_admin_context_v1", context_id: context.repeat(43), expires_at: expiry } });
const owner = identity(), stamp = "2026-10-08T00:00:00Z", start = "2026-10-01T00:00:00Z";
const key = (slot: string, who = owner) => `styling.admin-context.private.v1:${encodeURIComponent(adminIdentityNamespace(who))}:action:${slot}`;
const item = (index = 1): Evidence => ({ id: `occ-${index}`, turn_id: `turn-${index}`, group_key: "group-one", title: "通勤裤子", description: "合成需求", attributes: { category: "裤子", scene: "通勤" }, review_state: "pending", reason: "", revision: 1, lifecycle: "active", normalizer_version: "rules-v2", context_turn_ids: [], field_sources: { category: [`turn-${index}`], scene: [`turn-${index}`] }, session_id: "fixture-session", text: `合成原话${index}`, created_at: stamp, extractor: "rules-v2", data_origin: "simulation_fixture" });
const basis = (items = [item()], eligible = true): ApprovalSet => ({ group_key: "group-one", days: 7, window_start: start, window_end: stamp, active_count: items.length, expected_occurrence_ids: items.map(value => value.id), expected_revisions: Object.fromEntries(items.map(value => [value.id, value.revision])), evidence_digest: "e".repeat(64), approval_eligibility: { policy: "pause-inactive-sources-v1", eligible, reason_codes: eligible ? [] : ["source_inactive"], blocked_sources: eligible ? [] : [{ turn_id: "blocked-turn", occurrence_id: "blocked-occ", revision: 1, lifecycle: "excluded", review_state: "rejected" }], message: eligible ? "当前来源未触发暂停；仍须人工核对全部证据与出处。" : "引用来源含已排除或无效记录，相关新审批已暂停；重新核对不会解除，请等待人工复核。" } });
const page = (items = [item()], number = 1): GroupDetail => ({ window_start: start, window_end: stamp, evidence: items.slice((number - 1) * 40, number * 40), handoffs: [], total: items.length, page: number, page_size: 40, has_more: number * 40 < items.length, pagination_mode: "paged" });
function access(items = [item()], who = owner): AdminContextAccess {
  return { identity: who, namespace: adminIdentityNamespace(who), validate: vi.fn().mockResolvedValue(who), read: vi.fn(async (path: string) => {
    if (path.includes("approval-set")) return basis(items);
    if (path.startsWith("groups/")) return page(items, Number(new URLSearchParams(path.split("?")[1]).get("page") || 1));
    const evidence = items.find(value => path.endsWith(value.turn_id));
    if (!evidence) throw new Error(`No isolated turn fixture for ${path}`);
    return { id: evidence.turn_id, session_id: evidence.session_id, text: evidence.text, status: "extracted", extractor: evidence.extractor, data_origin: evidence.data_origin, created_at: evidence.created_at, error_code: "", extraction_attempts: 1, negative_preferences: [], occurrences: [evidence], context_turns: [], revision_history: [] } satisfies TurnDetail;
  }) as AdminContextAccess["read"], onError: vi.fn(), logout: vi.fn() };
}
function renderReview(value = access()) { return render(<DemandReview adminAccess={value} groupKey="group-one" days={7} window={{ window_start: start, window_end: stamp }} hidden={false} busy={false} sourceTurns={{}} onBusy={vi.fn()} onError={value.onError} onChanged={vi.fn()} onResetSources={vi.fn()} onOpenTurn={vi.fn()} renderHandoff={() => null} />); }
// These fixtures are unit-test metadata, never real backend acceptance.
const operation = async (action: AdminAction, changes: Partial<AdminOperation> = {}): Promise<AdminOperation> => ({ operation_contract: "styling_admin_action_v1", request_id: action.request_id, actor_subject: action.identity.subject, operation_kind: action.kind, context_binding: "bound", operation_context_ref: createHash("sha256").update(action.identity.authorization_context.context_id).digest("hex"), body_digest: await adminActionBodyDigest(action), state: "completed", outcome: action.kind === "approve" ? "created" : "completed", accepted_at: stamp, completed_at: stamp, result_ref: action.kind === "approve" ? { kind: "handoff", id: "DH-one", revision: 1 } : action.kind === "reject" ? { kind: "demand_occurrence", id: "occ-1", revision: 2 } : { kind: "demand_turn", id: "turn-1", revision: null }, ...changes });
beforeEach(() => {
  sessionStorage.clear(); vi.clearAllMocks(); vi.stubGlobal("crypto", webcrypto);
  mock.execute.mockResolvedValue({ id: "DH-one", version: 1 });
  mock.operation.mockImplementation(async () => { const action = mock.execute.mock.lastCall?.[0] as AdminAction; return operation(action); });
});

describe("management context evidence review", () => {
  it("submits all 41 evidence IDs only after every page is reviewed", async () => {
    const items = Array.from({ length: 41 }, (_, index) => item(index + 1)); renderReview(access(items)); const user = userEvent.setup();
    await screen.findByText("合成原话1"); await user.type(screen.getByRole("textbox"), "已读全部出处");
    for (const check of screen.getAllByRole("checkbox")) await user.click(check);
    expect(screen.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "下一页" })); await screen.findByText("合成原话41"); await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "核验并批准当前证据快照" })); await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1));
    const action = mock.execute.mock.calls[0][0] as AdminAction; expect(action.body.expected_occurrence_ids).toHaveLength(41); expect(action.body.expected_revisions).toEqual(basis(items).expected_revisions); expect(action.body.expected_evidence_digest).toBe("e".repeat(64)); expect(action.body.expected_admin_context).toEqual({ context_contract: "styling_admin_context_v1", context_id: "a".repeat(43) });
  });
  it("keeps SOURCE_APPROVAL_BLOCKED disabled and preserves note without suggesting recheck can unlock it", async () => {
    mock.execute.mockRejectedValue(new AdminError(409, "SOURCE_APPROVAL_BLOCKED", "来源已排除，审批暂停", basis(undefined, false).approval_eligibility));
    renderReview(); const user = userEvent.setup(); await screen.findByText("合成原话1"); await user.type(screen.getByRole("textbox"), "人工核对说明"); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "核验并批准当前证据快照" }));
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1)); expect(screen.getByRole("textbox")).toHaveValue("人工核对说明"); expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(screen.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled(); expect(await screen.findByText(/重新核对不会解除暂停/)).toBeVisible();
  });
  it("context conflict clears checks, preserves original-scope note, and cannot create a second action", async () => {
    mock.execute.mockRejectedValue(new AdminError(409, "ADMIN_ACTION_CONTEXT_CONFLICT", "管理上下文已变化")); renderReview(); const user = userEvent.setup(); await screen.findByText("合成原话1");
    await user.type(screen.getByRole("textbox"), "保留原说明"); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "核验并批准当前证据快照" }));
    await screen.findByText(/不会替换上下文或重新批准/); expect(screen.getByRole("textbox")).toHaveValue("保留原说明"); expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(screen.getByRole("button", { name: "重新开始全部核对" })).toBeDisabled(); expect(mock.execute).toHaveBeenCalledTimes(1);
  });
  it("only explicitly restores a note in the exact same context", async () => {
    const slot = `review:group-one:${start}:${stamp}`; saveAdminNote(owner, slot, "原会话说明"); const mounted = renderReview(access(undefined, identity("b"))); await screen.findByText("合成原话1"); expect(screen.getByRole("textbox")).toHaveValue(""); expect(screen.queryByText("恢复本管理会话暂存说明")).not.toBeInTheDocument(); mounted.unmount();
    renderReview(); await screen.findByText("合成原话1"); expect(screen.getByRole("textbox")).toHaveValue(""); await userEvent.click(screen.getByRole("button", { name: "恢复本管理会话暂存说明" })); expect(screen.getByRole("textbox")).toHaveValue("原会话说明"); expect(mock.execute).not.toHaveBeenCalled();
  });
  it("reject uses its own frozen original body and current occurrence revision", async () => {
    mock.execute.mockResolvedValue({ status: "rejected", revision: 2 }); renderReview(); const user = userEvent.setup(); await screen.findByText("合成原话1"); await user.type(screen.getByRole("textbox"), "来源提炼有误"); await user.click(screen.getByRole("button", { name: "排除这条记录" })); await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1)); const action = mock.execute.mock.calls[0][0] as AdminAction; expect(action.path).toBe("occurrences/occ-1/reject"); expect(action.body.note).toBe("来源提炼有误"); expect(action.body.expected_revision).toBe(1);
  });
});

describe("immutable management action recovery", () => {
  it("restores original body, queries metadata on demand, and 404 never permits POST", async () => {
    const original = createAdminAction(owner, "turns/turn-1/retry", {}, "11111111-1111-4111-8111-111111111111"); sessionStorage.setItem(key("retry"), serializeAdminAction(original)); mock.operation.mockRejectedValue(new AdminError(404, "NOT_FOUND", "未找到原操作")); const { result } = renderHook(() => useAdminAction({ access: access(), slot: "retry" })); await waitFor(() => expect(result.current.pending?.request_id).toBe(original.request_id));
    await act(async () => { await result.current.query(); }); expect(result.current.canReplay).toBe(false); await act(async () => { await expect(result.current.replay()).rejects.toThrow("未找到原操作"); }); expect(mock.execute).not.toHaveBeenCalled(); expect(sessionStorage.getItem(key("retry"))).toBe(serializeAdminAction(original));
  });
  it("blocks corrupt stored action until explicit archive; does not silently mint a new ID", async () => {
    sessionStorage.setItem(key("retry"), "{invalid}"); const { result } = renderHook(() => useAdminAction({ access: access(), slot: "retry" })); await waitFor(() => expect(result.current.ready).toBe(true)); expect(result.current.blocked).toBe(true);
    await act(async () => { await expect(result.current.execute("turns/turn-1/retry")).rejects.toThrow(); }); expect(mock.execute).not.toHaveBeenCalled(); act(() => { expect(result.current.archive()).toBe(true); }); expect(result.current.blocked).toBe(false); expect(sessionStorage.getItem(key("retry"))).toBeNull();
  });
  it("does not submit after its identity validation resolves following unmount", async () => {
    let resolve!: (value: AdminIdentity) => void; const pending = new Promise<AdminIdentity>(done => { resolve = done; }); const value = access(); value.validate = vi.fn().mockReturnValue(pending); const { result, unmount } = renderHook(() => useAdminAction({ access: value, slot: "retry" })); await waitFor(() => expect(result.current.ready).toBe(true)); let action!: Promise<unknown>; act(() => { action = result.current.execute("turns/turn-1/retry").catch(reason => reason); }); unmount(); await act(async () => { resolve(owner); await action; }); expect(mock.execute).not.toHaveBeenCalled();
  });
  it("pending metadata stays query-only with no original replay", async () => {
    const original = createAdminAction(owner, "turns/turn-1/retry"); sessionStorage.setItem(key("retry"), serializeAdminAction(original)); mock.operation.mockResolvedValue(await operation(original, { state: "pending", outcome: null, completed_at: null, result_ref: null })); const { result } = renderHook(() => useAdminAction({ access: access(), slot: "retry" })); await waitFor(() => expect(result.current.pending).not.toBeNull()); await act(async () => { await result.current.query(); }); expect(result.current.metadata?.state).toBe("pending"); expect(result.current.canReplay).toBe(false); await act(async () => { await expect(result.current.replay()).rejects.toThrow(); }); expect(mock.execute).not.toHaveBeenCalled();
  });
});

describe("original operation association and terminal status", () => {
  it.each(["kind", "body"])("does not announce approval success for mismatched %s metadata", async mismatch => {
    mock.operation.mockImplementation(async () => { const action = mock.execute.mock.lastCall?.[0] as AdminAction; return operation(action, mismatch === "kind" ? { operation_kind: "reject" } : { body_digest: "0".repeat(64) }); });
    renderReview(); const user = userEvent.setup(); await screen.findByText("合成原话1"); await user.type(screen.getByRole("textbox"), "已读出处"); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "核验并批准当前证据快照" }));
    await waitFor(() => expect(screen.getAllByText(/原操作元数据与保存的内容或管理范围不一致/).length).toBeGreaterThan(0)); expect(screen.queryByText("当前证据快照已批准并保存；请查看冻结版本，导出不代表接收。")).not.toBeInTheDocument(); expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(mock.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["pending", "failed", "unconfirmed"] as const)("does not turn %s metadata into approval success", async state => {
    mock.operation.mockImplementation(async () => { const action = mock.execute.mock.lastCall?.[0] as AdminAction; return operation(action, { state, outcome: state === "pending" ? null : state, completed_at: state === "pending" ? null : stamp, result_ref: null }); });
    renderReview(); const user = userEvent.setup(); await screen.findByText("合成原话1"); await user.type(screen.getByRole("textbox"), "已读出处"); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "核验并批准当前证据快照" }));
    await waitFor(() => expect(screen.getAllByText(state === "pending" ? /原操作仍在处理中/ : /原操作未确认成功/).length).toBeGreaterThan(0)); expect(screen.queryByText("当前证据快照已批准并保存；请查看冻结版本，导出不代表接收。")).not.toBeInTheDocument(); expect(mock.execute).toHaveBeenCalledTimes(1);
  });
  it("replays only the exact original body after a same-context completed metadata lookup", async () => {
    const original = createAdminAction(owner, "turns/turn-1/retry"); sessionStorage.setItem(key("retry"), serializeAdminAction(original)); mock.execute.mockResolvedValue({ id: "turn-1", status: "extracted", error_code: null, extraction_attempts: 2 }); mock.operation.mockResolvedValue(await operation(original, { result_ref: { kind: "demand_turn", id: "turn-1", revision: 2 } })); const { result } = renderHook(() => useAdminAction({ access: access(), slot: "retry" })); await waitFor(() => expect(result.current.pending).not.toBeNull()); expect(mock.execute).not.toHaveBeenCalled();
    act(() => { expect(result.current.archive()).toBe(false); }); await act(async () => { await result.current.query(); }); expect(result.current.canReplay).toBe(true); await act(async () => { await result.current.replay(); }); expect(mock.execute).toHaveBeenCalledTimes(1); expect(mock.execute.mock.calls[0][0]).toEqual(original); expect(sessionStorage.getItem(key("retry"))).toBe(serializeAdminAction(original));
  });
  it("known pending remains blocking even after a later 404", async () => {
    const original = createAdminAction(owner, "turns/turn-1/retry"); sessionStorage.setItem(key("retry"), serializeAdminAction(original)); mock.operation.mockResolvedValueOnce(await operation(original, { state: "pending", outcome: null, completed_at: null, result_ref: null })).mockRejectedValue(new AdminError(404, "NOT_FOUND", "未找到")); const { result } = renderHook(() => useAdminAction({ access: access(), slot: "retry" })); await waitFor(() => expect(result.current.pending).not.toBeNull()); await act(async () => { await result.current.query(); }); await act(async () => { await result.current.query(); }); act(() => { expect(result.current.archive()).toBe(false); }); expect(mock.execute).not.toHaveBeenCalled();
  });
  it("does not POST if the browser cannot persist the original request", async () => {
    const { result } = renderHook(() => useAdminAction({ access: access(), slot: "retry" })); await waitFor(() => expect(result.current.ready).toBe(true)); const stored = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
    try { await act(async () => { await expect(result.current.execute("turns/turn-1/retry")).rejects.toThrow("尚未提交"); }); expect(mock.execute).not.toHaveBeenCalled(); } finally { stored.mockRestore(); }
  });
});

it("requires approval metadata to reference the same returned frozen handoff", async () => {
  mock.operation.mockImplementation(async () => operation(mock.execute.mock.lastCall?.[0] as AdminAction, { result_ref: { kind: "handoff", id: "DH-other", revision: 1 } })); renderReview(); const user = userEvent.setup(); await screen.findByText("合成原话1"); await user.type(screen.getByRole("textbox"), "已读出处"); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "核验并批准当前证据快照" }));
  await waitFor(() => expect(screen.getAllByText(/批准结果与原操作引用不一致/).length).toBeGreaterThan(0)); expect(screen.queryByText("当前证据快照已批准并保存；请查看冻结版本，导出不代表接收。")).not.toBeInTheDocument(); expect(mock.execute).toHaveBeenCalledTimes(1);
});

it("preserves a legal null operation result reference as unknown instead of inventing or rejecting it", async () => {
  mock.operation.mockImplementation(async () => operation(mock.execute.mock.lastCall?.[0] as AdminAction, { result_ref: null })); renderReview(); const user = userEvent.setup(); await screen.findByText("合成原话1"); await user.type(screen.getByRole("textbox"), "已读出处"); await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "核验并批准当前证据快照" }));
  expect(await screen.findByText("当前证据快照已批准并保存；请查看冻结版本，导出不代表接收。")).toBeVisible(); expect(screen.getByText(/服务端未提供结果引用/)).toBeVisible(); expect(screen.queryByText(/原结果引用：/)).not.toBeInTheDocument();
});
