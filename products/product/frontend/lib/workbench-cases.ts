import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CaseStatus = "new" | "assigned" | "review" | "approved" | "returned" | "deferred" | "ignored";
export type CaseRecord = { signal_id: string; status: CaseStatus; assignee: string | null; draft: string; note: string; updated_at: string; package_id: string | null; package_version: string | null; handoff_payload: string | null };
export type DesignEvent = { event_id: string; package_id: string; version: string; kind: "clarification" | "design_approved"; note: string; design_version_id: string | null; image_url: string | null; created_at: string };
let connection: DatabaseSync | undefined;

function database() {
  if (process.env.WORKBENCH_CONFIG_FILE) throw new Error("LEGACY_ROUTE_DISABLED");
  if (connection) return connection;
  const file = path.resolve(/* turbopackIgnore: true */ process.env.WORKBENCH_CASES_DB || path.join(process.cwd(), "data", "workbench-cases.sqlite"));
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  connection = new DatabaseSync(file);
  chmodSync(file, 0o600);
  connection.exec(`CREATE TABLE IF NOT EXISTS cases (
    signal_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    assignee TEXT,
    draft TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    package_id TEXT,
    package_version TEXT,
    handoff_payload TEXT
  )`);
  const columns = connection.prepare("PRAGMA table_info(cases)").all() as { name: string }[];
  if (!columns.some(column => column.name === "package_id")) connection.exec("ALTER TABLE cases ADD COLUMN package_id TEXT");
  if (!columns.some(column => column.name === "package_version")) connection.exec("ALTER TABLE cases ADD COLUMN package_version TEXT");
  if (!columns.some(column => column.name === "handoff_payload")) connection.exec("ALTER TABLE cases ADD COLUMN handoff_payload TEXT");
  connection.exec(`CREATE TABLE IF NOT EXISTS design_events (
    event_id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL,
    version TEXT NOT NULL,
    kind TEXT NOT NULL,
    note TEXT NOT NULL,
    design_version_id TEXT,
    image_url TEXT,
    created_at TEXT NOT NULL
  )`);
  connection.exec(`CREATE TABLE IF NOT EXISTS approved_packages (
    package_id TEXT NOT NULL,
    version TEXT NOT NULL,
    payload TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY(package_id, version)
  )`);
  connection.exec(`INSERT OR IGNORE INTO approved_packages (package_id, version, payload, approved_at)
    SELECT package_id, package_version, handoff_payload, updated_at FROM cases
    WHERE status='approved' AND handoff_payload IS NOT NULL`);
  return connection;
}

export function listCases(): CaseRecord[] {
  return database().prepare("SELECT signal_id, status, assignee, draft, note, updated_at, package_id, package_version, handoff_payload FROM cases").all() as CaseRecord[];
}

export function getCase(id: string): CaseRecord | null {
  return database().prepare("SELECT signal_id, status, assignee, draft, note, updated_at, package_id, package_version, handoff_payload FROM cases WHERE signal_id = ?").get(id) as CaseRecord | undefined ?? null;
}

export function saveCase(id: string, status: CaseStatus, assignee: string | null, draft: string, note: string, handoff?: { package_id: string; version: string; payload: object }): CaseRecord {
  const updatedAt = new Date().toISOString();
  if (handoff) {
    const previous = database().prepare("SELECT payload FROM approved_packages WHERE package_id=? AND version=?").get(handoff.package_id, handoff.version) as { payload: string } | undefined;
    if (previous && previous.payload !== JSON.stringify(handoff.payload)) throw new Error("同一需求版本内容不同，不能覆盖历史记录");
  }
  database().prepare(`INSERT INTO cases (signal_id, status, assignee, draft, note, updated_at, package_id, package_version, handoff_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signal_id) DO UPDATE SET status=excluded.status, assignee=excluded.assignee,
    draft=excluded.draft, note=excluded.note, updated_at=excluded.updated_at,
    package_id=COALESCE(excluded.package_id, cases.package_id),
    package_version=COALESCE(excluded.package_version, cases.package_version),
    handoff_payload=COALESCE(excluded.handoff_payload, cases.handoff_payload)`).run(id, status, assignee, draft, note, updatedAt, handoff?.package_id || null, handoff?.version || null, handoff ? JSON.stringify(handoff.payload) : null);
  if (handoff) database().prepare("INSERT OR IGNORE INTO approved_packages (package_id, version, payload, approved_at) VALUES (?, ?, ?, ?)").run(handoff.package_id, handoff.version, JSON.stringify(handoff.payload), updatedAt);
  return getCase(id)!;
}

export function listApprovedPackages(): object[] {
  return (database().prepare("SELECT payload FROM approved_packages ORDER BY rowid DESC").all() as { payload: string }[]).map(row => JSON.parse(row.payload));
}

export function listDesignEvents(): DesignEvent[] {
  return database().prepare("SELECT * FROM design_events ORDER BY created_at DESC").all() as DesignEvent[];
}

export function saveDesignEvent(event: Omit<DesignEvent, "created_at">): DesignEvent {
  const row = database().prepare("SELECT 1 FROM approved_packages WHERE package_id=? AND version=?").get(event.package_id, event.version);
  if (!row) throw new Error("需求版本未获批准，不能接收设计反馈");
  database().prepare(`INSERT OR IGNORE INTO design_events
    (event_id, package_id, version, kind, note, design_version_id, image_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(event.event_id, event.package_id, event.version, event.kind, event.note, event.design_version_id, event.image_url, new Date().toISOString());
  return database().prepare("SELECT * FROM design_events WHERE event_id = ?").get(event.event_id) as DesignEvent;
}
