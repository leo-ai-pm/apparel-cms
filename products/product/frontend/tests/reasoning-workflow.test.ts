// @vitest-environment node
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, hashPassword, requirePerson, revokeSession, type PersonSession } from "@/lib/auth";
import { createStaffInvite, registerStaff } from "@/lib/users-db";
import { sha, stableJson } from "@/lib/reasoning-rules";
import { assertReasoningConfiguration, reasoningFile, withReasoningDb } from "@/lib/reasoning-store";
import { SAMPLE_BASE64 } from "@/lib/reasoning-sample";
import type { TaskDetail } from "@/lib/reasoning-types";
import { POST as batches } from "@/app/api/workbench/reasoning/batches/route";
import { GET as list } from "@/app/api/workbench/reasoning/tasks/route";
import { GET as detail } from "@/app/api/workbench/reasoning/tasks/[id]/route";
import { POST as action, GET as actionQuery } from "@/app/api/workbench/reasoning/tasks/[id]/actions/route";
import { GET as history } from "@/app/api/workbench/reasoning/tasks/[id]/history/route";
import { GET as sample } from "@/app/api/workbench/reasoning/sample/route";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));

const origin = "http://127.0.0.1:3096", scope = "isolated-reasoning-test";
type Login = { token: string; person: PersonSession };
let directory: string, manager: Login, staff: Login, other: Login;
let count = 0;
const directories: string[] = [];
function request(login: Login | null, path: string, raw?: string): Request {
  return new Request(origin + path, { method: raw === undefined ? "GET" : "POST", headers: { ...(login ? { cookie: `zhixu_session=${login.token}`, "x-csrf-token": login.person.csrf_token } : {}), origin, "content-type": "application/json" }, ...(raw === undefined ? {} : { body: raw }) });
}
function login(username: string, role: "staff" | "manager"): Login { const token = createSession({ username, role, scope }); return { token, person: requirePerson(new Request(origin, { headers: { cookie: `zhixu_session=${token}` } })) }; }
function common(login: Login, current?: TaskDetail) { return { action_id: `test-action-${++count}`, context_id: login.person.context.session_id, expected_context: login.person.context, expected_task_revision: current?.task.task_revision ?? 0, assignment_version: current?.task.assignment_version ?? 0 }; }
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function parsed(response: Response) { return { status: response.status, body: await response.json() }; }
async function importBatch(login: Login = manager, name = "PMR-DEMO-PANTS-20261010", previous?: TaskDetail, change?: (b: Record<string, unknown>) => void) {
  const batch = JSON.parse(Buffer.from(SAMPLE_BASE64, "base64").toString()); batch.batch_id = name;
  if (previous) batch.input_revision = previous.task.input_revision + 1;
  change?.(batch);
  return parsed(await batches(request(login, "/api/workbench/reasoning/batches", JSON.stringify({ ...common(login, previous), input_base64: Buffer.from(JSON.stringify(batch)).toString("base64") }))));
}
async function act(login: Login, current: TaskDetail, name: string, extra: Record<string, unknown> = {}, requestBody?: string) {
  const body = requestBody ?? JSON.stringify({ ...common(login, current), action: name, ...extra });
  return { ...(await parsed(await action(request(login, `/api/workbench/reasoning/tasks/${current.task.task_id}/actions`, body), params(current.task.task_id)))), raw: body };
}
function binding(current: TaskDetail) { return { analysis_version_id: current.task.analysis_version_id, input_revision: current.task.input_revision, input_digest: current.task.input_digest, result_digest: current.task.result_digest }; }
async function draft(name?: string) {
  const initial = (await importBatch(manager, name)).body;
  const assigned = await act(manager, initial, "assign", { assignee: "staff" }); expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
  const analyzed = await act(staff, assigned.body, "analyze", { input_revision: assigned.body.task.input_revision, input_digest: assigned.body.task.input_digest, method_version: "pmr-rules/1" }); expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200); return analyzed.body as TaskDetail;
}
async function submitted(name?: string) { const d = await draft(name); const s = await act(staff, d, "submit", binding(d)); expect(s.status).toBe(200); return s.body as TaskDetail; }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "product-reasoning-test-")); directories.push(directory); chmodSync(directory, 0o700);
  const file = join(directory, "config.json"); writeFileSync(file, JSON.stringify({ instance_id: "product-reasoning-test", authorized_scope: scope, origin }), { mode: 0o600 });
  const variables = { WORKBENCH_CONFIG_FILE: file, WORKBENCH_USERS_DB: join(directory, "users.sqlite"), WORKBENCH_CASES_DB: join(directory, "cases.sqlite"), WORKBENCH_REASONING_DB: join(directory, "reasoning.sqlite"), WORKBENCH_STAFF_USERNAME: "staff", WORKBENCH_MANAGER_USERNAME: "manager", WORKBENCH_STAFF_PASSWORD_HASH: hashPassword("Isolated-Password-Only-42"), WORKBENCH_MANAGER_PASSWORD_HASH: hashPassword("Isolated-Password-Only-42"), WORKBENCH_SESSION_SECRET: "only-isolated-session-secret-" + "s".repeat(32), WORKBENCH_STAFF_ENABLED: "true" };
  for (const [key, value] of Object.entries(variables)) vi.stubEnv(key, value);
  for (const name of ["cases.sqlite", "intake.sqlite"]) writeFileSync(join(directory, name), `OLD-PROTECTED-${name}`, { mode: 0o600 });
  manager = login("manager", "manager"); staff = login("staff", "staff");
  const invite = createStaffInvite("manager"); expect(registerStaff("other-staff", "隔离其他员工", hashPassword("Other-Only-Password-42"), invite.code, ["staff", "manager"])).toBe("ok"); other = login("other-staff", "staff");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network/model/design calls forbidden in isolated workflow tests"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("real Next handlers with separate SQLite and real personnel identity", () => {
  it("starts empty, explicit manager import preserves bytes/digest, staff sample/import forbidden", async () => {
    expect((await parsed(list(request(manager, "/api/workbench/reasoning/tasks")))).body.tasks).toEqual([]);
    expect((await parsed(sample(request(staff, "/api/workbench/reasoning/sample")))).status).toBe(403);
    expect((await importBatch(staff)).status).toBe(403);
    const info = (await parsed(sample(request(manager, "/api/workbench/reasoning/sample")))).body;
    const raw = JSON.stringify({ ...common(manager), input_base64: info.input_base64 });
    const first = await parsed(await batches(request(manager, "/api/workbench/reasoning/batches", raw))); expect(first.status).toBe(201); expect(first.body.input.input_digest).toBe(info.input_digest);
    const replay = await parsed(await batches(request(manager, "/api/workbench/reasoning/batches", raw))); expect(replay).toEqual(first);
    expect(withReasoningDb(db => db.prepare("SELECT count(*) AS n FROM pmr_inputs").get()?.n)).toBe(1);
  });
  it("protects unassigned/other/cross-scope tasks and list privacy at server", async () => {
    const one = (await importBatch()).body; const two = (await importBatch(manager, "OTHER-TASK")).body;
    expect((await parsed(await detail(request(staff, "/api/workbench/reasoning/tasks/x"), params(one.task.task_id)))).status).toBe(404);
    const assigned = (await act(manager, one, "assign", { assignee: "staff" })).body;
    await act(manager, two, "assign", { assignee: "other-staff" });
    const staffList = (await parsed(list(request(staff, "/api/workbench/reasoning/tasks")))).body;
    expect(staffList.tasks.map((t: { task_id: string }) => t.task_id)).toEqual([assigned.task.task_id]); expect(staffList.assignees).toEqual([]);
    expect((await parsed(await history(request(other, "/api/workbench/reasoning/tasks/x/history"), params(one.task.task_id)))).status).toBe(404);
    withReasoningDb(db => db.prepare("INSERT INTO pmr_tasks VALUES(?,?,?,?)").run("other-scope", "PMRT-foreign", "foreign", JSON.stringify({ ...assigned.task, task_id: "PMRT-foreign" })), true);
    expect((await parsed(await detail(request(manager, "/api/workbench/reasoning/tasks/x"), params("PMRT-foreign")))).status).toBe(404);
    expect((await parsed(await history(request(manager, "/api/workbench/reasoning/tasks/x/history"), params("PMRT-foreign")))).status).toBe(404);
  });
  it("records exact submitted analysis and separate manager P0 decision without old writes or network", async () => {
    const original = ["cases.sqlite", "intake.sqlite"].map(name => sha(readFileSync(join(directory, name))));
    const current = await submitted();
    expect(current.analysis!.result_digest).toBe(sha(stableJson(current.analysis!.result)));
    expect((await act(staff, current, "approve_reasoning", { ...binding(current), submission_id: current.task.submission_id, final_priority: "P0", priority_reason: "隔离自动化审核" })).status).toBe(403);
    const approved = await act(manager, current, "approve_reasoning", { ...binding(current), submission_id: current.task.submission_id, final_priority: "P0", priority_reason: "仅验证本模块准确版审核，不发设计" });
    expect(approved.status).toBe(200); expect(approved.body.decision).toMatchObject({ final_priority: "P0", test_data: true, review_scope: "test_reasoning_only", reviewed_by: "manager", ...binding(current) });
    expect(approved.body.analysis).toEqual(current.analysis); expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(["cases.sqlite", "intake.sqlite"].map(name => sha(readFileSync(join(directory, name))))).toEqual(original);
    expect(withReasoningDb(db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'partner_%'").all())).toEqual([]);
  });
  it("same raw action retry returns original version even after state advances; changed content409", async () => {
    const d = await draft(); const first = await act(staff, d, "submit", binding(d));
    await act(manager, first.body, "approve_reasoning", { ...binding(first.body), submission_id: first.body.task.submission_id, final_priority: "P2", priority_reason: "隔离自动化" });
    const again = await act(staff, d, "submit", {}, first.raw); expect(again.status).toBe(200); expect(again.body).toEqual(first.body);
    const changed = JSON.parse(first.raw); changed.result_digest = "0".repeat(64); expect((await act(staff, d, "submit", {}, JSON.stringify(changed))).status).toBe(409);
    const query = await parsed(await actionQuery(request(staff, `/api/workbench/reasoning/tasks/x/actions?action_id=${changed.action_id}`), params(d.task.task_id))); expect(query.body.response).toEqual(first.body);
    expect(withReasoningDb(db => db.prepare("SELECT count(*) AS n FROM pmr_submissions").get()?.n)).toBe(1);
  });
  it("return keeps machine suggestions, reanalyze creates new version and old submission cannot approve", async () => {
    const s = await submitted(); const returned = await act(manager, s, "return_reasoning", { ...binding(s), submission_id: s.task.submission_id, reason: "补偏好参照，隔离测试" }); expect(returned.status).toBe(200);
    const next = await act(staff, returned.body, "analyze", { input_revision: s.task.input_revision, input_digest: s.task.input_digest, method_version: "pmr-rules/1" }); expect(next.status).toBe(200); expect(next.body.task.state).toBe("draft"); expect(next.body.task.analysis_version_id).not.toBe(s.task.analysis_version_id); expect(next.body.decision).toBeNull();
    const old = await act(manager, next.body, "approve_reasoning", { ...binding(s), submission_id: s.task.submission_id, final_priority: "P1", priority_reason: "过期版" }); expect(old.status).toBe(409);
    const h = (await parsed(await history(request(manager, "/api/workbench/reasoning/tasks/x/history"), params(s.task.task_id)))).body;
    expect(h.items.some((i: { record_type: string; data: { reason?: string } }) => i.record_type === "decision" && i.data.reason === "补偏好参照，隔离测试")).toBe(true);
  });
  it("input revision clears submitted/approved inheritance and freezes old analysis", async () => {
    const s = await submitted(); const oldDigest = s.analysis!.result_digest;
    const revised = await importBatch(manager, s.task.batch_id, s, b => { const items = b.items as { case_id: string; raw_text: string }[]; items.find(i => i.case_id === "PMR-CASE-09")!.raw_text = "399元超预算，我最多花220元。"; });
    expect(revised.status).toBe(200); expect(revised.body.task.state).toBe("assigned"); expect(revised.body.analysis).toBeNull(); expect(revised.body.submission).toBeNull();
    const stale = await act(manager, s, "approve_reasoning", { ...binding(s), submission_id: s.task.submission_id, final_priority: "P1", priority_reason: "不能批旧输入" }); expect(stale.status).toBe(409);
    const analyzed = await act(staff, revised.body, "analyze", { input_revision: 2, input_digest: revised.body.task.input_digest, method_version: "pmr-rules/1" }); expect(analyzed.status).toBe(200); expect(analyzed.body.analysis.result_digest).not.toBe(oldDigest);
    const persisted = withReasoningDb(db => JSON.parse(String(db.prepare("SELECT data FROM pmr_analyses WHERE id=?").get(s.analysis!.analysis_version_id)?.data))); expect(persisted).toEqual(s.analysis);
  });
  it("same input version bytes replay by fresh manager action adds no input; content conflict409", async () => {
    const first = (await importBatch()).body;
    const raw = JSON.stringify({ ...common(manager, first), input_base64: first.input.input_base64 });
    expect((await parsed(await batches(request(manager, "/api/workbench/reasoning/batches", raw)))).status).toBe(200);
    const batch = structuredClone(first.input.batch); batch.purpose = "同版改变内容";
    const conflict = JSON.stringify({ ...common(manager, first), input_base64: Buffer.from(JSON.stringify(batch)).toString("base64") }); expect((await parsed(await batches(request(manager, "/api/workbench/reasoning/batches", conflict)))).status).toBe(409);
    expect(withReasoningDb(db => db.prepare("SELECT count(*) AS n FROM pmr_inputs").get()?.n)).toBe(1);
  });
  it("origin/CSRF/expired/revoked/disabled identity enforced including replay", async () => {
    const s = await submitted(); const approved = await act(manager, s, "approve_reasoning", { ...binding(s), submission_id: s.task.submission_id, final_priority: "P3", priority_reason: "隔离测试" });
    const noCsrf = request(manager, "/api/workbench/reasoning/batches", approved.raw); noCsrf.headers.delete("x-csrf-token"); expect((await parsed(await batches(noCsrf))).status).toBe(403);
    const wrongOrigin = request(manager, "/api/workbench/reasoning/batches", approved.raw); wrongOrigin.headers.set("origin", "http://evil.invalid"); expect((await parsed(await batches(wrongOrigin))).status).toBe(403);
    revokeSession(manager.person); expect((await act(manager, s, "approve_reasoning", {}, approved.raw)).status).toBe(401);
    vi.stubEnv("WORKBENCH_STAFF_ENABLED", "false"); expect((await parsed(list(request(staff, "/api/workbench/reasoning/tasks")))).status).toBe(401);
    expect((await parsed(list(request(null, "/api/workbench/reasoning/tasks")))).status).toBe(401);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 9 * 60 * 60 * 1000); expect((await parsed(list(request(other, "/api/workbench/reasoning/tasks")))).status).toBe(401); vi.useRealTimers();
  });
  it("stale context, revision, assignment, malformed result and unknown fields reject atomically", async () => {
    const d = await draft();
    for (const extra of [{ expected_task_revision: 0 }, { assignment_version: 99 }, { context_id: "old-session" }, { result_digest: "bad" }, { result: { prewritten: true } }]) expect((await act(staff, d, "submit", { ...binding(d), ...extra })).status).toBe(extra.result ? 422 : 409);
    expect((await parsed(await detail(request(manager, "/api/workbench/reasoning/tasks/x"), params(d.task.task_id)))).body.task.task_revision).toBe(d.task.task_revision);
  });
  it("objects survive fresh DB connections and historical paging cursor binds session/task", async () => {
    let d = await draft(); for (let i = 0; i < 11; i++) d = (await act(staff, d, "analyze", { input_revision: d.task.input_revision, input_digest: d.task.input_digest, method_version: "pmr-rules/1" })).body;
    const restored = (await parsed(await detail(request(staff, "/api/workbench/reasoning/tasks/x"), params(d.task.task_id)))).body; expect(restored.analysis).toEqual(d.analysis);
    const page = (await parsed(await history(request(staff, "/api/workbench/reasoning/tasks/x/history"), params(d.task.task_id)))).body; expect(page.items).toHaveLength(10); expect(page.has_more).toBe(true);
    const next = (await parsed(await history(request(staff, `/api/workbench/reasoning/tasks/x/history?cursor=${page.next_cursor}`), params(d.task.task_id)))).body; expect(next.items.length).toBeGreaterThan(0);
    expect((await parsed(await history(request(manager, `/api/workbench/reasoning/tasks/x/history?cursor=${page.next_cursor}`), params(d.task.task_id)))).status).toBe(409);
  });
  it("storage refuses old paths, hard/symbolic links and unowned/wrong-instance DB without modification", () => {
    const protectedBytes = readFileSync(join(directory, "cases.sqlite"));
    vi.stubEnv("WORKBENCH_REASONING_DB", join(directory, "cases.sqlite")); expect(() => reasoningFile()).toThrow(); expect(() => assertReasoningConfiguration()).toThrow();
    const hard = join(directory, "hard.sqlite"), soft = join(directory, "soft.sqlite"); linkSync(join(directory, "cases.sqlite"), hard); symlinkSync(join(directory, "cases.sqlite"), soft);
    for (const name of [hard, soft]) { vi.stubEnv("WORKBENCH_REASONING_DB", name); expect(() => reasoningFile()).toThrow(); }
    const alien = join(directory, "alien.sqlite"); const db = new DatabaseSync(alien); db.exec("CREATE TABLE pmr_meta(singleton,owner,schema_version,instance_id,scope); INSERT INTO pmr_meta VALUES(1,'partner-product-reasoning',1,'another-instance','isolated-reasoning-test')"); db.close(); chmodSync(alien, 0o600);
    const before = sha(readFileSync(alien)); vi.stubEnv("WORKBENCH_REASONING_DB", alien); expect(() => withReasoningDb(() => null)).toThrow(); expect(() => assertReasoningConfiguration()).toThrow(); expect(sha(readFileSync(alien))).toBe(before); expect(readFileSync(join(directory, "cases.sqlite"))).toEqual(protectedBytes);
  });
  it("new proxy path retains personnel authentication and private response no-store", async () => {
    const page = proxy(new NextRequest(request(staff, "/api/workbench/reasoning/tasks"))); expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(proxy(new NextRequest(request(null, "/api/workbench/reasoning/tasks"))).status).toBe(401);
    expect((await list(request(staff, "/api/workbench/reasoning/tasks"))).headers.get("cache-control")).toBe("private, no-store");
  });
});
