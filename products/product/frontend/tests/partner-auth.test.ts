// @vitest-environment node
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AuthError, authenticate, createSession, hashPassword, readSession, requirePerson, recheckPerson, reservedUsernames, SESSION_COOKIE, validateContext, authErrorResponse } from "@/lib/auth";
import { withIdentityDb, createStaffInvite, getRegisteredUser, registerStaff, registerStaffSelf } from "@/lib/users-db";
import { readAuthConfig } from "@/lib/partner-auth-config";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as invite } from "@/app/api/team/invites/route";
import { proxy } from "@/proxy";
let directory: string, configPath: string, dbPath: string;
let cfg: { instance_id: string; authorized_scope: string; origin: string };
const origin = "http://localhost:3191", password = "synthetic-person-password";
function request(endpoint = "/api/auth/me", token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); if (token) headers.set("Cookie", `${SESSION_COOKIE}=${token}`);
  return new NextRequest(`${cfg.origin}${endpoint}`, { ...init, headers, signal: init.signal ?? undefined });
}
function form(endpoint: string, values: Record<string, string>, extra: Record<string, string> = {}) {
  return request(endpoint, undefined, { method: "POST", headers: { Origin: cfg.origin, "Content-Type": "application/x-www-form-urlencoded", ...extra }, body: new URLSearchParams(values) });
}
function person(role: "staff" | "manager" = "staff") {
  const token = createSession({ username: role === "staff" ? "worker" : "manager", role });
  return { token, identity: requirePerson(request(undefined, token)) };
}
function writing(token: string, csrf: string, endpoint = "/api/auth/logout") {
  return request(endpoint, token, { method: "POST", headers: { Origin: cfg.origin, "X-CSRF-Token": csrf } });
}
function expectCode(fn: () => unknown, code: string) {
  try { fn(); throw new Error("expected safe failure"); } catch (error) { expect(error).toBeInstanceOf(AuthError); expect((error as AuthError).code).toBe(code); }
}
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "partner-auth-synthetic-")); configPath = path.join(directory, "private.json"); dbPath = path.join(directory, "identity.sqlite");
  cfg = { instance_id: "product-test", authorized_scope: "synthetic-a", origin }; writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
  vi.stubEnv("WORKBENCH_CONFIG_FILE", configPath); vi.stubEnv("WORKBENCH_USERS_DB", dbPath); vi.stubEnv("WORKBENCH_SESSION_SECRET", randomBytes(32).toString("hex"));
  vi.stubEnv("WORKBENCH_STAFF_USERNAME", "worker"); vi.stubEnv("WORKBENCH_STAFF_PASSWORD_HASH", hashPassword(password));
  vi.stubEnv("WORKBENCH_MANAGER_USERNAME", "manager"); vi.stubEnv("WORKBENCH_MANAGER_PASSWORD_HASH", hashPassword(password));
  vi.stubEnv("WORKBENCH_STAFF_ENABLED", "true"); vi.stubEnv("WORKBENCH_MANAGER_ENABLED", "true"); vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("persistent personnel identity", () => {
  it("logs in with an opaque cookie, contracted me response and only persisted hashes", async () => {
    const response = await login(form("/api/auth/login", { username: "worker", password }));
    expect(response.status).toBe(303); expect(response.headers.get("location")).toBe(`${origin}/workbench`);
    const cookie = response.headers.get("set-cookie")!; expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=strict"); expect(cookie).toContain("Max-Age=28800");
    const token = cookie.split(";")[0].slice(SESSION_COOKIE.length + 1); expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const responseMe = me(request(undefined, token)); expect(responseMe.status).toBe(200); const data = await responseMe.json();
    expect(Object.keys(data).sort()).toEqual(["access", "capabilities", "context", "csrf_token", "user"]);
    expect(data.access).toEqual({ mode: "normal", synthetic_identity: false, role: "staff" });
    expect(data.user).toEqual({ username: "worker", role: "staff", scope: "synthetic-a" });
    expect(data.context).toEqual({ subject: "worker", session_id: expect.stringMatching(/^PS-/), session_revision: 1, instance_id: "product-test", scope: "synthetic-a" });
    expect(data.capabilities).toEqual({ paid_models: false }); expect(data.context.session_id).not.toBe(token);
    const bytes = readFileSync(dbPath); expect(bytes.includes(Buffer.from(token))).toBe(false); expect(bytes.includes(Buffer.from(data.csrf_token))).toBe(false);
    expect(readSession(token)).toEqual(data.user);
  });
  it("sets Secure according to configured HTTPS", async () => {
    cfg.origin = "https://product.example.test"; writeFileSync(configPath, JSON.stringify(cfg));
    const response = await login(form("/api/auth/login", { username: "manager", password })); expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Secure");
  });
  it.each([undefined, "http://localhost:3192", "https://localhost:3191", "http://localhost:3191/", "not-a-url"])("requires exact Origin %s", async supplied => {
    const req = form("/api/auth/login", { username: "worker", password }); if (supplied === undefined) req.headers.delete("Origin"); else req.headers.set("Origin", supplied);
    const response = await login(req); expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("ORIGIN_FORBIDDEN");
  });
  it("never trusts Host for redirects", async () => { const response = await login(form("/api/auth/login", { username: "worker", password }, { Host: "attacker.invalid" })); expect(response.headers.get("location")).toBe(`${origin}/workbench`); });
  it("logout revokes the persisted credential and captured personnel object", async () => {
    const { token, identity } = person(); const response = await logout(writing(token, identity.csrf_token)); expect(response.status).toBe(200); expect(await response.json()).toEqual({ logged_out: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0"); expect(me(request(undefined, token)).status).toBe(401); expectCode(() => recheckPerson(identity), "UNAUTHORIZED");
  });
  it.each(["missing", "wrong", "bad-origin"])("rejects write guard %s without revoking valid identity", async kind => {
    const { token, identity } = person(); const req = writing(token, identity.csrf_token);
    if (kind === "missing") req.headers.delete("X-CSRF-Token"); if (kind === "wrong") req.headers.set("X-CSRF-Token", "synthetic-wrong"); if (kind === "bad-origin") req.headers.set("Origin", "http://localhost:3192");
    expect((await logout(req)).status).toBe(403); expect(me(request(undefined, token)).status).toBe(200);
  });
  it.each(["Authorization", "X-Handoff-Key", "X-Signal-Key", "X-API-Key"])("rejects mixed identity %s", async header => {
    const { token } = person(); const response = me(request(undefined, token, { headers: { [header]: "synthetic-service-only" } })); expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("AUTH_IDENTITY_CONFLICT");
  });
  it("rejects other-product, duplicate and tampered cookies", () => {
    const { token } = person(); expect(me(request(undefined, undefined, { headers: { Cookie: "design_session=synthetic" } })).status).toBe(401);
    expect(me(request(undefined, undefined, { headers: { Cookie: `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}` } })).status).toBe(403); expect(me(request(undefined, `${token}x`)).status).toBe(401);
  });
  it("new login changes context and revokes only the supplied old browser session", () => {
    const first = person(), other = person(); const token = createSession(first.identity.user, first.token); const next = requirePerson(request(undefined, token));
    expectCode(() => validateContext(next.context, first.identity.context), "CONTEXT_CONFLICT"); expect(me(request(undefined, first.token)).status).toBe(401); expect(me(request(undefined, other.token)).status).toBe(200);
  });
  it.each(["subject", "session_id", "session_revision", "instance_id", "scope", "extra", "missing"])("rejects wrong context %s", key => {
    const { identity } = person(); const expected: Record<string, unknown> = { ...identity.context }; if (key === "missing") delete expected.scope; else expected[key] = "wrong";
    expectCode(() => validateContext(identity.context, expected), "CONTEXT_CONFLICT"); validateContext(identity.context, { ...identity.context });
  });
  it("expires exactly at idle boundary; failed CSRF does not refresh", () => {
    vi.useFakeTimers(); const { token, identity } = person(); vi.setSystemTime(Date.now() + 29 * 60 * 1000); expectCode(() => requirePerson(writing(token, "wrong"), true), "CSRF_FORBIDDEN");
    vi.setSystemTime(Date.now() + 60 * 1000); expect(me(request(undefined, token)).status).toBe(401); expectCode(() => recheckPerson(identity), "UNAUTHORIZED");
  });
  it("expires at eight hours despite repeated activity", () => {
    vi.useFakeTimers(); const { token } = person(); for (let step = 0; step < 31; step++) { vi.setSystemTime(Date.now() + 15 * 60 * 1000); expect(me(request(undefined, token)).status).toBe(200); }
    vi.setSystemTime(Date.now() + 15 * 60 * 1000); expect(me(request(undefined, token)).status).toBe(401);
  });
  it("recheck does not update idle or request a nested write lock", () => {
    const { identity } = person(); const before = withIdentityDb(db => db.prepare("SELECT last_seen FROM sessions WHERE session_id=?").get(identity.context.session_id));
    withIdentityDb(() => expect(recheckPerson(identity)).toEqual(identity), true); expect(withIdentityDb(db => db.prepare("SELECT last_seen FROM sessions WHERE session_id=?").get(identity.context.session_id))).toEqual(before);
  });
  it.each(["disabled", "password", "secret"])("revokes bootstrap identity after %s changes", kind => {
    const { token, identity } = person(); const oldHash = process.env.WORKBENCH_STAFF_PASSWORD_HASH!;
    if (kind === "disabled") vi.stubEnv("WORKBENCH_STAFF_ENABLED", "false"); if (kind === "password") vi.stubEnv("WORKBENCH_STAFF_PASSWORD_HASH", hashPassword("synthetic-new-password")); if (kind === "secret") vi.stubEnv("WORKBENCH_SESSION_SECRET", randomBytes(32).toString("hex"));
    expect(me(request(undefined, token)).status).toBe(401); expectCode(() => recheckPerson(identity), "UNAUTHORIZED"); vi.stubEnv("WORKBENCH_STAFF_ENABLED", "true"); vi.stubEnv("WORKBENCH_STAFF_PASSWORD_HASH", oldHash); expect(me(request(undefined, token)).status).toBe(401);
  });
  it.each(["active", "password_hash"])("rechecks registered staff %s", field => {
    const code = createStaffInvite("manager").code; expect(registerStaff("invited", "合成员工", hashPassword(password), code, reservedUsernames())).toBe("ok"); const token = createSession({ username: "invited", role: "staff" });
    withIdentityDb(db => { if (field === "active") db.prepare("UPDATE users SET active=0 WHERE username='invited'").run(); else db.prepare("UPDATE users SET password_hash=? WHERE username='invited'").run(hashPassword("synthetic-new-password")); }, true);
    expect(me(request(undefined, token)).status).toBe(401);
  });
  it("refuses an unowned existing database without changing bytes", () => {
    const db = new DatabaseSync(dbPath); db.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('synthetic')"); db.close(); chmodSync(dbPath, 0o600); const before = readFileSync(dbPath);
    expectCode(() => withIdentityDb(() => undefined), "STORAGE_UNAVAILABLE"); expect(readFileSync(dbPath)).toEqual(before);
  });
  it.each(["schema_version", "instance_id", "scope"])("refuses incompatible database ownership %s", field => {
    person(); withIdentityDb(db => { if (field === "schema_version") db.prepare("UPDATE partner_identity_meta SET schema_version=99").run(); else if (field === "instance_id") db.prepare("UPDATE partner_identity_meta SET instance_id='other'").run(); else db.prepare("UPDATE partner_identity_meta SET scope='other'").run(); }, true);
    const before = readFileSync(dbPath); expectCode(() => withIdentityDb(() => undefined), "STORAGE_UNAVAILABLE"); expect(readFileSync(dbPath)).toEqual(before);
  });
  it.each(["scope", "instance"])("does not reuse cookies across %s", field => {
    const { token } = person(); if (field === "scope") cfg.authorized_scope = "synthetic-b"; else cfg.instance_id = "product-other"; writeFileSync(configPath, JSON.stringify(cfg));
    vi.stubEnv("WORKBENCH_USERS_DB", path.join(directory, "other.sqlite")); expect(me(request(undefined, token)).status).toBe(401);
  });
  it.each(["permissions", "duplicate", "http-remote", "path-origin"])("rejects bad configuration %s", kind => {
    if (kind === "permissions") chmodSync(configPath, 0o644);
    if (kind === "duplicate") writeFileSync(configPath, `{"instance_id":"a","instance_id":"b","authorized_scope":"synthetic-a","origin":"${origin}"}`);
    if (kind === "http-remote") writeFileSync(configPath, JSON.stringify({ ...cfg, origin: "http://remote.example.test" })); if (kind === "path-origin") writeFileSync(configPath, JSON.stringify({ ...cfg, origin: `${origin}/path` })); expectCode(readAuthConfig, "NOT_CONFIGURED");
  });
});
describe("controlled invitation and closed route boundary", () => {
  it("closes self registration and consumes each invitation only once", async () => {
    expect(registerStaffSelf("synthetic")).toBe("invite"); const values = { username: "invited", displayName: "合成员工", password, confirm: password };
    expect((await register(form("/api/auth/register", values))).headers.get("location")).toBe(`${origin}/register?error=invite`); expect(getRegisteredUser("invited")).toBeNull();
    const manager = person("manager"), response = invite(writing(manager.token, manager.identity.csrf_token, "/api/team/invites")); expect(response.status).toBe(200); const issued = await response.json();
    expect(issued.link).toBe(`${origin}/register`); expect(issued.link).not.toContain(issued.code); expect(readFileSync(dbPath).includes(Buffer.from(issued.code))).toBe(false);
    expect((await register(form("/api/auth/register", { ...values, code: issued.code }))).headers.get("location")).toBe(`${origin}/workbench`);
    expect(authenticate("invited", password)).toEqual({ username: "invited", role: "staff", scope: cfg.authorized_scope });
    expect((await register(form("/api/auth/register", { ...values, username: "second", code: issued.code }))).headers.get("location")).toContain("error=invite"); expect(getRegisteredUser("second")).toBeNull();
  });
  it("requires a manager and valid CSRF to create invitations", () => {
    const staff = person(); expect(invite(writing(staff.token, staff.identity.csrf_token, "/api/team/invites")).status).toBe(403); const manager = person("manager");
    expect(invite(request("/api/team/invites", manager.token, { method: "POST", headers: { Origin: origin } })).status).toBe(403);
  });
  it("concurrent registration consumes one invitation for only one account", async () => {
    const code = createStaffInvite("manager").code;
    const responses = await Promise.all(["invite-one", "invite-two"].map(username => register(form("/api/auth/register", { username, displayName: "合成员工", password, confirm: password, code }))));
    expect(responses.map(item => item.headers.get("location")).sort()).toEqual([`${origin}/register?error=invite`, `${origin}/workbench`].sort());
    const users = withIdentityDb(db => db.prepare("SELECT username FROM users").all());
    expect(users).toHaveLength(1);
    expect(withIdentityDb(db => db.prepare("SELECT COUNT(*) AS count FROM sessions").get())?.count).toBe(1);
  });
  it("duplicate cookies fail before consuming a registration invitation", async () => {
    const code = createStaffInvite("manager").code;
    const req = form("/api/auth/register", { username: "invited", displayName: "合成员工", password, confirm: password, code }, { Cookie: `${SESSION_COOKIE}=one; ${SESSION_COOKIE}=two` });
    expect((await register(req)).status).toBe(403);
    expect(getRegisteredUser("invited")).toBeNull();
    expect(registerStaff("invited", "合成员工", hashPassword(password), code, reservedUsernames())).toBe("ok");
  });
  it("refuses expired invitations and reserved account names", () => {
    vi.useFakeTimers(); const issued = createStaffInvite("manager"); expect(registerStaff("manager", "合成经理", hashPassword(password), issued.code, reservedUsernames())).toBe("username");
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000); expect(registerStaff("invited", "合成员工", hashPassword(password), issued.code, reservedUsernames())).toBe("invite");
  });
  it("rejects duplicate, unknown and oversized form fields", async () => {
    expect((await login(request("/api/auth/login", undefined, { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "username=worker&username=manager&password=synthetic" }))).status).toBe(422);
    expect((await register(form("/api/auth/register", { role: "manager" }))).status).toBe(422); expect((await login(form("/api/auth/login", { username: "worker", password: "x".repeat(18000) }))).status).toBe(413);
  });
  it("blocks old business APIs and enforces manager and machine route separation", () => {
    const staff = person(), manager = person("manager");
    for (const endpoint of ["/api/drafts", "/api/packages", "/api/pull", "/api/agent/signals", "/api/workbench/unknown"]) { expect(proxy(request(endpoint)).status).toBe(401); expect(proxy(request(endpoint, staff.token)).status).toBe(403); }
    expect(proxy(request("/api/agent/analyze", staff.token)).status).toBe(503); expect(proxy(request("/team", staff.token)).status).toBe(403);
    expect(proxy(request("/team", manager.token)).headers.get("x-middleware-next")).toBe("1"); expect(proxy(request("/api/workbench/signals", staff.token)).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/api/workbench/receipts/id/payload", staff.token)).status).toBe(403); expect(proxy(request("/api/design-link/packages", manager.token)).status).toBe(403);
    expect(proxy(request("/api/design-link/packages", undefined, { headers: { Authorization: "Bearer synthetic-service" } })).headers.get("x-middleware-next")).toBe("1");
  });
  it("does not expose internal exceptions", async () => { const response = authErrorResponse(new Error("synthetic-secret-and-private-path")); expect(response.status).toBe(503); const data = await response.json(); expect(data.error.code).toBe("STORAGE_UNAVAILABLE"); expect(JSON.stringify(data)).not.toContain("synthetic-secret"); expect(data.request_id).toBeTruthy(); });
});
