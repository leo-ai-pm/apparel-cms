import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DemoAccessBoundary, useDemoAccess } from "../components/demo-access-boundary";
import AdminContextBoundary, { type AdminContextAccess } from "../app/admin/AdminContextBoundary";
import { AdminError } from "../app/lib/admin-api";
const mocks = vi.hoisted(() => ({ caps: vi.fn(), enter: vi.fn(), me: vi.fn(), api: vi.fn() }));
vi.mock("../app/lib/demo-access", () => ({ fetchDemoCapability: mocks.caps, enterDemo: mocks.enter }));
vi.mock("../app/lib/admin-context", async original => ({ ...await original<typeof import("../app/lib/admin-context")>(), fetchAdminMe: mocks.me }));
vi.mock("../app/lib/admin-api", async original => ({ ...await original<typeof import("../app/lib/admin-api")>(), adminApi: mocks.api }));
const local = { contract_version: "styling_demo_access_v1", mode: "local_demo", login_required: false, shared_demo: true, roles: [] };
const ordinary = { ...local, mode: "authenticated", login_required: true, shared_demo: false };
const publicDemo = { ...local, mode: "public_demo" };
function Controls() { const demo = useDemoAccess()!; return <><p>business workspace</p><button onClick={demo.end}>end demo</button><button onClick={demo.invalidate}>expire demo</button></>; }
function Manager({ adminAccess }: { adminAccess: AdminContextAccess }) { return <><p>verified manager</p><button onClick={() => adminAccess.logout()}>session revoked</button><button onClick={() => void adminAccess.validate().catch(() => undefined)}>verify again</button></>; }
const me = (method = "demo_server", subject = "styling-demo-manager") => { const expires_at = new Date(Date.now() + 3600000).toISOString(); return { identity_contract: "styling_admin_identity_v1", subject, role: "styling-manager", audience: "personal_styling", scope: "test", source_instance_id: "test", auth_method: method, approval_identity_kind: "account_bound", expires_at, authorization_context: { context_contract: "styling_admin_context_v1", context_id: "a".repeat(43), expires_at } }; };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.caps.mockResolvedValue(local); mocks.enter.mockResolvedValue(undefined); mocks.me.mockResolvedValue(me()); });
afterEach(() => vi.restoreAllMocks());
it("does not mount business before enter succeeds, and fails honestly", async () => {
  let reject!: (value: Error) => void; mocks.enter.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  render(<DemoAccessBoundary role="consumer"><Controls /></DemoAccessBoundary>); await waitFor(() => expect(mocks.enter).toHaveBeenCalled()); expect(screen.queryByText("business workspace")).not.toBeInTheDocument();
  await act(async () => reject(new Error("service unavailable"))); expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable"); expect(screen.queryByText("business workspace")).not.toBeInTheDocument();
});
it("ordinary mode mounts consumer without enter or login", async () => {
  mocks.caps.mockResolvedValue(ordinary); render(<DemoAccessBoundary role="consumer"><Controls /></DemoAccessBoundary>); await screen.findByText("business workspace"); expect(mocks.enter).not.toHaveBeenCalled(); expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("ended demo never automatically re-enters until an explicit click", async () => {
  render(<DemoAccessBoundary role="consumer"><Controls /></DemoAccessBoundary>); await screen.findByText("business workspace"); await userEvent.click(screen.getByText("end demo")); await screen.findByRole("button", { name: "重新进入演示窗口" }); expect(mocks.enter).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "重新进入演示窗口" })); await screen.findByText("business workspace"); expect(mocks.enter).toHaveBeenCalledTimes(2);
});
it("mode-off focus probe unmounts the workspace, clears private bodies and makes no POST", async () => {
  render(<DemoAccessBoundary role="styling-manager"><Controls /></DemoAccessBoundary>); await screen.findByText("business workspace"); sessionStorage.setItem("styling.admin-context.private.v1:old", "old body");
  mocks.caps.mockResolvedValue(ordinary); await act(async () => window.dispatchEvent(new Event("focus"))); await waitFor(() => expect(screen.queryByLabelText("演示访问身份")).not.toBeInTheDocument()); expect(sessionStorage.getItem("styling.admin-context.private.v1:old")).toBeNull(); expect(mocks.enter).toHaveBeenCalledTimes(1);
});
it("ordinary to demo probe closes workspace until explicit enter", async () => {
  mocks.caps.mockResolvedValue(ordinary); render(<DemoAccessBoundary role="consumer"><Controls /></DemoAccessBoundary>); await screen.findByText("business workspace"); mocks.caps.mockResolvedValue(local); await act(async () => window.dispatchEvent(new Event("focus"))); await screen.findByRole("alert"); expect(screen.queryByText("business workspace")).not.toBeInTheDocument(); expect(mocks.enter).not.toHaveBeenCalled();
});
it("manager enters without a password only after matching demo me", async () => {
  render(<DemoAccessBoundary role="styling-manager"><AdminContextBoundary workspace={Manager} /></DemoAccessBoundary>); await screen.findByText("verified manager"); expect(screen.queryByLabelText("管理员密码")).not.toBeInTheDocument(); expect(mocks.enter.mock.calls[0][0]).toBe("styling-manager"); expect(mocks.api).not.toHaveBeenCalled();
});
it.each([me("password_single_account"), me("demo_server", "wrong-subject")])("mismatched manager fails closed without a login form %#", async identity => {
  mocks.me.mockResolvedValue(identity); render(<DemoAccessBoundary role="styling-manager"><AdminContextBoundary workspace={Manager} /></DemoAccessBoundary>); await screen.findByRole("button", { name: "重新读取模式并进入" }); expect(screen.queryByText("verified manager")).not.toBeInTheDocument(); expect(screen.queryByLabelText("管理员密码")).not.toBeInTheDocument(); expect(mocks.enter).toHaveBeenCalledTimes(1);
});
it("server session rejection restores ordinary password entry after mode-off probe", async () => {
  render(<DemoAccessBoundary role="styling-manager"><AdminContextBoundary workspace={Manager} /></DemoAccessBoundary>); await screen.findByText("verified manager"); mocks.me.mockRejectedValue(new AdminError(401, "ADMIN_SESSION_EXPIRED", "expired")); mocks.caps.mockResolvedValue(ordinary);
  await userEvent.click(screen.getByText("verify again")); await screen.findByLabelText("管理员密码"); expect(mocks.enter).toHaveBeenCalledTimes(1); expect(mocks.api).not.toHaveBeenCalled();
});
it("server-revoked logout shows explicit ended state, without automatic enter", async () => {
  render(<DemoAccessBoundary role="styling-manager"><AdminContextBoundary workspace={Manager} /></DemoAccessBoundary>); await screen.findByText("verified manager"); await userEvent.click(screen.getByText("session revoked")); await screen.findByRole("button", { name: "重新进入演示窗口" }); expect(mocks.enter).toHaveBeenCalledTimes(1); expect(screen.queryByLabelText("管理员密码")).not.toBeInTheDocument();
});
it.each(["consumer", "styling-manager"] as const)("public %s enters before mounting and keeps an explicit end state", async role => {
  mocks.caps.mockResolvedValue(publicDemo); mocks.me.mockResolvedValue(me("demo_server", "styling-public-20261010"));
  render(<DemoAccessBoundary role={role}>{role === "consumer" ? <Controls /> : <AdminContextBoundary workspace={Manager} />}</DemoAccessBoundary>);
  await screen.findByText(role === "consumer" ? "business workspace" : "verified manager");
  expect(mocks.enter.mock.calls[0][0]).toBe(role); expect(screen.getByLabelText("演示访问身份")).toHaveTextContent("公开合成演示");
  expect(screen.queryByLabelText("管理员密码")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText(role === "consumer" ? "end demo" : "session revoked"));
  await screen.findByRole("button", { name: "重新进入演示窗口" }); expect(mocks.enter).toHaveBeenCalledTimes(1);
});
it("public manager rejects ordinary authentication and never opens the password flow", async () => {
  mocks.caps.mockResolvedValue(publicDemo); mocks.me.mockResolvedValue(me("password_single_account", "styling-public-20261010"));
  render(<DemoAccessBoundary role="styling-manager"><AdminContextBoundary workspace={Manager} /></DemoAccessBoundary>);
  await screen.findByRole("button", { name: "重新读取模式并进入" }); expect(screen.queryByText("verified manager")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("管理员密码")).not.toBeInTheDocument(); expect(mocks.api).not.toHaveBeenCalled();
});
it("local to public mode probe clears old private actions and requires explicit enter", async () => {
  render(<DemoAccessBoundary role="styling-manager"><Controls /></DemoAccessBoundary>); await screen.findByText("business workspace");
  sessionStorage.setItem("styling.admin-context.private.v1:old", "old body"); mocks.caps.mockResolvedValue(publicDemo);
  await act(async () => window.dispatchEvent(new Event("focus"))); await screen.findByRole("alert");
  expect(screen.queryByText("business workspace")).not.toBeInTheDocument(); expect(sessionStorage.getItem("styling.admin-context.private.v1:old")).toBeNull();
  expect(mocks.enter).toHaveBeenCalledTimes(1); await userEvent.click(screen.getByRole("button", { name: "重新读取模式并进入" }));
  await screen.findByText("business workspace"); expect(mocks.enter).toHaveBeenCalledTimes(2);
});
