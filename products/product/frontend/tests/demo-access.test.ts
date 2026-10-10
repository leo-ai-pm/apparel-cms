// @vitest-environment node
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, DEMO_COOKIES, demoAccessEnabled, hashPassword, pageDemoRole, prepareDemoRequest, readPagePerson, recheckPerson, requirePerson, SESSION_COOKIE, validateContext, type PersonSession } from "@/lib/auth";
import { withIdentityDb } from "@/lib/users-db";
import { demoAccessState } from "@/lib/demo-access-store";
import { authorizeService } from "@/lib/handoff-auth";
import { GET as me } from "@/app/api/auth/me/route";
import { GET as entry } from "@/app/api/auth/demo/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as invite } from "@/app/api/team/invites/route";
import { POST as batches } from "@/app/api/workbench/reasoning/batches/route";
import { GET as tasks } from "@/app/api/workbench/reasoning/tasks/route";
import { GET as detail } from "@/app/api/workbench/reasoning/tasks/[id]/route";
import { POST as action } from "@/app/api/workbench/reasoning/tasks/[id]/actions/route";
import { SAMPLE_BASE64 } from "@/lib/reasoning-sample";
import { withReasoningDb } from "@/lib/reasoning-store";
import { proxy } from "@/proxy";
vi.mock("server-only", () => ({}));
const origin = "http://localhost:3198", scope = "demo-isolated", roles = ["staff", "manager"] as const;
let directory: string, normal: string, configFile: string;
function request(url = "/api/auth/me", cookie = "", role?: string, body?: string, csrf?: string) {
  return new NextRequest(origin + url, { method: body === undefined ? "GET" : "POST", headers: { ...(cookie ? { cookie } : {}), ...(role ? { "X-Workbench-Demo-Role": role } : {}), origin, "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, ...(body === undefined ? {} : { body }) });
}
async function bootstrap(role: "staff" | "manager" = "staff") {
  const response = me(request(undefined, "", role)); expect(response.status).toBe(200);
  const person = await response.json() as PersonSession;
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  return { person, cookie, role };
}
function assertCode(fn: () => unknown, code: string) { expect(fn).toThrowError(expect.objectContaining({ code })); }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pa-demo-test-")); configFile = join(directory, "config.json");
  writeFileSync(configFile, JSON.stringify({ instance_id: "product-demo-test", authorized_scope: scope, origin, design_instance_id: "design-demo-test", services: [{ subject: "design-reader", purpose: "design_package_reader", source_instance_id: "design-demo-test", target_instance_id: "product-demo-test", authorized_scope: scope, token: "isolated-purpose-token-" + "t".repeat(32) }] }), { mode: 0o600 });
  const env = { WORKBENCH_CONFIG_FILE: configFile, WORKBENCH_USERS_DB: join(directory, "users.sqlite"), WORKBENCH_CASES_DB: join(directory, "cases.sqlite"), WORKBENCH_REASONING_DB: join(directory, "reasoning.sqlite"), WORKBENCH_DEMO_SESSIONS_DB: join(directory, "demo-access.sqlite"), WORKBENCH_STAFF_USERNAME: "product-staff-test", WORKBENCH_MANAGER_USERNAME: "product-manager-test", WORKBENCH_STAFF_PASSWORD_HASH: hashPassword("test-only-password"), WORKBENCH_MANAGER_PASSWORD_HASH: hashPassword("test-only-password"), WORKBENCH_SESSION_SECRET: randomBytes(32).toString("hex"), WORKBENCH_STAFF_ENABLED: "true", WORKBENCH_MANAGER_ENABLED: "true", WORKBENCH_DEMO_ACCESS: "false", NEXT_PUBLIC_BASE_PATH: "" };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  normal = createSession({ username: "product-manager-test", role: "manager" });
  for (const name of ["cases.sqlite", "intake.sqlite"]) writeFileSync(join(directory, name), "OLD-ISOLATED-" + name, { mode: 0o600 });
  vi.stubEnv("WORKBENCH_DEMO_ACCESS", "true");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network/model/design calls in demo tests"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("explicit local demo identity and separated cookies", () => {
  it("production Next proxy Request bootstraps me without reconstructing a native Request", async () => {
    const source = request();
    const proxied = new Proxy(source, { get(target, key) { return Reflect.get(target, key, target); } });
    const response = me(proxied); expect(response.status).toBe(200);
    expect((await response.json()).access).toEqual({ mode: "demo", synthetic_identity: true, role: "staff" });
    expect(response.headers.get("set-cookie")).toContain(DEMO_COOKIES.staff);
  });
  it("defaults absent API role to staff and creates no users, invitations, cases or reasoning", async () => {
    const response = me(request()); const data = await response.json();
    expect(data.user).toEqual({ username: "product-staff-test", role: "staff", scope });
    expect(data.access).toEqual({ mode: "demo", synthetic_identity: true, role: "staff" });
    expect(data.context.session_id).toMatch(/^PDS-/); expect(Object.keys(data.context)).toHaveLength(5);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(withIdentityDb(db => db.prepare("SELECT count(*) AS n FROM users").get()?.n)).toBe(0);
    expect(withIdentityDb(db => db.prepare("SELECT count(*) AS n FROM invites").get()?.n)).toBe(0);
    expect(existsSync(join(directory, "reasoning.sqlite"))).toBe(false);
    expect(readFileSync(join(directory, "cases.sqlite"), "utf8")).toBe("OLD-ISOLATED-cases.sqlite");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(roles)("entry %s redirects with matching HttpOnly cookie and fixed role", async role => {
    const response = entry(request(`/api/auth/demo?demo_role=${role}`));
    expect(response.status).toBe(303); expect(response.headers.get("location")).toBe(`${origin}/workbench?demo_role=${role}`);
    expect(response.headers.get("set-cookie")).toContain(DEMO_COOKIES[role] + "="); expect(response.headers.get("set-cookie")).toContain("HttpOnly"); expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    const person = requirePerson(request(undefined, response.headers.get("set-cookie")!.split(";")[0], role));
    expect(person.user.role).toBe(role); expect(person.context.subject).toBe(`product-${role}-test`);
  });
  it("two tabs select independent roles; default staff ignores valid ordinary manager", async () => {
    const staff = await bootstrap(), manager = await bootstrap("manager");
    const cookie = `${SESSION_COOKIE}=${normal}; ${staff.cookie}; ${manager.cookie}`;
    expect(requirePerson(request(undefined, cookie)).context).toEqual(staff.person.context);
    expect(requirePerson(request(undefined, cookie, "manager")).context).toEqual(manager.person.context);
    expect(me(request(undefined, cookie, "manager")).headers.get("set-cookie")).toBeNull();
    const values = new Map<string, string>(cookie.split("; ").map(c => { const [key, value] = c.split("="); return [key, value]; }));
    const store = { get: (name: string) => values.has(name) ? { value: values.get(name)! } : undefined };
    expect(readPagePerson(store, "staff")?.context).toEqual(staff.person.context);
    expect(readPagePerson(store, "manager")?.context).toEqual(manager.person.context);
    expect(proxy(request("/team?demo_role=staff", cookie)).status).toBe(403);
    expect(proxy(request("/team?demo_role=manager", cookie)).headers.get("x-middleware-next")).toBe("1");
  });
  it("first SSR request receives forwarded role cookie resolving the same person as me", async () => {
    const response = proxy(request("/workbench?demo_role=manager"));
    const forwarded = response.headers.get("x-middleware-request-cookie")!;
    expect(response.headers.get("x-middleware-request-x-workbench-demo-role")).toBe("manager");
    expect(response.headers.get("set-cookie")).toContain(forwarded);
    const person = requirePerson(request(undefined, forwarded, "manager"));
    expect((await me(request(undefined, forwarded, "manager")).json()).context).toEqual(person.context);
  });
  it("POST proxy forwards the unchanged body and selected existing identity", async () => {
    const manager = await bootstrap("manager"), raw = '{"action_id":"test-demo-only"}';
    const original = request("/api/workbench/actions", manager.cookie, "manager", raw, manager.person.csrf_token);
    const prepared = prepareDemoRequest(original);
    expect(await original.text()).toBe(raw); expect(prepared.cookie).toBeNull();
    expect(proxy(request("/api/workbench/actions", manager.cookie, "manager", raw, manager.person.csrf_token)).headers.get("x-middleware-next")).toBe("1");
  });
  it.each(["owner", "", "staff,manager"])("rejects invalid role header %s", async role => {
    const req = request(); req.headers.set("X-Workbench-Demo-Role", role);
    expect(me(req).status).toBe(400); expect(proxy(request("/api/workbench/signals", "", role || "invalid")).status).toBe(400);
  });
  it.each(["demo_role=owner", "demo_role=staff&demo_role=manager", "demo_role="])("rejects invalid page role %s", query => {
    expect(entry(request(`/api/auth/demo?${query}`)).status).toBe(400);
    expect(proxy(request(`/workbench?${query}`)).status).toBe(400);
    assertCode(() => pageDemoRole(request(`/workbench?${query}`)), "INVALID_DEMO_ROLE");
  });
  it("rejects duplicate selected cookies without minting a replacement", async () => {
    const staff = await bootstrap(); expect(me(request(undefined, `${staff.cookie}; ${staff.cookie}`)).status).toBe(403);
    expect(withIdentityDb(db => db.prepare("SELECT count(*) AS n FROM sessions").get()?.n)).toBe(2);
  });
  it("expired cookie recovers same actor with new session and leaves ordinary session intact", async () => {
    const staff = await bootstrap(); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    const response = me(request(undefined, staff.cookie)); const renewed = await response.json();
    expect(renewed.user).toEqual(staff.person.user); expect(renewed.context.session_id).not.toBe(staff.person.context.session_id);
    expect(response.headers.get("set-cookie")).toContain(DEMO_COOKIES.staff); expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(withIdentityDb(db => db.prepare("SELECT revoked_at FROM sessions WHERE session_id LIKE 'PS-%'").get()?.revoked_at)).toBeNull();
  });
});

describe("closed mode, ordinary sessions and write boundaries", () => {
  it.each(["false", undefined])("%s cannot enable demo and legal role headers do not change ordinary identity", value => {
    vi.stubEnv("WORKBENCH_DEMO_ACCESS", value); vi.stubEnv("NEXT_PUBLIC_WORKBENCH_DEMO_ACCESS", "true");
    expect(demoAccessEnabled()).toBe(false); expect(existsSync(join(directory, "demo-access.sqlite"))).toBe(false);
    const response = me(request(undefined, `${SESSION_COOKIE}=${normal}`, "staff")); expect(response.status).toBe(200);
    expect(requirePerson(request(undefined, `${SESSION_COOKIE}=${normal}`, "staff")).access).toEqual({ mode: "normal", synthetic_identity: false, role: "manager" });
    expect(entry(request("/api/auth/demo?demo_role=manager")).headers.get("location")).toBe(origin + "/login");
  });
  it("bad server switch and remote origin fail closed", () => {
    vi.stubEnv("WORKBENCH_DEMO_ACCESS", "yes"); assertCode(demoAccessEnabled, "DEMO_NOT_CONFIGURED");
    vi.stubEnv("WORKBENCH_DEMO_ACCESS", "true"); const cfg = JSON.parse(readFileSync(configFile, "utf8")); cfg.origin = "https://product.example.test"; writeFileSync(configFile, JSON.stringify(cfg));
    assertCode(demoAccessEnabled, "DEMO_NOT_CONFIGURED");
  });
  it("off transition invalidates transactions; reenable cannot revive old cookies or context", async () => {
    const staff = await bootstrap(); const before = demoAccessState().epoch;
    vi.stubEnv("WORKBENCH_DEMO_ACCESS", "false"); expect(demoAccessState().epoch).toBe(before + 1);
    assertCode(() => recheckPerson(staff.person), "UNAUTHORIZED");
    expect(me(request(undefined, staff.cookie)).status).toBe(401);
    expect(requirePerson(request(undefined, `${SESSION_COOKIE}=${normal}`)).access?.mode).toBe("normal");
    vi.stubEnv("WORKBENCH_DEMO_ACCESS", "true"); assertCode(() => requirePerson(request(undefined, staff.cookie)), "UNAUTHORIZED");
    const next = await bootstrap(); assertCode(() => validateContext(next.person.context, staff.person.context), "CONTEXT_CONFLICT");
  });
  it("switching off denies a demo token smuggled into ordinary cookie", async () => {
    const staff = await bootstrap(); vi.stubEnv("WORKBENCH_DEMO_ACCESS", "false");
    expect(me(request(undefined, `${SESSION_COOKIE}=${staff.cookie.split("=")[1]}`)).status).toBe(401);
  });
  it("login, registration and demo-manager invitations freeze before account writes", async () => {
    const manager = await bootstrap("manager");
    for (const handler of [login, register]) { const response = await handler(request("/api/auth/login", "", "manager", "not-a-form")); expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("LOGIN_FROZEN"); }
    expect(invite(request("/api/team/invites", manager.cookie, "manager", "{}", manager.person.csrf_token)).status).toBe(409);
    expect(withIdentityDb(db => db.prepare("SELECT count(*) AS n FROM users").get()?.n)).toBe(0);
    expect(withIdentityDb(db => db.prepare("SELECT count(*) AS n FROM invites").get()?.n)).toBe(0);
  });
  it.each(["csrf", "origin"])("retains %s guard on demo writes", async kind => {
    const staff = await bootstrap(), req = request("/api/auth/logout", staff.cookie, "staff", "{}", staff.person.csrf_token);
    if (kind === "csrf") req.headers.delete("x-csrf-token"); else req.headers.set("origin", "http://localhost:3199");
    expect((await logout(req)).status).toBe(403); expect(recheckPerson(staff.person).context).toEqual(staff.person.context);
  });
  it("logout clears only selected role and revokes only that session", async () => {
    const staff = await bootstrap(), manager = await bootstrap("manager"), cookie = `${staff.cookie}; ${manager.cookie}; ${SESSION_COOKIE}=${normal}`;
    const response = await logout(request("/api/auth/logout", cookie, "staff", "{}", staff.person.csrf_token));
    expect(await response.json()).toMatchObject({ redirect_to: "/demo/staff", access: { mode: "demo", role: "staff" } });
    expect(response.headers.get("set-cookie")).toContain(DEMO_COOKIES.staff + "="); expect(response.headers.get("set-cookie")).not.toContain(DEMO_COOKIES.manager); expect(response.headers.get("set-cookie")).not.toContain(SESSION_COOKIE);
    assertCode(() => recheckPerson(staff.person), "UNAUTHORIZED"); expect(recheckPerson(manager.person).context).toEqual(manager.person.context);
    vi.stubEnv("WORKBENCH_DEMO_ACCESS", "false"); expect(requirePerson(request(undefined, `${SESSION_COOKIE}=${normal}`)).user.role).toBe("manager");
  });
  it("service bearer remains purpose bound and cannot mix demo or ordinary identity", async () => {
    const req = request("/api/design-link/packages"); req.headers.set("authorization", "Bearer isolated-purpose-token-" + "t".repeat(32));
    expect(authorizeService(req, "design_package_reader").subject).toBe("design-reader");
    assertCode(() => authorizeService(req, "design_event_writer"), "FORBIDDEN");
    for (const cookie of [`${SESSION_COOKIE}=${normal}`, (await bootstrap()).cookie]) {
      const mixed = new NextRequest(req, { headers: { authorization: req.headers.get("authorization")!, cookie } });
      expect(proxy(mixed).status).toBe(403); assertCode(() => authorizeService(mixed, "design_package_reader"), "AUTH_IDENTITY_CONFLICT");
    }
    req.headers.set("X-Workbench-Demo-Role", "manager"); expect(proxy(req).status).toBe(403); assertCode(() => authorizeService(req, "design_package_reader"), "AUTH_IDENTITY_CONFLICT");
    expect(me(req).status).toBe(403);
  });
  it("sidecar refuses old unowned DB, unsafe permission and hardlink without changing bytes", () => {
    const file = join(directory, "demo-access.sqlite"), db = new DatabaseSync(file); db.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('keep')"); db.close(); chmodSync(file, 0o600);
    const before = readFileSync(file); assertCode(demoAccessEnabled, "DEMO_NOT_CONFIGURED"); expect(readFileSync(file)).toEqual(before);
    rmSync(file); linkSync(join(directory, "cases.sqlite"), file); assertCode(demoAccessEnabled, "DEMO_NOT_CONFIGURED"); expect(readFileSync(join(directory, "cases.sqlite"), "utf8")).toBe("OLD-ISOLATED-cases.sqlite");
    rmSync(file); demoAccessEnabled(); chmodSync(file, 0o644); assertCode(demoAccessEnabled, "DEMO_NOT_CONFIGURED");
  });
});

describe("demo credentials use actual reasoning handlers and audit context", () => {
  it("explicit import, assignment and employee analysis preserve exact identity, replay and old stores", async () => {
    const manager = await bootstrap("manager"), staff = await bootstrap();
    const protectedBytes = ["cases.sqlite", "intake.sqlite"].map(name => readFileSync(join(directory, name)));
    expect((await tasks(request("/api/workbench/reasoning/tasks", manager.cookie, "manager")).json()).tasks).toEqual([]);
    const common = (actor: typeof manager, current?: { task: { task_revision: number; assignment_version: number } }, id = randomBytes(8).toString("hex")) => ({ action_id: id, context_id: actor.person.context.session_id, expected_context: actor.person.context, expected_task_revision: current?.task.task_revision ?? 0, assignment_version: current?.task.assignment_version ?? 0 });
    const raw = JSON.stringify({ ...common(manager), input_base64: SAMPLE_BASE64 });
    const importedResponse = await batches(request("/api/workbench/reasoning/batches", manager.cookie, "manager", raw, manager.person.csrf_token)); expect(importedResponse.status).toBe(201); const imported = await importedResponse.json();
    expect((await batches(request("/api/workbench/reasoning/batches", staff.cookie, "staff", raw, staff.person.csrf_token))).status).toBe(403);
    const id = imported.task.task_id, params = { params: Promise.resolve({ id }) };
    expect((await detail(request(`/api/workbench/reasoning/tasks/${id}`, staff.cookie, "staff"), params)).status).toBe(404);
    const assignedResponse = await action(request(`/api/workbench/reasoning/tasks/${id}/actions`, manager.cookie, "manager", JSON.stringify({ ...common(manager, imported), action: "assign", assignee: "product-staff-test" }), manager.person.csrf_token), params); expect(assignedResponse.status).toBe(200); const assigned = await assignedResponse.json();
    const analyze = JSON.stringify({ ...common(staff, assigned), action: "analyze", input_revision: assigned.task.input_revision, input_digest: assigned.task.input_digest, method_version: "pmr-rules/1" });
    const response = await action(request(`/api/workbench/reasoning/tasks/${id}/actions`, staff.cookie, "staff", analyze, staff.person.csrf_token), params); expect(response.status).toBe(200); const analyzed = await response.json();
    expect((await action(request(`/api/workbench/reasoning/tasks/${id}/actions`, staff.cookie, "staff", analyze, staff.person.csrf_token), params)).status).toBe(200);
    expect(withReasoningDb(db => db.prepare("SELECT count(*) AS n FROM pmr_analyses").get()?.n)).toBe(1);
    const audit = withReasoningDb(db => db.prepare("SELECT actor,session_id FROM pmr_actions").all()); expect(JSON.stringify(audit)).toContain(staff.person.context.session_id); expect(JSON.stringify(audit)).toContain(manager.person.context.session_id);
    expect(analyzed.task.state).toBe("draft"); expect(withReasoningDb(db => db.prepare("SELECT count(*) AS n FROM pmr_decisions").get()?.n)).toBe(0);
    vi.stubEnv("WORKBENCH_DEMO_ACCESS", "false"); withReasoningDb(() => assertCode(() => recheckPerson(staff.person), "UNAUTHORIZED"), true);
    expect(["cases.sqlite", "intake.sqlite"].map(name => readFileSync(join(directory, name)))).toEqual(protectedBytes); expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
