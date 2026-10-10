import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withIdentityDb, type UserRow } from "./users-db";
import { readAuthConfig, type AuthConfig } from "./partner-auth-config";
import { AuthError } from "./partner-auth-error";
import { demoAccessState, registerDemoSession, validDemoSession } from "./demo-access-store";
export { AuthError, authErrorResponse } from "./partner-auth-error";

export type WorkbenchRole = "staff" | "manager";
export type WorkbenchUser = { username: string; role: WorkbenchRole; scope: string };
export type PersonContext = { subject: string; session_id: string; session_revision: number; instance_id: string; scope: string };
export type AccessMetadata = { mode: "demo" | "normal"; synthetic_identity: boolean; role: WorkbenchRole };
export type PersonSession = { user: WorkbenchUser; context: PersonContext; csrf_token: string; access?: AccessMetadata };
type PersonnelRequest = Pick<Request, "headers">;
export const SESSION_COOKIE = "zhixu_session";
export const DEMO_ROLE_HEADER = "x-workbench-demo-role";
export const DEMO_COOKIES = { staff: "zhixu_demo_staff", manager: "zhixu_demo_manager" } as const;
export function demoAccessEnabled() { return demoAccessState().enabled; }
export function demoRole(value: unknown): WorkbenchRole {
  if (value === undefined || value === null) return "staff";
  if (value !== "staff" && value !== "manager") throw new AuthError("INVALID_DEMO_ROLE", "演示角色只能为员工或负责人", 400);
  return value;
}
export function pageDemoRole(request: Request) {
  const values = new URL(request.url).searchParams.getAll("demo_role");
  if (values.length > 1) throw new AuthError("INVALID_DEMO_ROLE", "演示角色参数重复", 400);
  return demoRole(values[0]);
}
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const validHash = /^[a-f0-9]{32}:[a-f0-9]{128}$/;
const usernamePattern = /^[a-z0-9._-]{3,32}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

type Account = WorkbenchUser & { passwordHash: string; enabled: boolean };
type SessionRow = { token_hash: string; session_id: string; session_revision: number; username: string; role: WorkbenchRole;
  scope: string; instance_id: string; credential_fingerprint: string; csrf_hash: string; created_at: number;
  last_seen: number; expires_at: number; revoked_at: number | null };

function account(role: WorkbenchRole, cfg: AuthConfig): Account {
  const prefix = role === "staff" ? "STAFF" : "MANAGER";
  return { username: process.env[`WORKBENCH_${prefix}_USERNAME`] || "", role, scope: cfg.authorized_scope,
    passwordHash: process.env[`WORKBENCH_${prefix}_PASSWORD_HASH`] || "", enabled: process.env[`WORKBENCH_${prefix}_ENABLED`] !== "false" };
}
function configured(): AuthConfig {
  const cfg = readAuthConfig();
  const staff = account("staff", cfg), manager = account("manager", cfg);
  if ((process.env.WORKBENCH_SESSION_SECRET || "").length < 32 || !usernamePattern.test(staff.username)
    || !usernamePattern.test(manager.username) || staff.username === manager.username || !validHash.test(staff.passwordHash)
    || !validHash.test(manager.passwordHash)) throw new AuthError("NOT_CONFIGURED", "人员登录尚未配置，请联系维护人员。", 503);
  return cfg;
}
export function authConfigured() { try { configured(); return true; } catch { return false; } }
export function verifyPassword(password: string, stored: string) {
  if (!validHash.test(stored) || typeof password !== "string" || password.length > 128) return false;
  const [salt, expected] = stored.split(":");
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, "hex"));
}
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function reservedUsernames() {
  const cfg = configured();
  return [account("staff", cfg).username, account("manager", cfg).username];
}
function currentAccount(db: DatabaseSync, username: string, cfg: AuthConfig): Account | null {
  for (const role of ["staff", "manager"] as const) {
    const bootstrap = account(role, cfg);
    if (bootstrap.username === username) return bootstrap.enabled ? bootstrap : null;
  }
  const row = db.prepare("SELECT username,password_hash,active,scope FROM users WHERE username=?").get(username) as UserRow | undefined;
  return row?.active && row.scope === cfg.authorized_scope && validHash.test(row.password_hash)
    ? { username, role: "staff", scope: row.scope, enabled: true, passwordHash: row.password_hash } : null;
}
function publicUser(user: Account): WorkbenchUser { return { username: user.username, role: user.role, scope: user.scope }; }
function fingerprint(user: Account, cfg: AuthConfig) {
  return sha(JSON.stringify([cfg.instance_id, user.scope, user.username, user.role, user.passwordHash, process.env.WORKBENCH_SESSION_SECRET]));
}
export function authenticate(username: string, password: string): WorkbenchUser | null {
  const cfg = configured();
  if (!usernamePattern.test(username) || !password || password.length > 128) return null;
  return withIdentityDb(db => {
    const user = currentAccount(db, username, cfg);
    return user && verifyPassword(password, user.passwordHash) ? publicUser(user) : null;
  });
}
function csrfFor(token: string) { return createHmac("sha256", process.env.WORKBENCH_SESSION_SECRET || "").update(`product-management:csrf:${token}`).digest("base64url"); }
function equal(left: string, right: string) { return timingSafeEqual(Buffer.from(sha(left)), Buffer.from(sha(right))); }
function unauthorized(): never { throw new AuthError("UNAUTHORIZED", "请重新登录产品工作台。", 401); }

export function createSession(user: Pick<WorkbenchUser, "username" | "role"> & { scope?: string }, previousToken?: string) {
  return createPersonnelSession(user, previousToken, false);
}
function createPersonnelSession(user: Pick<WorkbenchUser, "username" | "role"> & { scope?: string }, previousToken: string | undefined, demo: boolean) {
  const cfg = configured(), token = randomBytes(32).toString("base64url"), now = Date.now();
  const sessionId = `${demo ? "PDS" : "PS"}-${randomUUID()}`;
  withIdentityDb(db => {
    const current = currentAccount(db, user.username, cfg);
    if (!current || current.role !== user.role || (user.scope !== undefined && current.scope !== user.scope)) unauthorized();
    if (previousToken && tokenPattern.test(previousToken)) db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(now, sha(previousToken));
    db.prepare("INSERT INTO sessions VALUES(?,?,1,?,?,?,?,?,?,?,?,?,NULL)").run(sha(token), sessionId, current.username,
      current.role, current.scope, cfg.instance_id, fingerprint(current, cfg), sha(csrfFor(token)), now, now, now + ABSOLUTE_MS);
  }, true);
  if (demo) registerDemoSession(sessionId, user.username, user.role);
  return token;
}
function inspectRow(db: DatabaseSync, row: SessionRow | undefined, cfg: AuthConfig): WorkbenchUser | null {
  if (!row || row.revoked_at !== null || row.instance_id !== cfg.instance_id || row.scope !== cfg.authorized_scope
    || row.expires_at <= Date.now() || row.last_seen + IDLE_MS <= Date.now() || row.session_revision !== 1) return null;
  if (row.session_id.startsWith("PDS-") && !validDemoSession(row.session_id, row.username, row.role)) return null;
  const user = currentAccount(db, row.username, cfg);
  return user && user.role === row.role && user.scope === row.scope && equal(fingerprint(user, cfg), row.credential_fingerprint) ? publicUser(user) : null;
}
function publicSession(row: SessionRow, user: WorkbenchUser, csrf: string): PersonSession {
  return { user, context: { subject: user.username, session_id: row.session_id, session_revision: row.session_revision,
    instance_id: row.instance_id, scope: row.scope }, csrf_token: csrf,
    access: { mode: row.session_id.startsWith("PDS-") ? "demo" : "normal", synthetic_identity: row.session_id.startsWith("PDS-"), role: user.role } };
}
function resolveToken(token: string | undefined, guard?: (person: PersonSession) => void): PersonSession {
  const cfg = configured();
  if (!token || !tokenPattern.test(token)) unauthorized();
  const person = withIdentityDb(db => {
    const row = db.prepare("SELECT * FROM sessions WHERE token_hash=?").get(sha(token)) as SessionRow | undefined;
    const user = inspectRow(db, row, cfg);
    if (!user || !row) {
      if (row && row.revoked_at === null) db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=?").run(Date.now(), row.token_hash);
      return null;
    }
    const csrf = csrfFor(token);
    if (!equal(sha(csrf), row.csrf_hash)) return null;
    const result = publicSession(row, user, csrf);
    guard?.(result);
    db.prepare("UPDATE sessions SET last_seen=? WHERE token_hash=?").run(Date.now(), row.token_hash);
    return result;
  }, true);
  if (!person) unauthorized();
  return person;
}
export function readSession(value?: string): WorkbenchUser | null {
  if (!value) return null;
  try { return resolveToken(value).user; } catch { return null; }
}
export function sessionToken(request: PersonnelRequest): string | undefined {
  return namedCookie(request, SESSION_COOKIE);
}
function namedCookie(request: PersonnelRequest, name: string): string | undefined {
  const parts = (request.headers.get("cookie") || "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (parts.length > 1) throw new AuthError("AUTH_IDENTITY_CONFLICT", "检测到冲突的产品会话，请重新登录。", 403);
  return parts[0]?.slice(name.length + 1);
}
export function hasPersonnelIdentity(request: PersonnelRequest) {
  return request.headers.has(DEMO_ROLE_HEADER) || [SESSION_COOKIE, ...Object.values(DEMO_COOKIES)].some(name => namedCookie(request, name) !== undefined);
}
export function prepareDemoRequest(request: PersonnelRequest, explicitRole?: WorkbenchRole) {
  rejectServiceIdentity(request);
  const headerRole = demoRole(request.headers.get(DEMO_ROLE_HEADER));
  const role = explicitRole ?? headerRole;
  if (!demoAccessEnabled()) return { request, cookie: null as null | { name: string; value: string } };
  const name = DEMO_COOKIES[role], existing = namedCookie(request, name);
  if (existing) {
    try {
      const person = resolveToken(existing);
      if (person.access?.mode === "demo" && person.user.role === role) {
        const headers = new Headers(request.headers); headers.set(DEMO_ROLE_HEADER, role);
        // Next API handlers receive a proxy Request: native reconstruction fails its private brand check.
        // Authentication needs only metadata; the original request body remains untouched.
        return { request: { headers }, cookie: null };
      }
    } catch (error) { if (!(error instanceof AuthError && error.status === 401)) throw error; }
  }
  const cfg = configured(), user = account(role, cfg);
  const token = createPersonnelSession(user, undefined, true), headers = new Headers(request.headers);
  const retained = (headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part && !part.startsWith(`${name}=`));
  headers.set("cookie", [...retained, `${name}=${token}`].join("; ")); headers.set(DEMO_ROLE_HEADER, role);
  return { request: { headers }, cookie: { name, value: token } };
}
export function setDemoResponseCookie(response: Response, cookie: { name: string; value: string } | null) {
  if (cookie) response.headers.append("Set-Cookie", `${cookie.name}=${cookie.value}; Path=${sessionCookieOptions.path}; HttpOnly; SameSite=Strict; Max-Age=${ABSOLUTE_MS / 1000}${sessionCookieOptions.secure ? "; Secure" : ""}`);
  return response;
}
export function readPagePerson(store: { get(name: string): { value: string } | undefined }, role: WorkbenchRole): PersonSession | null {
  const demo = demoAccessEnabled();
  try {
    const person = resolveToken(store.get(demo ? DEMO_COOKIES[role] : SESSION_COOKIE)?.value);
    return demo && (person.access?.mode !== "demo" || person.user.role !== role) ? null : person;
  } catch (error) { if (error instanceof AuthError && error.status === 401) return null; throw error; }
}
function rejectServiceIdentity(request: PersonnelRequest) {
  if (["authorization", "x-handoff-key", "x-signal-key", "x-api-key"].some(header => request.headers.has(header)))
    throw new AuthError("AUTH_IDENTITY_CONFLICT", "服务身份不能用于人员会话。", 403);
}
export function assertFormOrigin(request: PersonnelRequest) {
  rejectServiceIdentity(request);
  if (request.headers.get("origin") !== configured().origin) throw new AuthError("ORIGIN_FORBIDDEN", "请求来源不匹配。", 403);
}
export function requirePerson(request: PersonnelRequest, write = false): PersonSession {
  rejectServiceIdentity(request);
  const role = demoRole(request.headers.get(DEMO_ROLE_HEADER)), demo = demoAccessEnabled();
  return resolveToken(demo ? namedCookie(request, DEMO_COOKIES[role]) : sessionToken(request), person => {
    if (demo && (person.access?.mode !== "demo" || person.user.role !== role)) unauthorized();
    if (write) {
      assertFormOrigin(request);
      const supplied = request.headers.get("x-csrf-token");
      if (!supplied || !equal(supplied, person.csrf_token)) throw new AuthError("CSRF_FORBIDDEN", "请求校验已失效，请重新读取会话。", 403);
    }
  });
}
export function validateContext(actual: PersonContext, expected: unknown): void {
  const keys = ["subject", "session_id", "session_revision", "instance_id", "scope"] as const;
  if (!expected || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).length !== keys.length
    || keys.some(key => !Object.hasOwn(expected, key) || (expected as Record<string, unknown>)[key] !== actual[key]))
    throw new AuthError("CONTEXT_CONFLICT", "会话上下文已变化，请保留草稿并重新核对。", 409);
}
/** No idle write: safe to call during a business transaction against another database. */
export function recheckPerson(person: PersonSession): PersonSession {
  const cfg = configured();
  return withIdentityDb(db => {
    const row = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(person.context.session_id) as SessionRow | undefined;
    const user = inspectRow(db, row, cfg);
    if (!user || !row || !equal(sha(person.csrf_token), row.csrf_hash)) unauthorized();
    const current = publicSession(row, user, person.csrf_token);
    validateContext(current.context, person.context);
    if (user.username !== person.user.username || user.role !== person.user.role || user.scope !== person.user.scope) unauthorized();
    return current;
  });
}
export function revokeSession(person: PersonSession) {
  recheckPerson(person);
  withIdentityDb(db => db.prepare("UPDATE sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL").run(Date.now(), person.context.session_id), true);
}
function basePath() {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  if (base && (!/^\/[A-Za-z0-9/_-]+$/.test(base) || base.includes(".."))) throw new AuthError("NOT_CONFIGURED", "页面路径配置不可用。", 503);
  return base;
}
export const sessionCookieOptions = { httpOnly: true, sameSite: "strict" as const, get path() { return basePath() || "/"; }, maxAge: ABSOLUTE_MS / 1000,
  get secure() { return readAuthConfig().origin.startsWith("https:"); } };
export function sameHostUrl(_request: Request, pathname: string) {
  const cfg = readAuthConfig();
  return new URL(`${basePath()}${pathname}`, cfg.origin);
}
