import { createHash, createHmac, randomUUID } from "node:crypto";
import { partnerDatabase, transaction } from "./partner-store";
import { requirePerson, validateContext, recheckPerson, type PersonSession } from "./auth";
import { listRegisteredUsers } from "./users-db";
import { parseStrictJson, validateSavedContent, makeApprovedPackage } from "./partner-protocol";
import { templateCandidate, sameJson, recoverCandidate } from "./partner-template";
import { readPartnerConfig } from "./handoff-auth";
type Obj = Record<string, unknown>;
export type Case = {
    signal_id: string;
    status: string;
    assignee: string | null;
    draft: string;
    note: string;
    updated_at: string;
    case_revision: number;
    assignment_id: string | null;
    assignment_version: number;
    version_group_id: string | null;
    requirement_version: number;
    prompt_version: number;
    requirement_digest: string | null;
    prompt_digest: string | null;
    submission_id: string | null;
    package_id: string | null;
    package_version: string | null;
    transport_status: string;
    allowed_actions: string[];
};
export type Version = {
    version_group_id: string;
    requirement_version: number;
    prompt_version: number;
    requirement_digest: string;
    prompt_digest: string;
    requirement_base64: string;
    prompt_base64: string;
    requirement: Obj;
    prompt: Obj;
    created_by: string;
    created_at: string;
    assignment_id: string;
    assignment_version: number;
    projection_digest: string;
    template_derivation: Obj | null;
};
export class WorkbenchError extends Error {
    constructor(public code: string, message: string, public status = 422, public retryable = false) { super(message); }
}
export const digest = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const uid = (prefix: string) => `${prefix}-${randomUUID()}`;
export const object = (v: unknown): Obj => {
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new WorkbenchError("INVALID_INPUT", "请求对象格式不正确");
    return v as Obj;
};
const asText = (v: unknown, max = 180) => {
    if (typeof v !== "string" || !v.trim() || v.length > max)
        throw new WorkbenchError("INVALID_INPUT", "字段不完整");
    return v;
};
const scopeOf = (s: PersonSession) => s.context.scope;
function emptyCase(id: string): Case { return { signal_id: id, status: "new", assignee: null, draft: "", note: "", updated_at: "", case_revision: 0, assignment_id: null, assignment_version: 0, version_group_id: null, requirement_version: 0, prompt_version: 0, requirement_digest: null, prompt_digest: null, submission_id: null, package_id: null, package_version: null, transport_status: "not_approved", allowed_actions: [] }; }
function rowCase(scope: string, id: string): {
    record: Case;
    signal: Obj;
} | null {
    const r = partnerDatabase().prepare("SELECT record,signal FROM partner_cases WHERE scope=? AND id=?").get(scope, id) as {
        record: string;
        signal: string;
    } | undefined;
    return r ? { record: JSON.parse(r.record), signal: JSON.parse(r.signal) } : null;
}
function accessible(s: PersonSession, c: Case) {
    if (s.user.role !== "manager" && c.assignee !== s.user.username)
        throw new WorkbenchError("NOT_FOUND", "未找到可访问任务", 404);
}
function present(s: PersonSession, c: Case): Case {
    const actions: string[] = [];
    if (s.user.role === "manager") {
        if (c.status === "new")
            actions.push("assign", "defer", "ignore");
        if (c.status === "review")
            actions.push("approve", "return", "defer", "ignore");
        if (c.status === "approved" && partnerDatabase().prepare("SELECT 1 FROM partner_events WHERE scope=? AND case_id=? AND json_extract(event,'$.kind')='clarification' AND json_extract(event,'$.version')=? LIMIT 1").get(scopeOf(s), c.signal_id, c.package_version))
            actions.push("reopen");
    }
    else if (c.assignee === s.user.username && ["assigned", "returned"].includes(c.status))
        actions.push("save_draft", ...(c.version_group_id ? ["submit"] : []));
    return { ...c, allowed_actions: actions };
}
function storedVersion(scope: string, id: string | null): Version | null {
    if (!id)
        return null;
    const r = partnerDatabase().prepare("SELECT data FROM partner_versions WHERE scope=? AND group_id=?").get(scope, id) as {
        data: string;
    } | undefined;
    return r ? JSON.parse(r.data) : null;
}
export function events(scope: string, id: string): Obj[] {
    return (partnerDatabase().prepare("SELECT event FROM partner_events WHERE scope=? AND case_id=? ORDER BY rowid DESC").all(scope, id) as {
        event: string;
    }[]).map(r => JSON.parse(r.event));
}
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const RESPONSE_RESERVE = 4096;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Presentation reads only bounded scalar fields; original events remain immutable in history. */
function eventSummaries(scope: string, ids: string[], availableBytes: number) {
    if (!ids.length) return { items: [] as Obj[], has_more: false };
    const rows = partnerDatabase().prepare(`SELECT case_id,
      json_extract(event,'$.event_id') AS event_id,json_extract(event,'$.kind') AS kind,
      substr(json_extract(event,'$.note'),1,500) AS note,length(json_extract(event,'$.note')) AS note_length,
      json_extract(event,'$.package_id') AS package_id,json_extract(event,'$.version') AS version,
      json_extract(event,'$.design_receive_id') AS design_receive_id,json_extract(event,'$.created_at') AS created_at,
      COALESCE(json_array_length(event,'$.result.assets'),0) AS assets_count,
      json_extract(event,'$.result.assets[0]') AS asset0,json_extract(event,'$.result.assets[1]') AS asset1,
      json_extract(event,'$.result.assets[2]') AS asset2,json_extract(event,'$.result.assets[3]') AS asset3
      FROM partner_events WHERE scope=? AND case_id IN (${ids.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT 51`).all(scope, ...ids) as Obj[];
    const items: Obj[] = [];
    let size = 0;
    for (const row of rows) {
        if (items.length === 50) break;
        const assets = [row.asset0, row.asset1, row.asset2, row.asset3].filter(x => typeof x === "string").map(x => JSON.parse(x as string));
        const item = { event_id: row.event_id, kind: row.kind, note: row.note ?? "", package_id: row.package_id,
            version: row.version, design_receive_id: row.design_receive_id, created_at: row.created_at, assets,
            case_id: row.case_id, summary: true, note_truncated: Number(row.note_length) > 500,
            assets_count: row.assets_count, assets_has_more: Number(row.assets_count) > assets.length,
            history_ref: { id: row.case_id, record_type: "events", record_id: row.event_id } };
        const bytes = jsonBytes(item) + 1;
        if (size + bytes > availableBytes) break;
        items.push(item); size += bytes;
    }
    return { items, has_more: rows.length > items.length };
}
function withDetailEvents<T extends Obj>(s: PersonSession, id: string, base: T) {
    const result = { ...base, events: [] as Obj[], events_has_more: false };
    const page = eventSummaries(scopeOf(s), [id], Math.max(0, RESPONSE_LIMIT - RESPONSE_RESERVE - jsonBytes(result)));
    return { ...result, events: page.items, events_has_more: page.has_more };
}
export async function readBounded(response: Response, max: number) {
    const reader = response.body?.getReader();
    if (!reader)
        throw new WorkbenchError("UPSTREAM_ERROR", "响应为空", 502, true);
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done)
            break;
        size += value.length;
        if (size > max) {
            await reader.cancel();
            throw new WorkbenchError("TOO_LARGE", "响应过大", 502);
        }
        parts.push(value);
    }
    return Buffer.concat(parts);
}
export async function internalRead(pathname: string) {
    const config = readPartnerConfig() as unknown as Obj;
    const base = asText(config.backend_url, 300);
    const target = new URL(base);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.protocol !== "http:" || target.username || target.password || target.pathname !== "/")
        throw new WorkbenchError("NOT_CONFIGURED", "内部接收服务未配置", 503);
    const token = asText(config.backend_reader_token, 1000);
    try {
        return await fetch(`${target.origin}${pathname}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
    }
    catch {
        throw new WorkbenchError("UPSTREAM_UNAVAILABLE", "接收服务暂时不可用", 502, true);
    }
}
async function sourceSignal(id: string): Promise<Obj> {
    const r = await internalRead(`/api/internal/signals/${encodeURIComponent(id)}`);
    if (r.status === 404)
        throw new WorkbenchError("NOT_FOUND", "未找到已接收信号", 404);
    if (!r.ok)
        throw new WorkbenchError("UPSTREAM_UNAVAILABLE", "接收服务尚未就绪", 502, true);
    const data = object(parseStrictJson(await readBounded(r, 16 * 1024 * 1024), 16 * 1024 * 1024));
    const signal = object(data.signal);
    if (signal.signal_id !== id)
        throw new WorkbenchError("SOURCE_MISMATCH", "来源绑定不一致", 502);
    return signal;
}
export async function getDetail(s: PersonSession, id: string) {
    asText(id);
    const found = rowCase(scopeOf(s), id);
    if (found) {
        accessible(s, found.record);
        return withDetailEvents(s, id, { case: present(s, found.record), signal: found.signal, version: storedVersion(scopeOf(s), found.record.version_group_id), submission: submission(scopeOf(s), found.record.submission_id) });
    }
    if (s.user.role !== "manager")
        throw new WorkbenchError("NOT_FOUND", "未找到可访问任务", 404);
    const signal = await sourceSignal(id);
    recheckPerson(s);
    if (signal.authorized_scope !== scopeOf(s))
        throw new WorkbenchError("NOT_FOUND", "未找到可访问任务", 404);
    return { case: present(s, emptyCase(id)), signal, version: null, submission: null, events: [], events_has_more: false };
}
function submission(scope: string, id: string | null): Obj | null {
    if (!id)
        return null;
    const r = partnerDatabase().prepare("SELECT data FROM partner_submissions WHERE scope=? AND submission_id=?").get(scope, id) as {
        data: string;
    } | undefined;
    return r ? JSON.parse(r.data) : null;
}
export async function listWorkbench(s: PersonSession, cursor: string | null = null) {
    const scope = scopeOf(s);
    const all = (partnerDatabase().prepare("SELECT record,signal FROM partner_cases WHERE scope=? ORDER BY rowid").all(scope) as {
        record: string; signal: string;
    }[]).map(r => ({ record: JSON.parse(r.record) as Case, signal: JSON.parse(r.signal) as Obj }));
    const build = (signals: Obj[], next_cursor: unknown) => {
        const records = all.filter(x => signals.some(sig => sig.signal_id === x.record.signal_id));
        const result = { signals, cases: signals.map(sig => present(s, records.find(x => x.record.signal_id === sig.signal_id)?.record ?? emptyCase(String(sig.signal_id)))),
            design_events: [] as Obj[], staff: s.user.role === "manager" ? staffList() : [], next_cursor, design_events_has_more: false };
        const page = eventSummaries(scope, records.map(x => x.record.signal_id), Math.max(0, RESPONSE_LIMIT - RESPONSE_RESERVE - jsonBytes(result)));
        return { ...result, design_events: page.items, design_events_has_more: page.has_more };
    };
    if (s.user.role === "manager") {
        // Ask the source for a smaller page when local case fields exhaust the shared response budget.
        // Return exactly that source page's cursor, never a locally guessed signal continuation.
        for (let limit = 50; ; limit = Math.max(1, Math.floor(limit / 2))) {
            const r = await internalRead(`/api/internal/signals?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
            if (!r.ok) throw new WorkbenchError("UPSTREAM_UNAVAILABLE", "接收服务暂时不可用", 502, true);
            const data = object(parseStrictJson(await readBounded(r, RESPONSE_LIMIT), RESPONSE_LIMIT));
            recheckPerson(s);
            if (!Array.isArray(data.items)) throw new WorkbenchError("UPSTREAM_ERROR", "信号格式不正确", 502);
            const signals = data.items.map(object).filter(x => x.authorized_scope === scope);
            const result = build(signals, data.next_cursor ?? null);
            if (jsonBytes(result) <= RESPONSE_LIMIT) return result;
            if (limit === 1) throw new WorkbenchError("TOO_LARGE", "单条信号与任务超过响应容量，请分别读取历史原件", 413);
        }
    }
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || cursor !== null && !/^\d+$/.test(cursor)) throw new WorkbenchError("INVALID_INPUT", "分页参数不正确");
    const owned = all.filter(x => x.record.assignee === s.user.username);
    const signals: Obj[] = [];
    let size = RESPONSE_RESERVE, index = offset;
    for (; index < owned.length && signals.length < 50; index++) {
        const bytes = jsonBytes(owned[index].signal) + jsonBytes(present(s, owned[index].record)) + 2;
        if (size + bytes > RESPONSE_LIMIT - RESPONSE_RESERVE) break;
        signals.push(owned[index].signal); size += bytes;
    }
    if (!signals.length && index < owned.length) throw new WorkbenchError("TOO_LARGE", "单条信号超过列表容量，请分别读取详情和历史", 413);
    recheckPerson(s);
    return build(signals, index < owned.length ? String(index) : null);
}
function staffList() { const bootstrap = process.env.WORKBENCH_STAFF_ENABLED !== "false" ? process.env.WORKBENCH_STAFF_USERNAME : undefined; return [...(bootstrap ? [{ username: bootstrap, display_name: bootstrap }] : []), ...listRegisteredUsers().map(u => ({ username: u.username, display_name: u.display_name }))]; }
const HISTORY = {
    versions: { table: "partner_versions", column: "data", key: "group_id", time: "created_at" },
    submissions: { table: "partner_submissions", column: "data", key: "submission_id", time: "submitted_at" },
    decisions: { table: "partner_decisions", column: "data", key: "decision_id", time: "approved_at" },
    events: { table: "partner_events", column: "event", key: "event_id", time: "received_at" },
} as const;
type HistoryKind = keyof typeof HISTORY;
type HistoryRow = { kind: HistoryKind; row_id: number; stamp: number; data: string };
type HistoryCursor = { binding: string; upper: number[]; last: [number, HistoryKind, number] | null };
export type HistoryOptions = { cursor?: string | null; limit?: string | null; record_type?: string | null; record_id?: string | null };
const historyEmpty = () => ({ versions: [] as Obj[], submissions: [] as Obj[], decisions: [] as Obj[], events: [] as Obj[], next_cursor: null as string | null, has_more: false });
function historyMac(value: string) { return createHmac("sha256", process.env.WORKBENCH_SESSION_SECRET || "").update(`history/1:${value}`).digest("base64url"); }
function encodeHistoryCursor(value: HistoryCursor) { const encoded = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${encoded}.${historyMac(encoded)}`; }
export function getHistory(s: PersonSession, id: string, options: HistoryOptions = {}) {
    const found = rowCase(scopeOf(s), id);
    if (!found) throw new WorkbenchError("NOT_FOUND", "未找到可访问任务", 404);
    accessible(s, found.record);
    const kinds = (Object.keys(HISTORY) as HistoryKind[]).filter(k => k !== "decisions" || s.user.role === "manager");
    const db = partnerDatabase(), scope = scopeOf(s);
    const { record_type: type, record_id: recordId, cursor } = options;
    if (type != null || recordId != null) {
        if (!type || !recordId || cursor != null || options.limit != null || !Object.hasOwn(HISTORY, type)) throw new WorkbenchError("INVALID_INPUT", "历史原件参数不正确");
        if (!kinds.includes(type as HistoryKind)) throw new WorkbenchError("NOT_FOUND", "未找到可访问历史", 404);
        const kind = type as HistoryKind, source = HISTORY[kind];
        const row = db.prepare(`SELECT ${source.column} AS data FROM ${source.table} WHERE scope=? AND case_id=? AND ${source.key}=?`).get(scope, id, recordId) as { data: string } | undefined;
        if (!row) throw new WorkbenchError("NOT_FOUND", "未找到可访问历史", 404);
        const result = historyEmpty(); result[kind].push(JSON.parse(row.data));
        if (jsonBytes(result) > RESPONSE_LIMIT) throw new WorkbenchError("TOO_LARGE", "历史单条原件超过响应容量", 413);
        return result;
    }
    const limitText = options.limit ?? "50";
    if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 50) throw new WorkbenchError("INVALID_INPUT", "历史分页参数不正确");
    const limit = Number(limitText);
    const binding = digest(JSON.stringify([scope, id, s.user.username, s.user.role, s.context.session_id]));
    let state: HistoryCursor;
    if (cursor != null) {
        try {
            if (cursor.length > 4096) throw new Error();
            const [encoded, mac, extra] = cursor.split(".");
            if (!encoded || extra !== undefined || mac !== historyMac(encoded)) throw new Error();
            state = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as HistoryCursor;
            if (state.binding !== binding || !Array.isArray(state.upper) || state.upper.length !== kinds.length || state.upper.some(x => !Number.isSafeInteger(x) || x < 0)
                || !Array.isArray(state.last) || state.last.length !== 3 || !Number.isFinite(state.last[0]) || !kinds.includes(state.last[1]) || !Number.isSafeInteger(state.last[2]) || state.last[2] < 1) throw new Error();
        } catch { throw new WorkbenchError("INVALID_CURSOR", "历史分页标识无效，请从最新页重新读取"); }
    } else state = { binding, upper: kinds.map(k => Number((db.prepare(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${HISTORY[k].table} WHERE scope=? AND case_id=?`).get(scope, id) as { n: number }).n)), last: null };
    const params: (string | number)[] = [];
    const branches = kinds.map((kind, index) => {
        const source = HISTORY[kind]; params.push(scope, id, state.upper[index]);
        const timeColumn = kind === "events" ? "receipt" : source.column;
        return `SELECT '${kind}' AS kind,rowid AS row_id,COALESCE(julianday(json_extract(${timeColumn},'$.${source.time}')),0) AS stamp,${source.column} AS data FROM ${source.table} WHERE scope=? AND case_id=? AND rowid<=?`;
    });
    let condition = "";
    if (state.last) { condition = "WHERE (stamp<? OR (stamp=? AND kind<?) OR (stamp=? AND kind=? AND row_id<?))"; params.push(state.last[0], state.last[0], state.last[1], state.last[0], state.last[1], state.last[2]); }
    params.push(limit + 1);
    const rows = db.prepare(`SELECT * FROM (${branches.join(" UNION ALL ")}) ${condition} ORDER BY stamp DESC,kind DESC,row_id DESC LIMIT ?`).all(...params) as HistoryRow[];
    const result = historyEmpty();
    let count = 0, size = jsonBytes(result) + RESPONSE_RESERVE;
    for (const row of rows) {
        if (count === limit) break;
        const value = JSON.parse(row.data), bytes = jsonBytes(value) + 1;
        if (size + bytes > RESPONSE_LIMIT) break;
        result[row.kind].push(value); size += bytes; count++;
        state.last = [row.stamp, row.kind, row.row_id];
    }
    if (!count && rows.length) throw new WorkbenchError("TOO_LARGE", "历史单条原件超过响应容量", 413);
    result.has_more = rows.length > count;
    result.next_cursor = result.has_more ? encodeHistoryCursor(state) : null;
    return result;
}
export function getAction(s: PersonSession, id: string) {
    const r = partnerDatabase().prepare("SELECT response,session_id,case_id FROM partner_actions WHERE scope=? AND actor=? AND action_id=?").get(scopeOf(s), s.user.username, id) as {
        response: string;
        session_id: string;
        case_id: string;
    } | undefined;
    if (!r || r.session_id !== s.context.session_id)
        throw new WorkbenchError("NOT_FOUND", "未找到当前会话动作", 404);
    const c = rowCase(scopeOf(s), r.case_id);
    if (c)
        accessible(s, c.record);
    return JSON.parse(r.response);
}
export async function mutate(s: PersonSession, raw: Uint8Array) {
    const input = object(parseStrictJson(raw, 2 * 1024 * 1024));
    const id = asText(input.id), action = asText(input.action), actionId = asText(input.action_id);
    validateContext(s.context, input.expected_context);
    if (!Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 0)
        throw new WorkbenchError("INVALID_INPUT", "缺少任务修订号");
    const fields: Record<string, string[]> = { assign: ["assignee", "note"], save_draft: ["requirement", "prompt"], submit: ["version_group_id", "requirement_digest", "prompt_digest"], approve: ["submission_id", "version_group_id", "requirement_digest", "prompt_digest", "final_priority", "priority_reason"], return: ["submission_id", "version_group_id", "requirement_digest", "prompt_digest", "note"], defer: ["note"], ignore: ["note"], reopen: [] };
    if (!(action in fields) || Object.keys(input).some(k => !["id", "action", "action_id", "expected_context", "expected_revision", ...fields[action]].includes(k)))
        throw new WorkbenchError("INVALID_INPUT", "动作字段不正确");
    const scope = scopeOf(s);
    let existing = rowCase(scope, id);
    if (existing)
        accessible(s, existing.record);
    else if (s.user.role !== "manager")
        throw new WorkbenchError("NOT_FOUND", "未找到可访问任务", 404);
    const signal = existing?.signal ?? await sourceSignal(id);
    if (signal.authorized_scope !== scope)
        throw new WorkbenchError("NOT_FOUND", "未找到可访问任务", 404);
    return transaction(db => {
        recheckPerson(s);
        validateContext(s.context, input.expected_context);
        existing = rowCase(scope, id);
        const c = existing?.record ?? emptyCase(id);
        accessible(s, c);
        const replay = db.prepare("SELECT raw,response,session_id FROM partner_actions WHERE scope=? AND actor=? AND action_id=?").get(scope, s.user.username, actionId) as {
            raw: Uint8Array;
            response: string;
            session_id: string;
        } | undefined;
        if (replay) {
            if (replay.session_id !== s.context.session_id)
                throw new WorkbenchError("CONTEXT_CONFLICT", "动作属于不同会话", 409);
            if (!Buffer.from(replay.raw).equals(raw))
                throw new WorkbenchError("ACTION_CONFLICT", "同一动作内容不同", 409);
            return JSON.parse(replay.response);
        }
        if (c.case_revision !== input.expected_revision)
            throw new WorkbenchError("REVISION_CONFLICT", "任务已更新，请保留草稿并刷新核对", 409);
        if (!present(s, c).allowed_actions.includes(action))
            throw new WorkbenchError(s.user.role === "staff" && ["assign", "approve", "return", "defer", "ignore", "reopen"].includes(action) ? "FORBIDDEN" : "STATE_CONFLICT", "当前身份或状态不能执行此操作", s.user.role === "staff" && ["assign", "approve", "return", "defer", "ignore", "reopen"].includes(action) ? 403 : 409);
        const now = new Date().toISOString();
        if (action === "assign") {
            if (signal.schema_version !== "pa-styling-signal/2" || signal.provenance_status !== "complete" || signal.target_instance_id !== s.context.instance_id)
                throw new WorkbenchError("PROVENANCE_INCOMPLETE", "来源证据或目标绑定尚不完整");
            const assignee = asText(input.assignee);
            if (!staffList().some(u => u.username === assignee))
                throw new WorkbenchError("INVALID_INPUT", "请选择有效员工");
            const projection = Buffer.from(String(signal.projection_base64 ?? ""), "base64");
            if (digest(projection) !== signal.projection_digest || !sameJson(parseStrictJson(projection, 16 * 1024 * 1024), signal.evidence_projection))
                throw new WorkbenchError("PROVENANCE_INCOMPLETE", "来源投影摘要不一致");
            c.assignee = assignee;
            c.assignment_id = uid("ASSIGN");
            c.assignment_version = 1;
            c.status = "assigned";
            c.note = typeof input.note === "string" ? input.note.slice(0, 2000) : "";
        }
        if (action === "save_draft") {
            const validated = validateSavedContent(input.requirement, input.prompt, signal, s.user.username);
            const generation = object(validated.prompt.generation);
            let templateDerivation: Obj | null = null;
            if (generation.mode === "offline_template") {
                const category = String(validated.requirement.design_object);
                const candidate = templateCandidate(signal, category, String(generation.generated_at));
                templateDerivation = { template_version: generation.template_version, projection_digest: signal.projection_digest, prompt_base64: Buffer.from(JSON.stringify(candidate.prompt)).toString("base64"), prompt_digest: digest(JSON.stringify(candidate.prompt)) };
                if (!sameJson(candidate.prompt, validated.prompt) || (object(object(signal.demand).attributes)).category !== category)
                    throw new WorkbenchError("INVALID_INPUT", "模板正文与可核验派生不一致，请标注人工改写");
            }
            if (generation.derived_from !== null) {
                const derived = object(generation.derived_from);
                if (derived.kind === "candidate") {
                    let candidate;
                    try {
                        candidate = recoverCandidate(signal, String(derived.id));
                    }
                    catch {
                        throw new WorkbenchError("INVALID_INPUT", "候选派生不可核验");
                    }
                    const candidateRaw = JSON.stringify(candidate.prompt);
                    if (digest(candidateRaw) !== derived.prompt_digest)
                        throw new WorkbenchError("INVALID_INPUT", "候选摘要不一致");
                    templateDerivation = { template_version: candidate.prompt.generation.template_version, projection_digest: signal.projection_digest, prompt_base64: Buffer.from(candidateRaw).toString("base64"), prompt_digest: digest(candidateRaw), candidate_id: derived.id };
                }
                else {
                    const original = storedVersion(scope, String(derived.id));
                    const belongs = db.prepare("SELECT case_id FROM partner_versions WHERE scope=? AND group_id=?").get(scope, String(derived.id)) as {
                        case_id: string;
                    } | undefined;
                    if (derived.kind !== "saved_prompt" || !original || belongs?.case_id !== id || original.prompt_digest !== derived.prompt_digest)
                        throw new WorkbenchError("INVALID_INPUT", "派生来源版本不可核验");
                }
            }
            const rb = Buffer.from(JSON.stringify(validated.requirement)), pb = Buffer.from(JSON.stringify(validated.prompt));
            const group: Version = { version_group_id: uid("VG"), requirement_version: c.requirement_version + 1, prompt_version: c.prompt_version + 1, requirement_digest: digest(rb), prompt_digest: digest(pb), requirement_base64: rb.toString("base64"), prompt_base64: pb.toString("base64"), requirement: validated.requirement, prompt: validated.prompt, created_by: s.user.username, created_at: now, assignment_id: c.assignment_id!, assignment_version: c.assignment_version, projection_digest: String(signal.projection_digest), template_derivation: templateDerivation };
            db.prepare("INSERT INTO partner_versions VALUES(?,?,?,?)").run(scope, id, group.version_group_id, JSON.stringify(group));
            Object.assign(c, { version_group_id: group.version_group_id, requirement_version: group.requirement_version, prompt_version: group.prompt_version, requirement_digest: group.requirement_digest, prompt_digest: group.prompt_digest, draft: String(group.requirement.requirement_desc), submission_id: null });
        }
        if (["submit", "approve", "return"].includes(action)) {
            for (const key of ["version_group_id", "requirement_digest", "prompt_digest"] as const)
                if (input[key] !== c[key])
                    throw new WorkbenchError("REVISION_CONFLICT", "指定版本或摘要已变化", 409);
            const group = storedVersion(scope, c.version_group_id);
            if (!group)
                throw new WorkbenchError("STATE_CONFLICT", "请先保存完整版本", 409);
            if (action === "submit") {
                if (signal.provenance_status !== "complete")
                    throw new WorkbenchError("PROVENANCE_INCOMPLETE", "来源证据尚不完整", 422);
                const unknowns = group.prompt.unknowns as Obj[];
                const conflicts = group.prompt.conflicts as Obj[];
                if (unknowns.some(x => x.blocking === true) || conflicts.some(x => x.blocking === true && !x.resolution))
                    throw new WorkbenchError("PROVENANCE_INCOMPLETE", "请先处理关键未知项或冲突", 422);
                c.submission_id = uid("SUB");
                db.prepare("INSERT INTO partner_submissions VALUES(?,?,?,?)").run(scope, c.submission_id, id, JSON.stringify({ submission_id: c.submission_id, version_group_id: group.version_group_id, requirement_digest: group.requirement_digest, prompt_digest: group.prompt_digest, assignment_id: c.assignment_id, assignment_version: c.assignment_version, submitted_by: s.user.username, submitted_at: now }));
                c.status = "review";
            }
            else {
                if (input.submission_id !== c.submission_id)
                    throw new WorkbenchError("REVISION_CONFLICT", "提交记录已变化", 409);
                const decisionId = uid("DEC");
                const note = action === "return" ? asText(input.note, 2000) : asText(input.priority_reason, 2000);
                const decision: Obj = { decision_id: decisionId, submission_id: c.submission_id, decision: action, approved_by: s.user.username, approved_at: now, version_group_id: group.version_group_id, requirement_digest: group.requirement_digest, prompt_digest: group.prompt_digest, final_priority: input.final_priority ?? null, priority_reason: note };
                if (action === "approve") {
                    if (!["P0", "P1", "P2", "P3"].includes(String(input.final_priority)))
                        throw new WorkbenchError("INVALID_INPUT", "请选择最终优先级");
                    const cfg = readPartnerConfig();
                    const packageVersion = `v${c.package_version ? Number(c.package_version.slice(1)) + 1 : 1}`;
                    const approval = { approval_schema: "pa-product-approval/2", decision_id: decisionId, approved_by: s.user.username, approved_at: now, version_group_id: group.version_group_id, requirement_digest: group.requirement_digest, prompt_digest: group.prompt_digest, final_priority: input.final_priority, priority_reason: note };
                    const pkg = makeApprovedPackage(signal, group, approval, { source_instance_id: cfg.instance_id, target_instance_id: cfg.design_instance_id, authorized_scope: scope }, packageVersion);
                    const content = Buffer.from(JSON.stringify(pkg));
                    const delivery = { delivery_schema: "pa-design-delivery/2", source_product: "product_management", target_product: "footwear_design", source_instance_id: cfg.instance_id, target_instance_id: cfg.design_instance_id, authorized_scope: scope, package_id: pkg.package_id, version: packageVersion, content_digest: digest(content), content_base64: content.toString("base64") };
                    db.prepare("INSERT INTO partner_packages VALUES(?,?,?,?,?,?,?)").run(scope, String(pkg.package_id), packageVersion, id, content, digest(content), JSON.stringify(delivery));
                    c.package_id = String(pkg.package_id);
                    c.package_version = packageVersion;
                    c.status = "approved";
                    c.transport_status = cfg.services.some(x => x.purpose === "design_package_reader") ? "available" : "not_configured";
                }
                else
                    c.status = "returned";
                c.note = note;
                db.prepare("INSERT INTO partner_decisions VALUES(?,?,?,?)").run(scope, decisionId, id, JSON.stringify(decision));
            }
        }
        if (action === "defer" || action === "ignore") {
            c.note = asText(input.note, 2000);
            c.status = action === "defer" ? "deferred" : "ignored";
        }
        if (action === "reopen") {
            const e = events(scope, id).find(e => e.kind === "clarification" && e.version === c.package_version);
            if (!e)
                throw new WorkbenchError("STATE_CONFLICT", "当前版本没有已核验澄清", 409);
            c.status = "returned";
            c.note = String(object(e.clarification).reason);
        }
        c.case_revision++;
        c.updated_at = now;
        c.allowed_actions = [];
        db.prepare("INSERT INTO partner_cases VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET record=excluded.record").run(scope, id, JSON.stringify(c), JSON.stringify(signal));
        const result = { case: present(s, c), version: storedVersion(scope, c.version_group_id) };
        db.prepare("INSERT INTO partner_actions VALUES(?,?,?,?,?,?,?)").run(scope, s.user.username, actionId, s.context.session_id, id, Buffer.from(raw), JSON.stringify(result));
        return result;
    });
}
export { requirePerson };
