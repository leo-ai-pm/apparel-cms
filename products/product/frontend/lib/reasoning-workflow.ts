import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { recheckPerson, validateContext, type PersonSession } from "./auth";
import { listRegisteredUsers } from "./users-db";
import { parseStrictJson } from "./partner-protocol";
import { analyzeFeedback, ensure, id, METHOD, natural, sha, shape, stableJson, text, validateBatch } from "./reasoning-rules";
import { withReasoningDb } from "./reasoning-store";
import { REASONING_CONTRACT, type AnalysisBinding, type AnalysisVersion, type ReasoningAction, type ReasoningDecision, type ReasoningHistory, type ReasoningInput, type ReasoningList, type ReasoningSubmission, type ReasoningTask, type TaskDetail } from "./reasoning-types";

type Row = { record: string };
const uid = (prefix: string) => `${prefix}-${randomUUID()}`;
const baseFields = "action_id context_id expected_context expected_task_revision assignment_version";
function actor(person: PersonSession) { return recheckPerson(person); }
function manager(person: PersonSession) { ensure(person.user.role === "manager", "FORBIDDEN", 403, "仅产品负责人可操作"); }
function accessible(person: PersonSession, task: ReasoningTask | null): asserts task is ReasoningTask {
  ensure(task && (person.user.role === "manager" || task.assignee === person.user.username), "NOT_FOUND", 404, "未找到可访问的研判任务");
}
function taskRow(db: DatabaseSync, person: PersonSession, taskId: string): ReasoningTask | null {
  const row = db.prepare("SELECT record FROM pmr_tasks WHERE scope=? AND id=?").get(person.context.scope, taskId) as Row | undefined;
  return row ? JSON.parse(row.record) : null;
}
function allowed(person: PersonSession, task: ReasoningTask): ReasoningAction[] {
  if (person.user.role === "manager") return task.state === "submitted" ? ["approve_reasoning", "return_reasoning"] : ["assign"];
  if (task.assignee !== person.user.username) return [];
  return ["assigned", "draft", "returned"].includes(task.state) ? ["analyze", ...(task.state === "draft" && task.analysis_version_id ? ["submit" as const] : [])] : [];
}
function present(person: PersonSession, task: ReasoningTask): ReasoningTask { return { ...task, allowed_actions: allowed(person, task) }; }
function load<T>(db: DatabaseSync, table: string, scope: string, key: string | null): T | null {
  if (!key) return null;
  const row = db.prepare(`SELECT data FROM ${table} WHERE scope=? AND id=?`).get(scope, key) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}
function detail(db: DatabaseSync, person: PersonSession, task: ReasoningTask): TaskDetail {
  accessible(person, task);
  const row = db.prepare("SELECT data FROM pmr_inputs WHERE scope=? AND task_id=? AND revision=?").get(person.context.scope, task.task_id, task.input_revision) as { data: string } | undefined;
  ensure(row, "REASONING_STORAGE_UNAVAILABLE", 503, "冻结输入版本缺失");
  const value: TaskDetail = { contract_version: REASONING_CONTRACT, context: person.context, context_id: person.context.session_id,
    task: present(person, task), input: JSON.parse(row.data), analysis: load<AnalysisVersion>(db, "pmr_analyses", person.context.scope, task.analysis_version_id), submission: load<ReasoningSubmission>(db, "pmr_submissions", person.context.scope, task.submission_id), decision: load<ReasoningDecision>(db, "pmr_decisions", person.context.scope, task.decision_id) };
  ensure(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024 * 1024, "TOO_LARGE", 413, "研判内容过大，请拆分测试批次");
  return value;
}
function history(db: DatabaseSync, person: PersonSession, task: ReasoningTask, type: string, key: string, value: unknown) {
  db.prepare("INSERT INTO pmr_history(scope,task_id,record_type,record_id,data) VALUES(?,?,?,?,?)").run(person.context.scope, task.task_id, type, key, JSON.stringify(value));
}
function putTask(db: DatabaseSync, person: PersonSession, task: ReasoningTask) {
  db.prepare("INSERT INTO pmr_tasks(scope,id,batch_id,record) VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET record=excluded.record").run(person.context.scope, task.task_id, task.batch_id, JSON.stringify({ ...task, allowed_actions: [] }));
}
function common(person: PersonSession, input: Record<string, unknown>) {
  id(input.action_id); natural(input.expected_task_revision); natural(input.assignment_version);
  validateContext(person.context, input.expected_context);
  ensure(input.context_id === person.context.session_id, "CONTEXT_CONFLICT", 409, "人员行动上下文已变化，请保留草稿并刷新");
}
function versions(input: Record<string, unknown>, task: ReasoningTask) {
  ensure(input.expected_task_revision === task.task_revision, "TASK_REVISION_CONFLICT", 409, "任务版本已变化，请保留草稿并重新核对");
  ensure(input.assignment_version === task.assignment_version, "ASSIGNMENT_CONFLICT", 409, "分派版本已变化，请重新核对授权任务");
}
function replay(db: DatabaseSync, person: PersonSession, taskId: string, actionId: string, raw: Buffer): { response: TaskDetail; status: number } | null {
  const row = db.prepare("SELECT session_id,task_id,raw,response,http_status FROM pmr_actions WHERE scope=? AND actor=? AND action_id=?").get(person.context.scope, person.user.username, actionId) as { session_id: string; task_id: string; raw: Uint8Array; response: string; http_status: number } | undefined;
  if (!row) return null;
  ensure(row.session_id === person.context.session_id && row.task_id === taskId && Buffer.from(row.raw).equals(raw), "ACTION_CONFLICT", 409, "此动作已用于不同会话、任务或内容，请核对原动作");
  return { response: JSON.parse(row.response), status: row.http_status };
}
function saveResponse(db: DatabaseSync, person: PersonSession, task: ReasoningTask, input: Record<string, unknown>, raw: Buffer, status = 200) {
  const response = detail(db, person, task);
  db.prepare("INSERT INTO pmr_actions VALUES(?,?,?,?,?,?,?,?)").run(person.context.scope, person.user.username, String(input.action_id), person.context.session_id, task.task_id, raw, JSON.stringify(response), status);
  return { response, status };
}
function assignees() {
  const rows = listRegisteredUsers().map(i => ({ username: i.username, display_name: i.display_name }));
  if (process.env.WORKBENCH_STAFF_ENABLED !== "false" && process.env.WORKBENCH_STAFF_USERNAME) rows.unshift({ username: process.env.WORKBENCH_STAFF_USERNAME, display_name: "测试产品员工" });
  return rows;
}
type Cursor = { kind: string; scope: string; session: string; subject: string; task: string; after: number; high: number };
function cursorSign(value: Cursor) {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${createHmac("sha256", process.env.WORKBENCH_SESSION_SECRET!).update(body).digest("base64url")}`;
}
function cursorRead(person: PersonSession, encoded: string | null, kind: string, task: string): Cursor | null {
  if (!encoded) return null;
  ensure(encoded.length <= 2000, "INVALID_CURSOR", 409, "查询位置已失效，请重新读取");
  const [body, mac, extra] = encoded.split(".");
  const expected = createHmac("sha256", process.env.WORKBENCH_SESSION_SECRET!).update(body ?? "").digest("base64url");
  ensure(!extra && mac && /^[A-Za-z0-9_-]{43}$/.test(mac) && timingSafeEqual(Buffer.from(mac), Buffer.from(expected)), "INVALID_CURSOR", 409, "查询位置已失效，请重新读取");
  const value = shape(parseStrictJson(Buffer.from(body, "base64url"), 2000), "kind scope session subject task after high") as unknown as Cursor;
  ensure(value.kind === kind && value.scope === person.context.scope && value.session === person.context.session_id && value.subject === person.user.username && value.task === task && Number.isSafeInteger(value.after) && Number.isSafeInteger(value.high) && value.after >= 0 && value.high >= value.after, "INVALID_CURSOR", 409, "查询位置不属于当前人员或任务");
  return value;
}
export function listReasoning(person: PersonSession, encoded: string | null): ReasoningList {
  actor(person); const cursor = cursorRead(person, encoded, "tasks", "");
  return withReasoningDb(db => {
    actor(person);
    const staff = person.user.role === "staff" ? " AND json_extract(record,'$.assignee')=?" : "";
    const params = [person.context.scope, ...(staff ? [person.user.username] : [])];
    const high = cursor?.high ?? Number(db.prepare(`SELECT COALESCE(MAX(rowid),0) AS n FROM pmr_tasks WHERE scope=?${staff}`).get(...params)?.n);
    const rows = db.prepare(`SELECT rowid,record FROM pmr_tasks WHERE scope=?${staff} AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 21`).all(...params, cursor?.after ?? 0, high) as { rowid: number; record: string }[];
    const page = rows.slice(0, 20), has_more = rows.length > page.length;
    return { contract_version: REASONING_CONTRACT, context: person.context, context_id: person.context.session_id, tasks: page.map(row => present(person, JSON.parse(row.record))), assignees: person.user.role === "manager" ? assignees() : [], has_more, next_cursor: has_more ? cursorSign({ kind: "tasks", scope: person.context.scope, session: person.context.session_id, subject: person.user.username, task: "", after: page.at(-1)!.rowid, high }) : null };
  });
}
export function getReasoning(person: PersonSession, taskId: string): TaskDetail {
  actor(person); id(taskId);
  return withReasoningDb(db => { actor(person); const task = taskRow(db, person, taskId); accessible(person, task); return detail(db, person, task); });
}
export function getReasoningAction(person: PersonSession, taskId: string, actionId: string) {
  actor(person); id(taskId); id(actionId);
  return withReasoningDb(db => {
    actor(person); accessible(person, taskRow(db, person, taskId));
    const row = db.prepare("SELECT response FROM pmr_actions WHERE scope=? AND actor=? AND session_id=? AND task_id=? AND action_id=?").get(person.context.scope, person.user.username, person.context.session_id, taskId, actionId) as { response: string } | undefined;
    ensure(row, "NOT_FOUND", 404, "未找到此会话已保存的动作");
    return { action_id: actionId, response: JSON.parse(row.response) as TaskDetail };
  });
}
export function getReasoningHistory(person: PersonSession, taskId: string, encoded: string | null): ReasoningHistory {
  actor(person); id(taskId); const cursor = cursorRead(person, encoded, "history", taskId);
  return withReasoningDb(db => {
    actor(person); accessible(person, taskRow(db, person, taskId));
    const high = cursor?.high ?? Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM pmr_history WHERE scope=? AND task_id=?").get(person.context.scope, taskId)?.n);
    const rows = db.prepare("SELECT seq,record_type,record_id,data FROM pmr_history WHERE scope=? AND task_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 11").all(person.context.scope, taskId, cursor?.after ?? 0, high) as { seq: number; record_type: ReasoningHistory["items"][number]["record_type"]; record_id: string; data: string }[];
    const page = rows.slice(0, 10), has_more = rows.length > page.length;
    return { contract_version: REASONING_CONTRACT, context: person.context, context_id: person.context.session_id, items: page.map(row => ({ record_type: row.record_type, record_id: row.record_id, data: JSON.parse(row.data) })), has_more, next_cursor: has_more ? cursorSign({ kind: "history", scope: person.context.scope, session: person.context.session_id, subject: person.user.username, task: taskId, after: page.at(-1)!.seq, high }) : null };
  });
}
export function importReasoning(person: PersonSession, raw: Buffer) {
  actor(person); manager(person);
  const input = shape(parseStrictJson(raw, 2 * 1024 * 1024), `${baseFields} input_base64`); common(person, input);
  ensure(typeof input.input_base64 === "string" && input.input_base64.length <= 1400000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.input_base64));
  const bytes = Buffer.from(input.input_base64, "base64"); ensure(bytes.toString("base64") === input.input_base64);
  const batch = validateBatch(bytes), input_digest = sha(bytes), taskId = `PMRT-${sha(stableJson([person.context.scope, batch.batch_id]))}`;
  return withReasoningDb(db => {
    actor(person); manager(person); let task = taskRow(db, person, taskId);
    if (task) accessible(person, task);
    const previous = replay(db, person, taskId, String(input.action_id), raw); if (previous) return previous;
    const now = new Date().toISOString();
    if (!task) {
      ensure(input.expected_task_revision === 0 && input.assignment_version === 0, "TASK_REVISION_CONFLICT", 409, "首次导入必须使用初始版本");
      ensure(batch.input_revision === 1, "INPUT_REVISION_CONFLICT", 409, "首次输入版必须为1");
      task = { task_id: taskId, batch_id: batch.batch_id, title: batch.batch_id, test_data: true, state: "unassigned", task_revision: 0, assignment_version: 0, assignee: null, input_revision: 1, input_digest, analysis_version_id: null, result_digest: null, submission_id: null, decision_id: null, updated_at: now, allowed_actions: [] };
    } else {
      versions(input, task);
      const existing = db.prepare("SELECT digest FROM pmr_inputs WHERE scope=? AND task_id=? AND revision=?").get(person.context.scope, taskId, batch.input_revision) as { digest: string } | undefined;
      if (existing) { ensure(existing.digest === input_digest && batch.input_revision === task.input_revision, "INPUT_REVISION_CONFLICT", 409, "该输入版已冻结为不同内容或已成为历史版本"); return saveResponse(db, person, task, input, raw); }
      ensure(batch.input_revision === task.input_revision + 1, "INPUT_REVISION_CONFLICT", 409, "新输入版必须接续当前版本");
      task.input_revision = batch.input_revision; task.input_digest = input_digest;
      task.analysis_version_id = null; task.result_digest = null; task.submission_id = null; task.decision_id = null; task.state = task.assignee ? "assigned" : "unassigned"; task.task_revision++; task.updated_at = now;
    }
    const stored: ReasoningInput = { input_revision: batch.input_revision, input_digest, input_base64: bytes.toString("base64"), batch, imported_by: person.user.username, imported_at: now };
    db.prepare("INSERT INTO pmr_inputs VALUES(?,?,?,?,?,?)").run(person.context.scope, taskId, batch.input_revision, JSON.stringify(stored), bytes, input_digest);
    history(db, person, task, "input", `input-${batch.input_revision}`, stored); putTask(db, person, task);
    return saveResponse(db, person, task, input, raw, task.task_revision === 0 ? 201 : 200);
  }, true);
}
const actionFields: Record<ReasoningAction, string> = { assign: "assignee", analyze: "input_revision input_digest method_version", submit: "analysis_version_id input_revision input_digest result_digest", approve_reasoning: "analysis_version_id input_revision input_digest result_digest submission_id final_priority priority_reason", return_reasoning: "analysis_version_id input_revision input_digest result_digest submission_id reason" };
function binding(input: Record<string, unknown>, task: ReasoningTask): AnalysisBinding {
  ensure(input.analysis_version_id === task.analysis_version_id && input.input_revision === task.input_revision && input.input_digest === task.input_digest && input.result_digest === task.result_digest, "VERSION_CONFLICT", 409, "分析或输入版本已变化，请保留草稿并核对准确版本");
  return { analysis_version_id: String(input.analysis_version_id), input_revision: Number(input.input_revision), input_digest: String(input.input_digest), result_digest: String(input.result_digest) };
}
export function actReasoning(person: PersonSession, taskId: string, raw: Buffer) {
  actor(person); id(taskId);
  const parsed = parseStrictJson(raw, 10000) as Record<string, unknown>;
  ensure(parsed && typeof parsed === "object" && Object.hasOwn(actionFields, String(parsed.action)));
  const action = parsed.action as ReasoningAction, input = shape(parsed, `${baseFields} action ${actionFields[action]}`); common(person, input);
  if (["assign", "approve_reasoning", "return_reasoning"].includes(action)) manager(person);
  else ensure(person.user.role === "staff", "FORBIDDEN", 403, "仅所分派员工可分析和提交");
  return withReasoningDb(db => {
    actor(person); const task = taskRow(db, person, taskId); accessible(person, task);
    const previous = replay(db, person, taskId, String(input.action_id), raw); if (previous) return previous;
    versions(input, task); ensure(allowed(person, task).includes(action), "STATE_CONFLICT", 409, "当前任务状态不能执行此动作");
    const now = new Date().toISOString(), scope = person.context.scope;
    if (action === "assign") {
      const assignee = text(input.assignee, 32); ensure(assignees().some(i => i.username === assignee), "ASSIGNEE_INVALID", 422, "员工不存在、停用或不在当前范围");
      task.assignee = assignee; task.assignment_version++; task.state = "assigned"; task.analysis_version_id = null; task.result_digest = null; task.submission_id = null; task.decision_id = null;
      history(db, person, task, "assignment", uid("PMRA"), { assignee, assignment_version: task.assignment_version, assigned_by: person.user.username, assigned_at: now });
    }
    if (action === "analyze") {
      ensure(input.input_revision === task.input_revision && input.input_digest === task.input_digest, "VERSION_CONFLICT", 409, "输入版本已变化，请重新核对");
      ensure(input.method_version === METHOD.version, "METHOD_UNSUPPORTED", 422, "规则版本不受支持");
      const stored = detail(db, person, task).input;
      const bytes = Buffer.from(stored.input_base64, "base64"); ensure(sha(bytes) === task.input_digest, "REASONING_STORAGE_UNAVAILABLE", 503, "冻结输入摘要异常");
      const result = analyzeFeedback(validateBatch(bytes)), result_digest = sha(stableJson(result)), analysis_version_id = uid("PMRV");
      const version: AnalysisVersion = { analysis_version_id, input_revision: task.input_revision, input_digest: task.input_digest, method: METHOD, rule_digest: METHOD.rules_digest, result, result_digest, created_by: person.user.username, created_at: now, assignment_version: task.assignment_version };
      db.prepare("INSERT INTO pmr_analyses VALUES(?,?,?,?)").run(scope, taskId, analysis_version_id, JSON.stringify(version)); history(db, person, task, "analysis", analysis_version_id, version);
      task.analysis_version_id = analysis_version_id; task.result_digest = result_digest; task.submission_id = null; task.decision_id = null; task.state = "draft";
    }
    if (action === "submit") {
      const b = binding(input, task), submission_id = uid("PMRS");
      const submission: ReasoningSubmission = { ...b, submission_id, submitted_by: person.user.username, submitted_at: now, assignment_version: task.assignment_version, test_data: true, review_scope: "test_reasoning_only" };
      db.prepare("INSERT INTO pmr_submissions VALUES(?,?,?,?)").run(scope, taskId, submission_id, JSON.stringify(submission)); history(db, person, task, "submission", submission_id, submission);
      task.submission_id = submission_id; task.decision_id = null; task.state = "submitted";
    }
    if (action === "approve_reasoning" || action === "return_reasoning") {
      const b = binding(input, task); ensure(input.submission_id === task.submission_id, "VERSION_CONFLICT", 409, "提交版本已变化，请核对本版");
      const submission = load<ReasoningSubmission>(db, "pmr_submissions", scope, task.submission_id);
      ensure(submission && submission.assignment_version === task.assignment_version && stableJson({ analysis_version_id: submission.analysis_version_id, input_revision: submission.input_revision, input_digest: submission.input_digest, result_digest: submission.result_digest }) === stableJson(b), "VERSION_CONFLICT", 409, "提交绑定异常");
      const reason = text(action === "approve_reasoning" ? input.priority_reason : input.reason, 2000);
      if (action === "approve_reasoning") ensure(["P0", "P1", "P2", "P3"].includes(String(input.final_priority)));
      const decision_id = uid("PMRD"), decision: ReasoningDecision = { ...b, decision_id, submission_id: task.submission_id!, decision: action, reviewed_by: person.user.username, reviewed_at: now, assignment_version: task.assignment_version, final_priority: action === "approve_reasoning" ? input.final_priority as ReasoningDecision["final_priority"] : null, priority_reason: action === "approve_reasoning" ? reason : null, reason: action === "return_reasoning" ? reason : null, test_data: true, review_scope: "test_reasoning_only" };
      db.prepare("INSERT INTO pmr_decisions VALUES(?,?,?,?)").run(scope, taskId, decision_id, JSON.stringify(decision)); history(db, person, task, "decision", decision_id, decision);
      task.decision_id = decision_id; task.state = action === "approve_reasoning" ? "approved" : "returned";
    }
    task.task_revision++; task.updated_at = now; putTask(db, person, task);
    return saveResponse(db, person, task, input, raw);
  }, true);
}
