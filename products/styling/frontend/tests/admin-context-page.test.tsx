import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminPage from "../app/admin/page";
import { AdminError, type Overview } from "../app/lib/admin-api";
import { adminIdentityNamespace, type AdminAction, type AdminIdentity, type AdminOperation } from "../app/lib/admin-context";
import { saveAdminNote } from "../app/admin/use-admin-action";

const mocks = vi.hoisted(() => ({ me: vi.fn(), api: vi.fn(), execute: vi.fn(), operation: vi.fn() }));
vi.mock("../app/lib/admin-api", async original => ({ ...await original<typeof import("../app/lib/admin-api")>(), adminApi: mocks.api }));
vi.mock("../app/lib/admin-context", async original => ({ ...await original<typeof import("../app/lib/admin-context")>(), fetchAdminMe: mocks.me, readAdminContextResource: mocks.api, executeAdminAction: mocks.execute, getAdminOperation: mocks.operation }));
const expiry = new Date(Date.now() + 3600000).toISOString();
const identity = (context = "a", subject = "manager-one"): AdminIdentity => ({ identity_contract: "styling_admin_identity_v1", subject, role: "styling-manager", audience: "personal_styling", scope: "scope-one", source_instance_id: "source-one", auth_method: "password_single_account", approval_identity_kind: "account_bound", expires_at: expiry, authorization_context: { context_contract: "styling_admin_context_v1", context_id: context.repeat(43), expires_at: expiry } });
const counts = { turns: 0, occurrences: 0, groups: 0, pending: 0, pending_handoffs: 0, tasks: 0, succeeded: 0, failed: 0, processing: 0 };
const overview = (): Overview => ({ scope: "scope-one", days: 7, window_start: "2026-10-01T00:00:00Z", window_end: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z", receiver_configured: true, groups: [], groups_total: 0, page: 1, page_size: 20, has_more: false, counts: { ...counts }, turns: [], images: [], storage: { database: "private database", results: "private results", uploads: "private uploads", raw_photo_policy: "delete" } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const privatePrefix = (value: AdminIdentity) => `styling.admin-context.private.v1:${encodeURIComponent(adminIdentityNamespace(value))}:`;
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ADMIN_CONTEXT_REQUIRED", "1"); sessionStorage.clear(); vi.clearAllMocks(); mocks.me.mockResolvedValue(identity());
  mocks.api.mockImplementation(async (path: string) => path.startsWith("overview?") ? overview() : { status: "logged_in" });
  mocks.execute.mockResolvedValue({ status: "logged_out" });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("trusted management page", () => {
  it.each([404, 503])("fails closed before private reads when me gives %s", async status => {
    mocks.me.mockRejectedValue(new AdminError(status, "ADMIN_AUTH_UNAVAILABLE", "身份不可用")); render(<AdminPage />);
    expect(await screen.findByRole("button", { name: "重新读取当前管理身份" })).toBeVisible();
    expect(mocks.api).not.toHaveBeenCalled(); expect(screen.queryByText("需求热度榜单")).not.toBeInTheDocument();
  });
  it("login succeeds only after a new valid me and shows trusted actor without context contents", async () => {
    mocks.me.mockRejectedValueOnce(new AdminError(401, "UNAUTHORIZED", "请登录")); render(<AdminPage />); const user = userEvent.setup();
    await user.type(await screen.findByLabelText("管理员密码"), "isolated-password"); await user.click(screen.getByRole("button", { name: "登录并核对管理身份" }));
    expect(await screen.findByText("需求热度榜单")).toBeVisible(); expect(screen.getByText(/当前管理身份：manager-one/)).toBeVisible();
    expect(document.body.textContent).not.toContain("a".repeat(43)); expect(mocks.api.mock.calls[0]).toEqual(["login", { password: "isolated-password" }]);
    expect(screen.getByRole("link", { name: "消费者窗口（新标签页打开）" })).toHaveAttribute("target", "_blank");
  });
  it("does not read overview when login works but trusted me fails", async () => {
    mocks.me.mockRejectedValueOnce(new AdminError(401, "UNAUTHORIZED", "请登录")).mockRejectedValue(new AdminError(503, "ADMIN_AUTH_UNAVAILABLE", "不可用")); render(<AdminPage />); const user = userEvent.setup();
    await user.type(await screen.findByLabelText("管理员密码"), "isolated-password"); await user.click(screen.getByRole("button", { name: "登录并核对管理身份" }));
    await screen.findByRole("button", { name: "重新读取当前管理身份" }); expect(mocks.api.mock.calls.map(call => call[0])).toEqual(["login"]);
  });
  it("clears private records and notes on 401 while retaining only safe operation references", async () => {
    const owner = identity(); saveAdminNote(owner, "review", "private note");
    sessionStorage.setItem(`${privatePrefix(owner)}action:old`, "private body");
    sessionStorage.setItem(`styling.admin-context.references.v1:${encodeURIComponent(JSON.stringify([owner.source_instance_id, owner.scope, owner.subject]))}`, JSON.stringify([{ request_id: "original-id", operation_kind: "approve" }]));
    render(<AdminPage />); await screen.findByText("需求热度榜单"); mocks.me.mockRejectedValue(new AdminError(401, "UNAUTHORIZED", "已失效")); await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByLabelText("管理员密码"); expect(Object.keys(sessionStorage).filter(key => key.startsWith(privatePrefix(owner)))).toEqual([]);
    expect(Object.values(sessionStorage).join(" ")).toContain("original-id"); expect(Object.values(sessionStorage).join(" ")).not.toMatch(/private body|private note/);
  });
  it("unmounts old private view on context change and never renders its delayed GET", async () => {
    const hold = deferred<Overview>(); let count = 0;
    mocks.api.mockImplementation(async (path: string) => path.startsWith("overview?") && ++count === 2 ? hold.promise : overview());
    render(<AdminPage />); await screen.findByText("需求热度榜单"); await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(count).toBe(2)); mocks.me.mockResolvedValue(identity("b"));
    await act(async () => { hold.resolve({ ...overview(), counts: { ...counts, turns: 777 } }); });
    await screen.findByRole("button", { name: "重新读取当前管理身份" }); expect(screen.queryByText("777")).not.toBeInTheDocument(); expect(screen.queryByText("需求热度榜单")).not.toBeInTheDocument();
  });
  it("after successful logout clears private storage without querying operations with a revoked session", async () => {
    render(<AdminPage />); await screen.findByText("需求热度榜单"); saveAdminNote(identity(), "review", "private note");
    await userEvent.click(screen.getByRole("button", { name: "退出登录" })); await screen.findByLabelText("管理员密码");
    expect(mocks.execute).toHaveBeenCalledTimes(1); const action = mocks.execute.mock.calls[0][0] as AdminAction;
    expect(action.kind).toBe("logout"); expect(action.body.expected_admin_context).toEqual({ context_contract: "styling_admin_context_v1", context_id: "a".repeat(43) });
    expect(mocks.operation).not.toHaveBeenCalled(); expect(Object.keys(sessionStorage).filter(key => key.startsWith(privatePrefix(identity())))).toEqual([]);
  });
  it("safe recovery 404 remains read only and never creates an action", async () => {
    mocks.operation.mockRejectedValue(new AdminError(404, "NOT_FOUND", "未找到")); render(<AdminPage />); await screen.findByText("需求热度榜单"); const user = userEvent.setup();
    await user.click(screen.getByText("查询本人原管理操作（只读恢复）")); await user.type(screen.getByLabelText("原请求编号"), "original-id"); await user.click(screen.getByRole("button", { name: "只读查询原事实" }));
    expect(await screen.findByText(/这不代表远端未执行/)).toBeVisible(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("shows original reused-frozen fact and its actor in safe recovery", async () => {
    mocks.operation.mockResolvedValue({ operation_contract: "styling_admin_action_v1", request_id: "original-id", actor_subject: "manager-one", operation_kind: "approve", context_binding: "bound", operation_context_ref: "a".repeat(64), body_digest: "b".repeat(64), state: "completed", outcome: "reused_frozen", accepted_at: "2026-10-10T00:00:00Z", completed_at: "2026-10-10T00:00:01Z", result_ref: { kind: "handoff", id: "DH-original", revision: 1 } } satisfies AdminOperation);
    render(<AdminPage />); await screen.findByText("需求热度榜单"); const user = userEvent.setup(); await user.click(screen.getByText("查询本人原管理操作（只读恢复）")); await user.type(screen.getByLabelText("原请求编号"), "original-id"); await user.click(screen.getByRole("button", { name: "只读查询原事实" }));
    expect(await screen.findByText(/未创建当前管理员的新审批/)).toBeVisible(); expect(screen.getByText(/DH-original/)).toBeVisible(); expect(mocks.execute).not.toHaveBeenCalled();
  });
});

it("initial 401 erases all previously private context bodies even before me can identify an owner", async () => {
  sessionStorage.setItem(`${privatePrefix(identity())}action:old`, "old body"); saveAdminNote(identity("b"), "review", "old note");
  mocks.me.mockRejectedValue(new AdminError(401, "ADMIN_SESSION_EXPIRED", "已到期")); render(<AdminPage />); await screen.findByLabelText("管理员密码"); expect(Object.keys(sessionStorage).filter(key => key.startsWith("styling.admin-context.private.v1:"))).toEqual([]); expect(mocks.api).not.toHaveBeenCalled();
});
