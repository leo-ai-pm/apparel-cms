import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, lstatSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { readPartnerConfig } from "./handoff-auth";
const connections = new Map<string, DatabaseSync>();
export function partnerDatabase(): DatabaseSync {
    const file = process.env.WORKBENCH_CASES_DB;
    if (!file || !path.isAbsolute(file))
        throw new Error("A private absolute WORKBENCH_CASES_DB is required");
    const config = readPartnerConfig();
    const checkIdentity = (db: DatabaseSync) => {
        const meta = db.prepare("SELECT key,value FROM partner_meta").all() as {
            key: string;
            value: string;
        }[];
        const values = Object.fromEntries(meta.map(x => [x.key, x.value]));
        if (values.owner !== "partner-product-workbench" || values.schema !== "1" || values.instance_id !== config.instance_id || values.scope !== config.authorized_scope)
            throw new Error("Database ownership, schema or instance mismatch");
    };
    const cached = connections.get(file);
    if (cached) {
        checkIdentity(cached);
        return cached;
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const parent = lstatSync(path.dirname(file));
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0)
        throw new Error("Private database parent required");
    const existed = existsSync(file);
    if (existed) {
        const info = lstatSync(file);
        if (!info.isFile() || (info.mode & 0o777) !== 0o600)
            throw new Error("Private database file required");
        const probe = new DatabaseSync(file, { readOnly: true });
        try {
            checkIdentity(probe);
        }
        finally {
            probe.close();
        }
    }
    else
        closeSync(openSync(file, "wx", 0o600));
    const db = new DatabaseSync(file);
    try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
            name: string;
        }[];
        if (tables.length && !tables.some(t => t.name === "partner_meta"))
            throw new Error("Database ownership mismatch");
        if (tables.length) {
            const row = db.prepare("SELECT value FROM partner_meta WHERE key='owner'").get() as {
                value: string;
            } | undefined;
            const version = db.prepare("SELECT value FROM partner_meta WHERE key='schema'").get() as {
                value: string;
            } | undefined;
            if (row?.value !== "partner-product-workbench" || version?.value !== "1")
                throw new Error("Database ownership or schema mismatch");
        }
        db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS partner_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO partner_meta VALUES('owner','partner-product-workbench');
      INSERT OR IGNORE INTO partner_meta VALUES('schema','1');
      CREATE TABLE IF NOT EXISTS partner_cases(scope TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,signal TEXT NOT NULL,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS partner_versions(scope TEXT NOT NULL,case_id TEXT NOT NULL,group_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,group_id));
      CREATE TABLE IF NOT EXISTS partner_submissions(scope TEXT NOT NULL,submission_id TEXT NOT NULL,case_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,submission_id));
      CREATE TABLE IF NOT EXISTS partner_decisions(scope TEXT NOT NULL,decision_id TEXT NOT NULL,case_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,decision_id));
      CREATE TABLE IF NOT EXISTS partner_actions(scope TEXT NOT NULL,actor TEXT NOT NULL,action_id TEXT NOT NULL,session_id TEXT NOT NULL,case_id TEXT NOT NULL,raw BLOB NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,actor,action_id));
      CREATE TABLE IF NOT EXISTS partner_packages(scope TEXT NOT NULL,package_id TEXT NOT NULL,version TEXT NOT NULL,case_id TEXT NOT NULL,content BLOB NOT NULL,digest TEXT NOT NULL,delivery TEXT NOT NULL,PRIMARY KEY(scope,package_id,version));
      CREATE TABLE IF NOT EXISTS partner_events(scope TEXT NOT NULL,event_id TEXT NOT NULL,case_id TEXT NOT NULL,raw BLOB NOT NULL,content BLOB NOT NULL,event TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(scope,event_id));
      `);
        db.prepare("INSERT OR IGNORE INTO partner_meta VALUES('instance_id',?)").run(config.instance_id);
        db.prepare("INSERT OR IGNORE INTO partner_meta VALUES('scope',?)").run(config.authorized_scope);
        checkIdentity(db);
        db.exec("COMMIT");
        chmodSync(file, 0o600);
        connections.set(file, db);
        return db;
    }
    catch (e) {
        try {
            db.exec("ROLLBACK");
        }
        catch { }
        db.close();
        if (existed) { /* Never replace an existing database. */ }
        throw e;
    }
}
export function transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = partnerDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = operation(db);
        db.exec("COMMIT");
        return result;
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
