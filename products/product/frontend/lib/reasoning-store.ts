import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { readAuthConfig } from "./partner-auth-config";
import { ReasoningError } from "./reasoning-rules";

function unavailable(): never { throw new ReasoningError("REASONING_STORAGE_UNAVAILABLE", "独立研判库不可用，请联系维护人员", 503); }
export function reasoningFile(): string {
  const file = process.env.WORKBENCH_REASONING_DB ?? "";
  if (!path.isAbsolute(file)) unavailable();
  const protectedFiles = [process.env.WORKBENCH_CASES_DB, process.env.WORKBENCH_USERS_DB, process.env.WORKBENCH_INTAKE_DB,
    process.env.WORKBENCH_CASES_DB ? path.join(path.dirname(process.env.WORKBENCH_CASES_DB), "intake.sqlite") : undefined].filter((v): v is string => !!v);
  const normalized = path.resolve(file);
  if (protectedFiles.some(item => path.resolve(item) === normalized)) unavailable();
  const parent = path.dirname(normalized);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) unavailable();
  if (existsSync(normalized)) {
    const current = lstatSync(normalized);
    if (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o777) !== 0o600) unavailable();
    for (const other of protectedFiles) if (existsSync(other)) {
      const protectedStat = lstatSync(other);
      if (realpathSync(other) === realpathSync(normalized) || current.ino === protectedStat.ino && current.dev === protectedStat.dev) unavailable();
    }
  }
  return normalized;
}
export function withReasoningDb<T>(operation: (db: DatabaseSync) => T, write = false): T {
  const cfg = readAuthConfig(), file = reasoningFile();
  let db: DatabaseSync | undefined, inTransaction = false;
  const check = (connection: DatabaseSync) => {
    const row = connection.prepare("SELECT owner,schema_version,instance_id,scope FROM pmr_meta WHERE singleton=1").get();
    if (!row || row.owner !== "partner-product-reasoning" || row.schema_version !== 1 || row.instance_id !== cfg.instance_id || row.scope !== cfg.authorized_scope) unavailable();
  };
  try {
    let created = false;
    if (!existsSync(file)) { try { closeSync(openSync(file, "wx", 0o600)); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    if (!created) { const probe = new DatabaseSync(file, { readOnly: true }); try { check(probe); } finally { probe.close(); } }
    db = new DatabaseSync(file); db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    if (created) {
      db.exec("BEGIN IMMEDIATE"); inTransaction = true;
      db.exec(`CREATE TABLE pmr_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,schema_version INTEGER NOT NULL,instance_id TEXT NOT NULL,scope TEXT NOT NULL);
        CREATE TABLE pmr_tasks(scope TEXT NOT NULL,id TEXT NOT NULL,batch_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope,id),UNIQUE(scope,batch_id));
        CREATE TABLE pmr_inputs(scope TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,raw BLOB NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(scope,task_id,revision));
        CREATE TABLE pmr_analyses(scope TEXT NOT NULL,task_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,id));
        CREATE TABLE pmr_submissions(scope TEXT NOT NULL,task_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,id));
        CREATE TABLE pmr_decisions(scope TEXT NOT NULL,task_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,id));
        CREATE TABLE pmr_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,task_id TEXT NOT NULL,record_type TEXT NOT NULL,record_id TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE pmr_actions(scope TEXT NOT NULL,actor TEXT NOT NULL,action_id TEXT NOT NULL,session_id TEXT NOT NULL,task_id TEXT NOT NULL,raw BLOB NOT NULL,response TEXT NOT NULL,http_status INTEGER NOT NULL,PRIMARY KEY(scope,actor,action_id));`);
      db.prepare("INSERT INTO pmr_meta VALUES(1,'partner-product-reasoning',1,?,?)").run(cfg.instance_id, cfg.authorized_scope);
      db.exec("COMMIT"); inTransaction = false;
    }
    if (write) { db.exec("BEGIN IMMEDIATE"); inTransaction = true; }
    check(db);
    const value = operation(db);
    if (inTransaction) { db.exec("COMMIT"); inTransaction = false; }
    return value;
  } catch (error) {
    if (inTransaction) { try { db?.exec("ROLLBACK"); } catch { /* Preserve original failure. */ } }
    if (error instanceof ReasoningError || error instanceof Error && "code" in error && "status" in error) throw error;
    return unavailable();
  } finally { db?.close(); }
}

/** Next configuration preflight: fail before listening without seeding or modifying a DB. */
export function assertReasoningConfiguration() {
  const cfg = readAuthConfig(), file = reasoningFile();
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT owner,schema_version,instance_id,scope FROM pmr_meta WHERE singleton=1").get();
    if (!row || row.owner !== "partner-product-reasoning" || row.schema_version !== 1 || row.instance_id !== cfg.instance_id || row.scope !== cfg.authorized_scope) unavailable();
  } catch { unavailable(); } finally { db.close(); }
}
