import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DirectDelivery, { adminDirectSession, forgetAdminDirectSession } from "../app/admin/DirectDelivery";
import { AdminError, type Handoff } from "../app/lib/admin-api";
import type { DirectDelivery as Delivery, DirectStarted, EvidenceExport } from "../app/lib/admin-direct-api";

// Component-only synthetic responses; these tests do not claim live product reception.
const mocked = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), reconcile: vi.fn(), supplement: vi.fn(), register: vi.fn(), download: vi.fn() }));
vi.mock("../app/lib/admin-direct-api", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/admin-direct-api")>(),
  getDirectDelivery: mocked.get, sendDirectHandoff: mocked.send, reconcileDirectHandoff: mocked.reconcile,
  appendDirectSupplement: mocked.supplement, registerEvidenceExport: mocked.register, downloadEvidenceExport: mocked.download,
}));
const stamp = "2026-10-09T20:50:25.181039+00:00";
const approval = { approval_record_id: "STAPR-ui-fixture" };
const supplement = { supplement_id: "STSUP-ui-fixture", digest: "b".repeat(64) };
const handoff: Handoff = { id: "DH-ui-fixture", group_key: "group", title: "合成需求", version: 1, status: "approved",
  created_at: stamp, last_error: "", occurrences: 1, needs_review: false, review_reasons: [], send_eligible: true,
  send_in_progress: false, retry_after_seconds: 0, received_at: null, approval_identity_kind: "account_bound", source_approval_ref: approval,
  metadata: { payload_digest: "a".repeat(64), approved_at: stamp, approved_by: "fixture-manager" } };
const notStarted = (): Delivery => ({ transport: "direct", handoff_id: handoff.id, revision: 1, status: "not_started", receipt: null,
  current_supplement: null, supplement_delivery: null, attempts: [] });
function started(status: "unconfirmed" | "sending" = "unconfirmed", first = true): DirectStarted {
  return { transport: "direct", handoff_id: handoff.id, revision: 1, delivery_id: "SDLV-ui-fixture", status, receipt: null,
    operation_in_progress: status === "sending", retry_after_seconds: status === "sending" ? 7 : 0,
    source_instance_id: "styling-local-isolated", target_instance_id: "product-local-isolated", authorized_scope: "fixture-isolated",
    payload_digest: handoff.metadata.payload_digest!, source_approval_ref: approval, first_supplement: first ? supplement : null,
    current_supplement: null, last_error: "DIRECT_TIMEOUT", supplement_delivery: null, attempts: [] };
}
function received(first = true, late = false): Delivery {
  const value = started("unconfirmed", first);
  const receipt = { receipt_schema: "pa-direct-receipt/1" as const, transport_schema: "pa-direct-delivery/1" as const,
    direct_receive_id: "DPRCV-ui-fixture", source_product: "personal_styling" as const, target_product: "product_management" as const,
    source_instance_id: value.source_instance_id, target_instance_id: value.target_instance_id, authorized_scope: value.authorized_scope,
    handoff_id: handoff.id, revision: 1, payload_digest: value.payload_digest, source_approval_ref: approval,
    status: "received" as const, received_at: stamp, verification_id: "STV-ui-fixture",
    supplement_id: first ? supplement.supplement_id : null, supplement_digest: first ? supplement.digest : null };
  return { ...value, status: "received", receipt, last_error: null, current_supplement: first || late ? supplement : null,
    supplement_delivery: late ? { ...supplement, status: "received", last_error: null, receipt: { receipt_schema: "pa-direct-supplement-receipt/1",
      direct_receive_id: receipt.direct_receive_id, supplement_id: supplement.supplement_id, digest: supplement.digest,
      received_at: stamp, verification_id: "STV-ui-late", status: "received" } } : null };
}
const registered: EvidenceExport = { ...supplement, handoff_id: handoff.id, revision: 1, metadata_digest: "c".repeat(64), rule_version: "styling-frozen-redaction-v1", status: "registered" };
const pendingKey = (namespace = "admin-test") => `styling.admin-direct-pending.v1:/:${namespace}:${handoff.id}:1:${approval.approval_record_id}`;
const defer = <T,>() => { let resolve!: (v: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const show = (props: Partial<React.ComponentProps<typeof DirectDelivery>> = {}) => render(<DirectDelivery handoff={handoff} sessionNamespace="admin-test" {...props} />);
async function ready(label = "尚未开始直接交接") { await screen.findByText(label); await waitFor(() => expect(screen.getByRole("button", { name: "读取当前状态" })).toBeEnabled()); }
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  Object.values(mocked).forEach(fn => fn.mockReset());
  mocked.get.mockResolvedValue(notStarted()); mocked.send.mockResolvedValue(started()); mocked.reconcile.mockResolvedValue(started());
  mocked.supplement.mockResolvedValue(received(false, true)); mocked.register.mockResolvedValue(registered);
  mocked.download.mockResolvedValue({ blob: new Blob(["original"]), fileName: "fixture.evidence.json", digest: supplement.digest });
});

describe("direct management panel", () => {
  it("opens with GET only; does not promote old received or fabricate absent approval identity", async () => {
    const view = show({ handoff: { ...handoff, status: "received", approval_identity_kind: undefined, source_approval_ref: undefined } });
    expect(screen.getAllByText("历史未记录")).toHaveLength(2);
    expect(screen.getByText(/历史批准缺少账户绑定来源/)).toBeVisible();
    expect(mocked.get).not.toHaveBeenCalled();
    view.rerender(<DirectDelivery handoff={handoff} sessionNamespace="admin-test" />);
    await ready();
    expect(mocked.get).toHaveBeenCalledTimes(1);
    expect(mocked.send).not.toHaveBeenCalled(); expect(mocked.reconcile).not.toHaveBeenCalled(); expect(mocked.register).not.toHaveBeenCalled();
  });
  it("shows actual source account and approval reference without interpreting login role", async () => {
    show(); await ready();
    expect(screen.getByText("账户绑定（account_bound）")).toBeVisible();
    expect(screen.getByText(approval.approval_record_id)).toBeVisible();
    expect(screen.getByText(/本机隔离技术验证 · 合成需求 · 非伙伴真实接收/)).toBeVisible();
  });
  it("sends explicit original choice and only displays a fresh GET, ignoring the historical action snapshot", async () => {
    const user = userEvent.setup();
    mocked.get.mockResolvedValueOnce(notStarted()).mockResolvedValue(received(false));
    mocked.send.mockResolvedValue(started("unconfirmed", false));
    show(); await ready();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "发送此冻结版本" }));
    await ready("产品管理直接接收已确认");
    const body = mocked.send.mock.calls[0][1];
    expect(body).toEqual({ request_id: expect.any(String), expected_revision: 1, include_supplement: false });
    expect(mocked.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/首次未附带冻结证据（null）/)).toBeVisible();
    expect(screen.queryByText("产品管理接收待确认")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(pendingKey())).toBeNull();
  });
  it("keeps first receipt null separate from independently received later evidence even when old send_eligible is false", async () => {
    mocked.get.mockResolvedValue(received(false, true));
    show({ handoff: { ...handoff, send_eligible: false } }); await ready("产品管理直接接收已确认");
    expect(screen.getByText("后补冻结证据接收已确认")).toBeVisible();
    expect(screen.getByText(/首次未附带冻结证据（null）/)).toBeVisible();
    const first = screen.getByText("查看首次直接接收回执").closest("details")!;
    expect(first.textContent).toContain('"supplement_id": null');
    expect(first.textContent).not.toContain("STV-ui-late");
    expect(screen.getByText("查看独立补充回执").closest("details")!.textContent).toContain("STV-ui-late");
    expect(screen.queryByRole("button", { name: "明确追加冻结证据" })).not.toBeInTheDocument();
  });
  it("unconfirmed is never success and explicit known-result retry uses a new action ID but frozen first-supplement choice", async () => {
    const user = userEvent.setup();
    mocked.get.mockResolvedValueOnce(notStarted()).mockResolvedValue(started("unconfirmed", false));
    show(); await ready(); await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "发送此冻结版本" }));
    await ready("产品管理接收待确认");
    expect(screen.queryByText("产品管理直接接收已确认")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "显式重试原冻结交接" }));
    await waitFor(() => expect(mocked.send).toHaveBeenCalledTimes(2));
    expect(mocked.send.mock.calls[1][1].request_id).not.toBe(mocked.send.mock.calls[0][1].request_id);
    expect(mocked.send.mock.calls[1][1].include_supplement).toBe(false);
  });
  it("network loss reads first, preserves body across remount, and only explicit retry uses the same ID", async () => {
    const user = userEvent.setup();
    mocked.send.mockRejectedValueOnce(new AdminError(0, "NETWORK_ERROR", "网络中断，结果未确认"));
    const view = show(); await ready(); await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "发送此冻结版本" }));
    await screen.findByText(/原动作编号与内容已保留/);
    expect(mocked.get).toHaveBeenCalledTimes(2); expect(mocked.send).toHaveBeenCalledTimes(1);
    const original = mocked.send.mock.calls[0][1];
    expect(JSON.parse(sessionStorage.getItem(pendingKey())!).body).toEqual(original);
    view.unmount();
    const restoredRead = defer<Delivery>(); mocked.get.mockReturnValueOnce(restoredRead.promise);
    show(); await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/待核对原动作/)).not.toBeInTheDocument();
    await act(async () => { restoredRead.resolve(notStarted()); });
    await screen.findByText(/待核对原动作/);
    expect(mocked.send).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "按原编号重试此动作" }));
    await waitFor(() => expect(mocked.send).toHaveBeenCalledTimes(2));
    expect(mocked.send.mock.calls[1][1]).toEqual(original);
    expect(mocked.get.mock.invocationCallOrder[3]).toBeLessThan(mocked.send.mock.invocationCallOrder[1]);
  });
  it("409 retains checkbox draft and original action while reading current; it never updates revision or automatically retries", async () => {
    const user = userEvent.setup();
    mocked.send.mockRejectedValue(new AdminError(409, "DIRECT_REVISION_CONFLICT", "修订不一致，请核对"));
    show(); await ready(); await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "发送此冻结版本" }));
    await screen.findByRole("alert");
    await screen.findByText(/待核对原动作/);
    expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(mocked.send).toHaveBeenCalledTimes(1); expect(mocked.get).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sessionStorage.getItem(pendingKey())!).body.expected_revision).toBe(1);
    await user.click(screen.getByRole("button", { name: "存档原动作并重新选择" }));
    expect(sessionStorage.getItem(pendingKey())).toBeNull();
    expect(Object.keys(sessionStorage).some(key => key.startsWith(`${pendingKey()}:archive:`))).toBe(true);
    expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(mocked.send).toHaveBeenCalledTimes(1);
  });
  it("in-progress lease disables all writes and only a later read can enable a retry", async () => {
    const user = userEvent.setup(); mocked.get.mockResolvedValueOnce(started("sending")).mockResolvedValue(started());
    show(); await ready("直接交接发送中");
    expect(screen.getByText(/约 7 秒后读取/)).toBeVisible();
    expect(screen.getByRole("button", { name: "查询产品管理对账" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "登记冻结证据补充" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "读取当前状态" })); await ready("产品管理接收待确认");
    expect(screen.getByRole("button", { name: "显式重试原冻结交接" })).toBeEnabled();
    expect(mocked.send).not.toHaveBeenCalled(); expect(mocked.reconcile).not.toHaveBeenCalled();
  });
  it("double-click cannot initiate duplicate actions while its first response is outstanding", async () => {
    const request = defer<Delivery>(); mocked.send.mockReturnValue(request.promise);
    show(); await ready();
    const button = screen.getByRole("button", { name: "发送此冻结版本" });
    fireEvent.click(button); fireEvent.click(button);
    expect(mocked.send).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve(started()); });
  });
  it("reconcile is explicitly triggered with its own stable body and never calls send on a not-found result", async () => {
    const user = userEvent.setup(); mocked.get.mockResolvedValue(started()); mocked.reconcile.mockResolvedValue({ ...started(), last_error: "DIRECT_RECEIPT_NOT_FOUND" });
    show(); await ready("产品管理接收待确认");
    await user.click(screen.getByRole("button", { name: "查询产品管理对账" }));
    await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(2));
    expect(mocked.reconcile.mock.calls[0][1]).toEqual({ request_id: expect.any(String), expected_revision: 1 });
    expect(mocked.send).not.toHaveBeenCalled();
    expect(screen.queryByText("产品管理直接接收已确认")).not.toBeInTheDocument();
  });
  it("registers and downloads original evidence only on explicit actions, then append remains separate", async () => {
    const user = userEvent.setup(); const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mocked.get.mockResolvedValue(received(false));
    show(); await ready("产品管理直接接收已确认");
    await user.click(screen.getByRole("button", { name: "登记冻结证据补充" }));
    await screen.findByText(/已登记 STSUP-ui-fixture/);
    expect(mocked.register).toHaveBeenCalledTimes(1); expect(mocked.supplement).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "下载原始冻结证据" }));
    await screen.findByText(/已下载并校验原始冻结证据文件/);
    expect(mocked.download.mock.calls[0][1]).toEqual(registered);
    expect(click).toHaveBeenCalledTimes(1); expect(mocked.send).not.toHaveBeenCalled();
    mocked.get.mockResolvedValue(received(false, true));
    await user.click(screen.getByRole("button", { name: "明确追加冻结证据" }));
    await screen.findByText("后补冻结证据接收已确认");
    expect(mocked.supplement.mock.calls[0][1]).toEqual({ request_id: expect.any(String), expected_revision: 1 });
    expect(screen.getByText(/首次未附带冻结证据（null）/)).toBeVisible(); click.mockRestore();
  });
  it.each([401, 403])("%i clears previously received private data and pending controls without deleting the original stored action", async status => {
    const user = userEvent.setup(), onAuthError = vi.fn();
    sessionStorage.setItem(pendingKey(), JSON.stringify({ operation: "reconcile", body: { request_id: "private-action", expected_revision: 1 } }));
    mocked.get.mockResolvedValueOnce(received()).mockRejectedValue(new AdminError(status, "DIRECT_SCOPE_FORBIDDEN", "当前身份无权操作"));
    show({ onAuthError }); await ready("产品管理直接接收已确认");
    expect(screen.getByText(/private-action/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "读取当前状态" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("产品管理直接接收已确认")).not.toBeInTheDocument();
    expect(screen.queryByText(/DPRCV-ui-fixture/)).not.toBeInTheDocument();
    expect(screen.queryByText(/private-action/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(pendingKey())).toContain("private-action"); expect(onAuthError).toHaveBeenCalledTimes(1);
  });
  it("an invalid fresh receipt clears old success instead of continuing to claim confirmation", async () => {
    const user = userEvent.setup(); mocked.get.mockResolvedValueOnce(received()).mockRejectedValue(new AdminError(502, "DIRECT_RECEIPT_MISMATCH", "回执不匹配"));
    show(); await ready("产品管理直接接收已确认");
    await user.click(screen.getByRole("button", { name: "读取当前状态" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("产品管理直接接收已确认")).not.toBeInTheDocument();
  });
  it("late read from the previous session cannot restore that session's receipt or pending action", async () => {
    const request = defer<Delivery>(); mocked.get.mockReturnValueOnce(request.promise).mockResolvedValue(notStarted());
    const view = show(); await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(1));
    view.rerender(<DirectDelivery handoff={handoff} sessionNamespace="different-admin-session" />);
    await ready();
    await act(async () => { request.resolve(received()); });
    expect(screen.queryByText("产品管理直接接收已确认")).not.toBeInTheDocument();
  });
  it("new session namespace does not expose or replay the previous session's pending request", async () => {
    sessionStorage.setItem(pendingKey(), JSON.stringify({ operation: "send", body: { request_id: "private-old-request", expected_revision: 1, include_supplement: false } }));
    show({ sessionNamespace: "new-admin-session" }); await ready();
    expect(screen.queryByText(/private-old-request/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(sessionStorage.getItem(pendingKey())).toContain("private-old-request");
    expect(mocked.send).not.toHaveBeenCalled();
  });
  it("a late action completion after unmount cannot read or expose private current data", async () => {
    const request = defer<Delivery>(); mocked.send.mockReturnValue(request.promise);
    const user = userEvent.setup(), view = show(); await ready();
    await user.click(screen.getByRole("button", { name: "发送此冻结版本" })); view.unmount();
    await act(async () => { request.resolve(received()); });
    expect(mocked.get).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(pendingKey())).not.toBeNull();
  });
  it("a current read cannot silently downgrade a stable received receipt", async () => {
    const user = userEvent.setup(); mocked.get.mockResolvedValueOnce(received()).mockResolvedValue(started());
    show(); await ready("产品管理直接接收已确认");
    await user.click(screen.getByRole("button", { name: "读取当前状态" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("DIRECT_FROZEN_CONFLICT");
    expect(screen.queryByText("产品管理接收待确认")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显式重试原冻结交接" })).not.toBeInTheDocument();
  });
  it("a failed read cannot erase the received anchor and let a subsequent old unconfirmed snapshot through", async () => {
    const user = userEvent.setup();
    mocked.get.mockResolvedValueOnce(received()).mockRejectedValueOnce(new AdminError(0, "NETWORK_ERROR", "网络中断")).mockResolvedValue(started());
    show(); await ready("产品管理直接接收已确认");
    await user.click(screen.getByRole("button", { name: "读取当前状态" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("NETWORK_ERROR");
    await user.click(screen.getByRole("button", { name: "读取当前状态" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("DIRECT_FROZEN_CONFLICT");
    expect(screen.queryByText("产品管理接收待确认")).not.toBeInTheDocument();
  });
  it("a failed late-receipt downgrade cannot erase the anchor and make the same downgrade valid on the next read", async () => {
    const user = userEvent.setup();
    mocked.get.mockResolvedValueOnce(received(false, true)).mockResolvedValue(received(false));
    show(); await ready("产品管理直接接收已确认");
    expect(screen.getByText("后补冻结证据接收已确认")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "读取当前状态" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("DIRECT_FROZEN_CONFLICT");
    await user.click(screen.getByRole("button", { name: "读取当前状态" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("DIRECT_FROZEN_CONFLICT");
    expect(screen.queryByText("产品管理直接接收已确认")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "明确追加冻结证据" })).not.toBeInTheDocument();
  });
  it("does not call POST if original request storage fails", async () => {
    const user = userEvent.setup(); show(); await ready();
    const store = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await user.click(screen.getByRole("button", { name: "发送此冻结版本" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("尚未发出请求"); expect(mocked.send).not.toHaveBeenCalled(); store.mockRestore();
  });
});

describe("management session namespace", () => {
  it("keeps reload namespace stable; explicit login rotates and logout removes its pointer without deleting old pending bodies", () => {
    const first = adminDirectSession(); expect(adminDirectSession()).toBe(first);
    sessionStorage.setItem(pendingKey(first), "original body");
    const next = adminDirectSession(true); expect(next).not.toBe(first);
    expect(sessionStorage.getItem(pendingKey(first))).toBe("original body");
    forgetAdminDirectSession(); expect(adminDirectSession()).not.toBe(next);
  });
});
