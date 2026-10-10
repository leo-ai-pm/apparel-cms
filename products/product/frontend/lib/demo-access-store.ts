import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { readAuthConfig } from "./partner-auth-config";
import { AuthError } from "./partner-auth-error";

function fail(): never { throw new AuthError("DEMO_NOT_CONFIGURED", "演示访问配置不可用", 503); }
function enabledFlag() {
  const flag = process.env.WORKBENCH_DEMO_ACCESS;
  if (flag !== undefined && flag !== "true" && flag !== "false") fail();
  return flag === "true";
}
function filePath(): string | null {
  const users = process.env.WORKBENCH_USERS_DB;
  const file = process.env.WORKBENCH_DEMO_SESSIONS_DB ?? (users ? path.join(path.dirname(users), "demo-access.sqlite") : null);
  if (!file || !path.isAbsolute(file)) { if (enabledFlag()) fail(); return null; }
  const protectedFiles = [users, process.env.WORKBENCH_CASES_DB, process.env.WORKBENCH_REASONING_DB, process.env.WORKBENCH_INTAKE_DB,
    users ? path.join(path.dirname(users), "intake.sqlite") : undefined].filter((v): v is string => !!v);
  if (protectedFiles.some(other => path.resolve(file) === path.resolve(other))) fail();
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) fail();
    for (const other of protectedFiles) if (existsSync(other)) {
      const protectedStat = lstatSync(other);
      if (realpathSync(file) === realpathSync(other) || stat.dev === protectedStat.dev && stat.ino === protectedStat.ino) fail();
    }
  }
  return file;
}
function withStore<T>(operation: (db: DatabaseSync) => T): T {
  const cfg = readAuthConfig(), file = filePath(); if (!file) fail();
  const directory = path.dirname(file); if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory); if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) fail();
  let db: DatabaseSync | undefined, transaction = false;
  const check = (connection: DatabaseSync) => {
    const row = connection.prepare("SELECT owner,version,instance,scope FROM demo_meta WHERE singleton=1").get();
    if (!row || row.owner !== "product-demo-access" || row.version !== 1 || row.instance !== cfg.instance_id || row.scope !== cfg.authorized_scope) fail();
  };
  try {
    let created = false;
    if (!existsSync(file)) { try { closeSync(openSync(file, "wx", 0o600)); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    if (!created) { const probe = new DatabaseSync(file, { readOnly: true }); try { check(probe); } finally { probe.close(); } }
    db = new DatabaseSync(file); db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE"); transaction = true;
    if (created) {
      db.exec("CREATE TABLE demo_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,version INTEGER NOT NULL,instance TEXT NOT NULL,scope TEXT NOT NULL,enabled INTEGER NOT NULL,epoch INTEGER NOT NULL); CREATE TABLE demo_sessions(session_id TEXT PRIMARY KEY,subject TEXT NOT NULL,role TEXT NOT NULL,epoch INTEGER NOT NULL,created_at INTEGER NOT NULL)");
      db.prepare("INSERT INTO demo_meta VALUES(1,'product-demo-access',1,?,?,0,0)").run(cfg.instance_id, cfg.authorized_scope);
    }
    check(db); const output = operation(db); db.exec("COMMIT"); transaction = false; return output;
  } catch (error) {
    if (transaction) { try { db?.exec("ROLLBACK"); } catch { /* Preserve originals. */ } }
    if (error instanceof AuthError) throw error;
    return fail();
  } finally { db?.close(); }
}
export function demoAccessState(): { enabled: boolean; epoch: number } {
  const mode = process.env.WORKBENCH_DEMO_ACCESS_MODE ?? "local";
  if (mode !== "local" && mode !== "public") fail();
  const enabled = enabledFlag(), file = filePath();
  if (!enabled && (!file || !existsSync(file))) return { enabled: false, epoch: 0 };
  if (enabled) {
    const cfg = readAuthConfig(), url = new URL(cfg.origin);
    if (mode === "public") {
      const declared = process.env.WORKBENCH_DEMO_PUBLIC_ORIGIN;
      if (url.protocol !== "https:" || declared !== cfg.origin || url.origin !== declared
        || cfg.instance_id !== "product-public-20261010" || cfg.authorized_scope !== "public-three-agent-20261010"
        || process.env.NEXT_PUBLIC_BASE_PATH !== "/v2/product") fail();
    } else if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.hostname.endsWith(".localhost")) fail();
  }
  return withStore(db => {
    const row = db.prepare("SELECT enabled,epoch FROM demo_meta WHERE singleton=1").get()!;
    let epoch = Number(row.epoch);
    if (Boolean(row.enabled) !== enabled) { epoch++; db.prepare("UPDATE demo_meta SET enabled=?,epoch=? WHERE singleton=1").run(enabled ? 1 : 0, epoch); }
    return { enabled, epoch };
  });
}
export function registerDemoSession(sessionId: string, subject: string, role: "staff" | "manager") {
  const state = demoAccessState(); if (!state.enabled) throw new AuthError("UNAUTHORIZED", "演示访问已关闭", 401);
  withStore(db => db.prepare("INSERT INTO demo_sessions VALUES(?,?,?,?,?)").run(sessionId, subject, role, state.epoch, Date.now()));
}
export function validDemoSession(sessionId: string, subject: string, role: "staff" | "manager") {
  const state = demoAccessState(); if (!state.enabled) return false;
  return withStore(db => {
    const row = db.prepare("SELECT subject,role,epoch FROM demo_sessions WHERE session_id=?").get(sessionId);
    return !!row && row.subject === subject && row.role === role && row.epoch === state.epoch;
  });
}
