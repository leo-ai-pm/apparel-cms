import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readAuthConfig } from "./partner-auth-config";
import { AuthError } from "./partner-auth-error";

export type UserRow = { username: string; display_name: string; password_hash: string; active: number; scope: string };
type InviteRow = { expires_at: number; used_at: number | null; scope: string; instance_id: string };
const OWNER = "partner-product-identities/1";
function unavailable(): never { throw new AuthError("STORAGE_UNAVAILABLE", "独立身份库不可用，请联系维护人员。", 503, true); }

/** Never migrate an unowned database. A read-only check precedes a writable open. */
export function withIdentityDb<T>(operation: (db: DatabaseSync) => T, write = false): T {
  const cfg = readAuthConfig();
  const file = process.env.WORKBENCH_USERS_DB || "";
  if (!path.isAbsolute(file)) unavailable();
  let db: DatabaseSync | undefined;
  let transaction = false;
  try {
    const directory = path.dirname(file);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) unavailable();
    let created = false;
    if (!existsSync(file)) {
      try { closeSync(openSync(file, "wx", 0o600)); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) unavailable();
    const check = (database: DatabaseSync) => {
      const meta = database.prepare("SELECT owner,schema_version,instance_id,scope FROM partner_identity_meta WHERE singleton=1").get();
      if (!meta || meta.owner !== OWNER || meta.schema_version !== 1 || meta.instance_id !== cfg.instance_id || meta.scope !== cfg.authorized_scope) unavailable();
    };
    if (!created) {
      const probe = new DatabaseSync(file, { readOnly: true });
      try { check(probe); } finally { probe.close(); }
    }
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout=5000");
    if (created) {
      db.exec("BEGIN IMMEDIATE"); transaction = true;
      db.exec("CREATE TABLE partner_identity_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,schema_version INTEGER NOT NULL,instance_id TEXT NOT NULL,scope TEXT NOT NULL)");
      db.exec("CREATE TABLE users(username TEXT PRIMARY KEY,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,scope TEXT NOT NULL)");
      db.exec("CREATE TABLE invites(code_hash TEXT PRIMARY KEY,created_by TEXT NOT NULL,expires_at INTEGER NOT NULL,used_by TEXT,used_at INTEGER,scope TEXT NOT NULL,instance_id TEXT NOT NULL)");
      db.exec("CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,session_id TEXT UNIQUE NOT NULL,session_revision INTEGER NOT NULL,username TEXT NOT NULL,role TEXT NOT NULL,scope TEXT NOT NULL,instance_id TEXT NOT NULL,credential_fingerprint TEXT NOT NULL,csrf_hash TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER)");
      db.prepare("INSERT INTO partner_identity_meta VALUES(1,?,1,?,?)").run(OWNER, cfg.instance_id, cfg.authorized_scope);
      db.exec("COMMIT"); transaction = false;
    }
    if (write) { db.exec("BEGIN IMMEDIATE"); transaction = true; }
    check(db);
    const result = operation(db);
    if (transaction) { db.exec("COMMIT"); transaction = false; }
    return result;
  } catch (error) {
    if (transaction) { try { db?.exec("ROLLBACK"); } catch { /* preserve safe failure */ } }
    if (error instanceof AuthError) throw error;
    return unavailable();
  } finally { db?.close(); }
}

export function getRegisteredUser(username: string): UserRow | null {
  return withIdentityDb(db => db.prepare("SELECT username,display_name,password_hash,active,scope FROM users WHERE username=?").get(username) as UserRow | undefined ?? null);
}
export function listRegisteredUsers() {
  const scope = readAuthConfig().authorized_scope;
  return withIdentityDb(db => db.prepare("SELECT username,display_name,created_at FROM users WHERE active=1 AND scope=? ORDER BY created_at DESC,username").all(scope) as { username: string; display_name: string; created_at: number }[]);
}
const inviteHash = (code: string) => createHash("sha256").update(code).digest("hex");
export function createStaffInvite(createdBy: string) {
  const cfg = readAuthConfig();
  const code = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  withIdentityDb(db => db.prepare("INSERT INTO invites(code_hash,created_by,expires_at,scope,instance_id) VALUES(?,?,?,?,?)")
    .run(inviteHash(code), createdBy, expiresAt, cfg.authorized_scope, cfg.instance_id), true);
  return { code, expiresAt };
}
export type RegisterResult = "ok" | "invite" | "username";
/** Safe compatibility symbol: self-registration is closed. */
export function registerStaffSelf(...unused: unknown[]): RegisterResult { void unused; return "invite"; }
export function registerStaff(username: string, displayName: string, passwordHash: string, code: string, reservedNames: string[]): RegisterResult {
  if (reservedNames.includes(username)) return "username";
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return "invite";
  const cfg = readAuthConfig();
  return withIdentityDb(db => {
    const invite = db.prepare("SELECT expires_at,used_at,scope,instance_id FROM invites WHERE code_hash=?").get(inviteHash(code)) as InviteRow | undefined;
    if (!invite || invite.used_at !== null || invite.expires_at <= Date.now() || invite.scope !== cfg.authorized_scope || invite.instance_id !== cfg.instance_id) return "invite";
    if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) return "username";
    db.prepare("INSERT INTO users(username,display_name,password_hash,created_at,scope) VALUES(?,?,?,?,?)").run(username, displayName, passwordHash, Date.now(), cfg.authorized_scope);
    db.prepare("UPDATE invites SET used_by=?,used_at=? WHERE code_hash=?").run(username, Date.now(), inviteHash(code));
    return "ok";
  }, true);
}
