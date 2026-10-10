import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DirectDelivery from "../app/admin/DirectDelivery";
import { AdminError, type Handoff } from "../app/lib/admin-api";
import type { AdminContextAccess } from "../app/admin/AdminContextBoundary";
import type { AdminIdentity } from "../app/lib/admin-context";

// This file isolates component decisions; the actual shared action hook/API have their own contract tests.
const mocked = vi.hoisted(() => ({ hook: vi.fn() }));
vi.mock("../app/admin/use-admin-action", () => ({ useAdminAction: mocked.hook }));
const stamp = "2026-10-09T20:50:25.181039+00:00";
const handoff: Handoff = { id: "DH-context-ui", group_key: "group", title: "合成需求", version: 1, status: "approved", created_at: stamp,
  last_error: "", occurrences: 1, needs_review: false, review_reasons: [], send_eligible: true, send_in_progress: false,
  retry_after_seconds: 0, received_at: null, approval_identity_kind: "account_bound", source_approval_ref: { approval_record_id: "STAPR-original" },
  metadata: { approved_by: "original-approver", approved_at: stamp, payload_digest: "a".repeat(64) } };
const identity: AdminIdentity = { identity_contract: "styling_admin_identity_v1", subject: "current-operator", role: "styling-manager", audience: "personal_styling",
  scope: "sac-test", source_instance_id: "styling-test", auth_method: "password_single_account", approval_identity_kind: "account_bound",
  expires_at: "2099-01-01T00:00:00Z", authorization_context: { context_contract: "styling_admin_context_v1", context_id: "a".repeat(43), expires_at: "2099-01-01T00:00:00Z" } };
const notStarted = () => ({ transport: "direct", handoff_id: handoff.id, revision: 1, status: "not_started", receipt: null,
  current_supplement: null, supplement_delivery: null, attempts: [], transmission_actor_subject: null });
function received() {
  return { transport: "direct", handoff_id: handoff.id, revision: 1, delivery_id: "SDLV-original", status: "received", operation_in_progress: false, retry_after_seconds: 0,
    source_instance_id: "styling-test", target_instance_id: "mock-receiver-8072", authorized_scope: "sac-test", payload_digest: handoff.metadata.payload_digest,
    source_approval_ref: handoff.source_approval_ref, transmission_actor_subject: "original-transmitter", first_supplement: null, current_supplement: null,
    last_error: null, supplement_delivery: null, attempts: [], receipt: { receipt_schema: "pa-direct-receipt/1", transport_schema: "pa-direct-delivery/1", direct_receive_id: "DPRCV-original",
      source_product: "personal_styling", target_product: "product_management", source_instance_id: "styling-test", target_instance_id: "mock-receiver-8072", authorized_scope: "sac-test",
      handoff_id: handoff.id, revision: 1, payload_digest: handoff.metadata.payload_digest, source_approval_ref: handoff.source_approval_ref,
      status: "received", received_at: stamp, verification_id: "verify-original", supplement_id: null, supplement_digest: null } };
}
const controller = () => ({ pending: null, metadata: null, busy: false, ready: true, blocked: false, error: "", canReplay: false,
  execute: vi.fn(), replay: vi.fn(), query: vi.fn(), archive: vi.fn().mockReturnValue(true) });
let hook = controller();
function accessWith(value: unknown = notStarted()): AdminContextAccess {
  return { identity, namespace: "four-dimensions", validate: vi.fn().mockResolvedValue(identity),
    read: vi.fn().mockImplementation((path: string) => Promise.resolve(path.endsWith("direct-delivery") ? value : handoff)), onError: vi.fn(), logout: vi.fn() };
}
const show = (access = accessWith()) => render(<DirectDelivery handoff={handoff} sessionNamespace="same-name" adminAccess={access} />);
async function ready() { await screen.findByText("尚未开始直接交接"); }
async function consent(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "重新读取身份和冻结对象" }));
  const choice = screen.getByRole("checkbox", { name: /明确提出新操作/ });
  await waitFor(() => expect(choice).toBeEnabled()); await user.click(choice);
}
beforeEach(() => { vi.clearAllMocks(); hook = controller(); mocked.hook.mockReturnValue(hook); });

describe("direct context component intent boundaries", () => {
  it("requires fresh identity/object and explicit new consent before sending, then reads current instead of using action snapshot", async () => {
    const user = userEvent.setup(), access = accessWith();
    hook.execute.mockImplementation(async () => { vi.mocked(access.read).mockImplementation(async () => received() as never); return { result: received(), operation: null }; });
    show(access); await ready();
    const send = screen.getByRole("button", { name: "明确发送此冻结版本" }); expect(send).toBeDisabled();
    await consent(user); await user.click(send);
    await screen.findByText("本机模拟直接接收回执已确认");
    expect(access.validate).toHaveBeenCalled();
    expect(access.read).toHaveBeenCalledWith(`handoffs/${handoff.id}`, expect.any(AbortSignal));
    expect(hook.execute).toHaveBeenCalledExactlyOnceWith(`handoffs/${handoff.id}/direct-send`, { expected_revision: 1, include_supplement: true });
    expect(screen.getByRole("checkbox", { name: /明确提出新操作/ })).not.toBeChecked();
    expect(screen.queryByText("产品管理直接接收已确认")).not.toBeInTheDocument();
  });
  it("declares simulator scope and separates original approval, transmission and operation actors", async () => {
    Object.assign(hook, { metadata: { request_id: "known-action", actor_subject: "operation-actor", outcome: "reused_frozen", state: "completed", context_binding: "bound" } });
    show(accessWith(received())); await screen.findByText("本机模拟直接接收回执已确认");
    expect(screen.getByText(/本机演示 · 仅模拟接收/)).toBeVisible();
    expect(screen.getByText("original-approver")).toBeVisible(); expect(screen.getByText("original-transmitter")).toBeVisible();
    expect(screen.getByText("operation-actor")).toBeVisible(); expect(screen.getByText("current-operator")).toBeVisible();
    expect(screen.getByText(/不是当前管理者重新批准/)).toBeVisible();
  });
  it("does not promote a received historical action snapshot when current source still says not started", async () => {
    hook.execute.mockResolvedValue({ result: received(), operation: null }); show(); await ready(); const user = userEvent.setup();
    await consent(user); await user.click(screen.getByRole("button", { name: "明确发送此冻结版本" }));
    await screen.findByText(/已读取当前源台账/); expect(screen.getByText("尚未开始直接交接")).toBeVisible();
    expect(screen.queryByText("本机模拟直接接收回执已确认")).not.toBeInTheDocument();
  });
  it.each(["ADMIN_OPERATION_NOT_FOUND", "ADMIN_ACTION_IN_PROGRESS", "ADMIN_ACTION_LEGACY_UNBOUND"])("keeps %s recovery read-only and does not fabricate a replay", async code => {
    Object.assign(hook, { pending: { request_id: "original-action", operation_kind: "direct_send" }, error: code });
    show(); await ready();
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "明确回放原上下文原动作" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "只读查询原操作" }));
    expect(hook.query).toHaveBeenCalledTimes(1); expect(hook.execute).not.toHaveBeenCalled(); expect(hook.replay).not.toHaveBeenCalled();
  });
  it("only invokes explicit original replay after shared hook authorizes it and independently re-reads DTO", async () => {
    Object.assign(hook, { pending: { request_id: "original-action", operation_kind: "direct_send" }, canReplay: true });
    hook.replay.mockResolvedValue({ result: received(), operation: null });
    const access = accessWith(received()); show(access); await screen.findByText("本机模拟直接接收回执已确认");
    await userEvent.setup().click(screen.getByRole("button", { name: "明确回放原上下文原动作" }));
    await waitFor(() => expect(hook.replay).toHaveBeenCalledTimes(1));
    expect(hook.execute).not.toHaveBeenCalled(); expect(access.read).toHaveBeenCalledTimes(2);
  });
  it("new intent archives only after fresh object and explicit consent, never upgrades the old action in-place", async () => {
    Object.assign(hook, { pending: { request_id: "old-action", operation_kind: "direct_send" } });
    const access = accessWith(received()); hook.execute.mockResolvedValue({ result: received(), operation: null }); show(access);
    await screen.findByText("本机模拟直接接收回执已确认"); const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "以当前上下文新建对账动作" }); expect(button).toBeDisabled();
    await consent(user); expect(hook.archive).not.toHaveBeenCalled(); await user.click(button);
    await waitFor(() => expect(hook.execute).toHaveBeenCalledExactlyOnceWith(`handoffs/${handoff.id}/direct-reconcile`, { expected_revision: 1 }));
    expect(hook.archive.mock.invocationCallOrder[0]).toBeLessThan(hook.execute.mock.invocationCallOrder[0]);
  });
  it("pending operation metadata blocks a new POST even after re-reading and selecting consent", async () => {
    Object.assign(hook, { pending: { request_id: "running", operation_kind: "direct_send" }, metadata: { request_id: "running", state: "pending", actor_subject: identity.subject, context_binding: "bound" } });
    show(); await ready(); const user = userEvent.setup(); await consent(user);
    expect(screen.getByRole("button", { name: "明确发送此冻结版本" })).toBeDisabled(); expect(hook.execute).not.toHaveBeenCalled();
  });
  it("failed archive never reaches execution even with an explicitly confirmed new intention", async () => {
    Object.assign(hook, { pending: { request_id: "old-action", operation_kind: "direct_send" } }); hook.archive.mockReturnValue(false);
    show(); await ready(); const user = userEvent.setup(); await consent(user);
    await user.click(screen.getByRole("button", { name: "明确发送此冻结版本" })); expect(hook.archive).toHaveBeenCalledTimes(1); expect(hook.execute).not.toHaveBeenCalled();
  });
  it.each(["source_instance_id", "authorized_scope"])("rejects self-consistent foreign %s instead of displaying it under current identity", async field => {
    const value = received(); Object.assign(value, { [field]: "foreign" }); Object.assign(value.receipt, { [field]: "foreign" });
    show(accessWith(value)); expect(await screen.findByRole("alert")).toHaveTextContent("DIRECT_SCOPE_MISMATCH");
    expect(screen.queryByText("本机模拟直接接收回执已确认")).not.toBeInTheDocument(); expect(hook.execute).not.toHaveBeenCalled();
  });
  it("an uncertain source record offers explicit new reconciliation rather than a send button", async () => {
    show(accessWith({ ...received(), status: "unconfirmed", receipt: null, last_error: "DIRECT_TIMEOUT" }));
    await screen.findByText("产品管理接收待确认"); expect(screen.getByText(/目标可能已经接收/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "明确发送此冻结版本" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "以当前上下文新建对账动作" })).toBeDisabled();
  });
  it("context conflict keeps new send closed and reports authoritative identity error", async () => {
    const access = accessWith(); show(access); await ready();
    vi.mocked(access.validate).mockRejectedValue(new AdminError(409, "ADMIN_AUTH_CONTEXT_CHANGED", "原会话已变化"));
    await userEvent.setup().click(screen.getByRole("button", { name: "重新读取身份和冻结对象" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ADMIN_AUTH_CONTEXT_CHANGED");
    expect(hook.execute).not.toHaveBeenCalled(); expect(access.onError).toHaveBeenCalled();
  });
  it("mismatched frozen object cannot open new consent", async () => {
    const access = accessWith(); vi.mocked(access.read).mockImplementation(async path => (path.endsWith("direct-delivery") ? notStarted() : { ...handoff, version: 2 }) as never);
    show(access); await ready(); await userEvent.setup().click(screen.getByRole("button", { name: "重新读取身份和冻结对象" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("DIRECT_REVISION_CONFLICT");
    expect(screen.getByRole("checkbox", { name: /明确提出新操作/ })).toBeDisabled(); expect(hook.execute).not.toHaveBeenCalled();
  });
  it("late prior-context GET cannot render original receipt after context changes, even with same caller namespace", async () => {
    let resolve!: (value: unknown) => void;
    const first = accessWith(); vi.mocked(first.read).mockReturnValue(new Promise(yes => { resolve = yes; }));
    const view = show(first); await waitFor(() => expect(first.read).toHaveBeenCalledTimes(1));
    const second = accessWith(); second.identity = { ...identity, authorization_context: { ...identity.authorization_context, context_id: "b".repeat(43) } };
    view.rerender(<DirectDelivery handoff={handoff} sessionNamespace="same-name" adminAccess={second} />); await ready();
    await act(async () => resolve(received()));
    expect(screen.queryByText("本机模拟直接接收回执已确认")).not.toBeInTheDocument();
  });
  it("an action response after the original component unmount cannot cause a new source read", async () => {
    let resolve!: (value: unknown) => void; hook.execute.mockReturnValue(new Promise(yes => { resolve = yes; }));
    const access = accessWith(), view = show(access); await ready(); const user = userEvent.setup(); await consent(user);
    await user.click(screen.getByRole("button", { name: "明确发送此冻结版本" })); const before = vi.mocked(access.read).mock.calls.length; view.unmount();
    await act(async () => resolve({ result: received(), operation: null })); expect(access.read).toHaveBeenCalledTimes(before);
  });
  it.each([{ ready: false, blocked: false }, { ready: true, blocked: true }])("does not write before stored-action recovery is safe: %j", async state => {
    Object.assign(hook, state); show(); await ready(); const user = userEvent.setup(); await consent(user);
    expect(screen.getByRole("button", { name: "明确发送此冻结版本" })).toBeDisabled(); expect(hook.execute).not.toHaveBeenCalled();
    if (state.blocked) { await user.click(screen.getByRole("button", { name: "明确结束损坏的本地记录（不发送）" })); expect(hook.archive).toHaveBeenCalledTimes(1); }
  });
});
