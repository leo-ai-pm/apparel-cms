import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeEvidence, AdminError, adminApi, adminExport, adminQuery, approvalBody, approvalSetsEqual,
  checkedCoverage, formatAdminTime, parseApprovalEligibility, sourceReviewWitness, sourceTurnFingerprint, windowQuery,
  type ApprovalEligibility, type ApprovalSet, type Evidence, type GroupDetail, type TurnDetail,
} from "../app/lib/admin-api";

const evidence = (id: string, changes: Partial<Evidence> = {}): Evidence => ({
  id, turn_id: `turn-${id}`, group_key: "group", title: "秋季通勤裤子", description: "合成证据",
  attributes: { category: "裤子", season: "秋", scene: "通勤", fit: null, silhouette: null },
  review_state: "pending", reason: "", revision: 1, lifecycle: "active", normalizer_version: "rules-v2",
  context_turn_ids: [], field_sources: { category: [`turn-${id}`] }, session_id: "synthetic-session",
  text: "秋天通勤想要裤子", created_at: "2026-10-08T00:00:00Z", extractor: "rules-v2",
  data_origin: "simulation_fixture", ...changes,
});
const detail = (changes: Partial<GroupDetail> = {}): GroupDetail => ({
  window_start: "2026-10-01T00:00:00.123456Z", window_end: "2026-10-08T00:00:00.123456Z",
  total: 2, page: 1, page_size: 40, has_more: false, pagination_mode: "paged",
  evidence: [evidence("a"), evidence("b", { revision: 3, review_state: "approved" })], handoffs: [], ...changes,
});
const approvalSet = (changes: Partial<ApprovalSet> = {}): ApprovalSet => ({
  group_key: "group", days: 7, window_start: "2026-10-01T00:00:00.123456Z", window_end: "2026-10-08T00:00:00.123456Z",
  active_count: 2, expected_occurrence_ids: ["a", "b"], expected_revisions: { a: 1, b: 3 }, evidence_digest: "a".repeat(64),
  approval_eligibility: { policy: "pause-inactive-sources-v1", eligible: true, reason_codes: [], blocked_sources: [],
    message: "当前来源未触发暂停；仍须人工核对全部证据与出处。" }, ...changes,
});
const pausedEligibility = (changes: Partial<ApprovalEligibility> = {}): ApprovalEligibility => ({
  policy: "pause-inactive-sources-v1", eligible: false, reason_codes: ["source_inactive"],
  blocked_sources: [{ turn_id: "source", occurrence_id: "source-occurrence", revision: 2, review_state: "rejected", lifecycle: "excluded" }],
  message: "引用来源含已排除或无效记录，相关新审批已暂停；重新核对不会解除，请等待人工复核。", ...changes,
});
const sourceTurn = (id: string, changes: Partial<TurnDetail> = {}): TurnDetail => ({
  id, session_id: "synthetic-session", text: "秋天通勤想要裤子", status: "extracted",
  extractor: "rules-v2", data_origin: "simulation_fixture", created_at: "2026-10-08T00:00:00Z",
  error_code: "", extraction_attempts: 1, negative_preferences: [],
  occurrences: [evidence("source-occurrence", { turn_id: id })], context_turns: [], revision_history: [], ...changes,
});
const response = (result: unknown, status = 200) => new Response(JSON.stringify(result), {
  status, headers: { "content-type": "application/json" },
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("approval evidence and frozen window", () => {
  it("includes all active pending and approved evidence with their exact revisions", () => {
    const current = detail({ evidence: [
      evidence("a"), evidence("b", { revision: 3, review_state: "approved" }),
      evidence("rejected", { review_state: "rejected" }),
      evidence("excluded", { lifecycle: "excluded" }), evidence("retracted", { lifecycle: "retracted" }),
    ] });
    expect(activeEvidence(current).map(item => item.id)).toEqual(["a", "b"]);
    expect(approvalBody(approvalSet(), "核对合成证据")).toEqual({
      note: "核对合成证据", days: 7, expected_occurrence_ids: ["a", "b"], expected_revisions: { a: 1, b: 3 },
      expected_evidence_digest: "a".repeat(64),
      window_start: current.window_start, window_end: current.window_end,
    });
  });

  it("freezes the cumulative cutoff without inventing a lower bound", () => {
    expect(approvalBody(approvalSet({ window_start: null, days: 0 }), "累计核对")).toEqual({
      note: "累计核对", days: 0, expected_occurrence_ids: ["a", "b"], expected_revisions: { a: 1, b: 3 },
      expected_evidence_digest: "a".repeat(64), window_end: "2026-10-08T00:00:00.123456Z",
    });
  });

  it("cannot build an approval from the current evidence page", () => {
    expect(() => approvalBody(detail() as unknown as ApprovalSet, "只看到本页")).toThrow(AdminError);
  });

  it("sends all 140 baseline IDs and revisions, including evidence beyond the current page", () => {
    const ids = Array.from({ length: 140 }, (_, index) => `evidence-${index}`);
    const baseline = approvalSet({
      active_count: ids.length, expected_occurrence_ids: ids,
      expected_revisions: Object.fromEntries(ids.map((id, index) => [id, index % 3 + 1])),
    });
    const body = approvalBody(baseline, "逐条核对完整来源");
    expect(body.expected_occurrence_ids).toHaveLength(140);
    expect(body.expected_revisions).toEqual(baseline.expected_revisions);
    expect(body.expected_evidence_digest).toBe(baseline.evidence_digest);
    expect(body.expected_occurrence_ids).not.toBe(baseline.expected_occurrence_ids);
    expect(body.expected_revisions).not.toBe(baseline.expected_revisions);
  });
});

describe("complete manual review baseline consistency", () => {
  it("compares complete ID sets independently of their order", () => {
    expect(approvalSetsEqual(approvalSet(), approvalSet({ expected_occurrence_ids: ["b", "a"] }))).toBe(true);
  });

  it.each([
    { group_key: " group " },
    { group_key: "another-group" },
    { days: 0, window_start: null },
    { window_start: "2026-10-01T00:00:00.123455Z" },
    { window_end: "2026-10-08T00:00:00.123457Z" },
    { expected_occurrence_ids: ["a", "c"], expected_revisions: { a: 1, c: 3 } },
    { expected_revisions: { a: 1, b: 4 } },
    { evidence_digest: "b".repeat(64) },
  ] as Partial<ApprovalSet>[])("invalidates checked evidence when the baseline changes: %j", change => {
    expect(approvalSetsEqual(approvalSet(), approvalSet(change))).toBe(false);
  });

  it.each([
    { active_count: 1 },
    { active_count: -1 },
    { expected_occurrence_ids: ["a", "a"] },
    { expected_occurrence_ids: ["a", " "] },
    { expected_revisions: { a: 1 } },
    { expected_revisions: { a: 1, b: 3, extra: 1 } },
    { expected_revisions: { a: 1, b: 0 } },
    { expected_revisions: { a: 1, b: 1.5 } },
    { evidence_digest: "not-a-digest" },
    { window_start: null },
    { window_start: "2026-10-08T00:00:00.123457Z" },
    { window_end: "2026-10-08T00:00:00+08:00" },
    { window_end: "2026-02-30T00:00:00Z" },
  ] as Partial<ApprovalSet>[])("rejects a malformed baseline even when compared with itself: %j", change => {
    const malformed = approvalSet(change);
    expect(approvalSetsEqual(malformed, malformed)).toBe(false);
    expect(checkedCoverage(malformed, { a: 1, b: 3 })).toBe(false);
    expect(() => approvalBody(malformed, "人工核对")).toThrow(AdminError);
  });

  it("rejects missing baseline objects and wrong runtime types", () => {
    expect(approvalSetsEqual(null, null)).toBe(false);
    expect(approvalSetsEqual([], [])).toBe(false);
    const malformed = { ...approvalSet(), expected_revisions: { a: "1", b: 3 } };
    expect(approvalSetsEqual(malformed, malformed)).toBe(false);
  });

  it("requires every baseline ID to have an explicit check at the exact revision", () => {
    const baseline = approvalSet();
    expect(checkedCoverage(baseline, {})).toBe(false);
    expect(checkedCoverage(baseline, { a: 1 })).toBe(false);
    expect(checkedCoverage(baseline, { a: 1, b: 2 })).toBe(false);
    expect(checkedCoverage(baseline, { a: 1, b: 3 })).toBe(true);
    expect(checkedCoverage(baseline, { a: 1, b: 3, stale: 1 })).toBe(false);
  });

  it("does not approve an empty active set", () => {
    const empty = approvalSet({ active_count: 0, expected_occurrence_ids: [], expected_revisions: {} });
    expect(approvalSetsEqual(empty, empty)).toBe(true);
    expect(checkedCoverage(empty, {})).toBe(false);
    expect(() => approvalBody(empty, "没有有效来源")).toThrow(AdminError);
  });
});

describe("external source read witnesses", () => {
  it("canonicalizes occurrence, attribute and source-ID order without altering the input", () => {
    const first = evidence("first", { attributes: { season: "秋", scene: "通勤" }, field_sources: { season: ["two", "one"], scene: ["one"] } });
    const second = evidence("second");
    const turn = sourceTurn("source", { occurrences: [second, first] });
    const reordered = sourceTurn("source", { occurrences: [
      { ...first, attributes: { scene: "通勤", season: "秋" }, field_sources: { scene: ["one"], season: ["one", "two"] } }, second,
    ] });
    expect(sourceTurnFingerprint(turn)).toBe(sourceTurnFingerprint(reordered));
    expect(turn.occurrences.map(item => item.id)).toEqual(["second", "first"]);
    expect(first.field_sources.season).toEqual(["two", "one"]);
  });

  it("does not invalidate a read when pending source evidence is merely approved", () => {
    const before = sourceTurn("source");
    const after = sourceTurn("source", { occurrences: before.occurrences.map(item => ({ ...item, review_state: "approved" })) });
    expect(sourceTurnFingerprint(before)).toBe(sourceTurnFingerprint(after));
  });

  it.each([
    { revision: 2 }, { lifecycle: "excluded" }, { review_state: "rejected" },
    { attributes: { scene: "约会" } }, { field_sources: { scene: ["another-turn"] } },
  ] as Partial<Evidence>[])("detects source occurrence changes even when the target baseline is unchanged: %j", change => {
    const before = sourceTurn("source");
    const after = sourceTurn("source", { occurrences: before.occurrences.map(item => ({ ...item, ...change })) });
    expect(sourceTurnFingerprint(before)).not.toBe(sourceTurnFingerprint(after));
  });

  it("detects source original-text edits and additional source occurrences", () => {
    const before = sourceTurn("source");
    expect(sourceTurnFingerprint(before)).not.toBe(sourceTurnFingerprint({ ...before, text: "原话被改写" }));
    expect(sourceTurnFingerprint(before)).not.toBe(sourceTurnFingerprint({ ...before, occurrences: [...before.occurrences, evidence("extra")] }));
  });

  it("collects every external context/field reference once and excludes the current turn", () => {
    const current = evidence("target", {
      context_turn_ids: ["source-b", "source-a"],
      field_sources: { category: ["source-a", "turn-target"], scene: ["source-b"] },
    });
    const turns = { "source-a": sourceTurn("source-a"), "source-b": sourceTurn("source-b") };
    expect(sourceReviewWitness(current, turns)).toEqual({
      "source-a": sourceTurnFingerprint(turns["source-a"]), "source-b": sourceTurnFingerprint(turns["source-b"]),
    });
    expect(sourceReviewWitness(evidence("target"), {})).toEqual({});
  });

  it("refuses missing, blank, mismatched or cross-session source details", () => {
    const current = evidence("target", { context_turn_ids: ["source"] });
    expect(sourceReviewWitness(current, {})).toBeNull();
    expect(sourceReviewWitness(current, { source: sourceTurn("source", { text: "  " }) })).toBeNull();
    expect(sourceReviewWitness(current, { source: sourceTurn("other-id") })).toBeNull();
    expect(sourceReviewWitness(current, { source: sourceTurn("source", { session_id: "another-session" }) })).toBeNull();
  });

  it("invalidates the saved source witness after another group's source occurrence is rejected", () => {
    const current = evidence("target", { field_sources: { scene: ["source"] } });
    const before = sourceTurn("source");
    const after = sourceTurn("source", {
      occurrences: before.occurrences.map(item => ({ ...item, revision: 2, review_state: "rejected", lifecycle: "excluded" })),
    });
    expect(sourceReviewWitness(current, { source: before })).not.toEqual(sourceReviewWitness(current, { source: after }));
    // The target-only backend baseline alone would not reveal this source change.
    expect(approvalSetsEqual(approvalSet(), approvalSet())).toBe(true);
  });
});

describe("confirmed approval source eligibility", () => {
  it.each([
    undefined, null, [], {},
    { ...pausedEligibility(), policy: "future-policy" },
    { ...pausedEligibility(), eligible: "false" },
    { ...pausedEligibility(), reason_codes: [] },
    { ...pausedEligibility(), reason_codes: ["unknown-reason"] },
    { ...pausedEligibility(), reason_codes: ["source_inactive", "source_inactive"] },
    { ...pausedEligibility(), blocked_sources: [] },
    { ...pausedEligibility(), blocked_sources: [null] },
    { ...pausedEligibility(), blocked_sources: [pausedEligibility().blocked_sources[0], pausedEligibility().blocked_sources[0]] },
    { ...pausedEligibility(), eligible: true },
    { ...approvalSet().approval_eligibility, blocked_sources: pausedEligibility().blocked_sources },
    { ...approvalSet().approval_eligibility, reason_codes: ["source_inactive"] },
    { ...pausedEligibility(), message: "password=private /Users/Admin/secret" },
    { ...pausedEligibility(), message: "任意外部消息" },
  ])("rejects unknown or contradictory policy data instead of granting permission: %j", value => {
    expect(parseApprovalEligibility(value)).toBeNull();
    const baseline = { ...approvalSet(), approval_eligibility: value } as unknown as ApprovalSet;
    expect(approvalSetsEqual(baseline, baseline)).toBe(false);
    expect(checkedCoverage(baseline, { a: 1, b: 3 })).toBe(false);
    expect(() => approvalBody(baseline, "不能绕过资格")).toThrow(AdminError);
  });

  it.each([
    { turn_id: " " }, { occurrence_id: "../source secret" }, { revision: 0 }, { revision: 2.5 },
    { revision: "2" }, { review_state: "invalid" }, { lifecycle: "invalid" }, { review_state: "pending", lifecycle: "active" },
  ])("rejects invalid blocked occurrence fields: %j", change => {
    const malformed = { ...pausedEligibility(), blocked_sources: [{ ...pausedEligibility().blocked_sources[0], ...change }] };
    expect(parseApprovalEligibility(malformed)).toBeNull();
  });

  it("accepts only blocked occurrences and compares complete eligibility independently of list order", () => {
    const first = pausedEligibility().blocked_sources[0];
    const second = { ...first, turn_id: "other-source", occurrence_id: "other-occurrence", review_state: "approved" as const, lifecycle: "retracted" as const };
    const paused = pausedEligibility({ blocked_sources: [first, second] });
    expect(parseApprovalEligibility(paused)).toEqual(paused);
    expect(approvalSetsEqual(approvalSet({ approval_eligibility: paused }), approvalSet({ approval_eligibility: pausedEligibility({ blocked_sources: [second, first] }) }))).toBe(true);
    expect(paused.blocked_sources).toEqual([first, second]);
    expect(parseApprovalEligibility(pausedEligibility({ blocked_sources: [{ ...first, lifecycle: "active" }] }))).not.toBeNull();
    expect(parseApprovalEligibility(pausedEligibility({ blocked_sources: [{ ...first, review_state: "pending", lifecycle: "replaced" }] }))).not.toBeNull();
  });

  it("invalidates an identical digest when qualification or its blocking occurrence changes", () => {
    const paused = pausedEligibility();
    const before = approvalSet({ approval_eligibility: paused });
    expect(approvalSetsEqual(before, before)).toBe(true);
    expect(approvalSetsEqual(before, approvalSet())).toBe(false);
    for (const change of [{ revision: 3 }, { occurrence_id: "different-occurrence" }, { turn_id: "different-source" }, { lifecycle: "retracted" as const }]) {
      expect(approvalSetsEqual(before, approvalSet({ approval_eligibility: pausedEligibility({ blocked_sources: [{ ...paused.blocked_sources[0], ...change }] }) }))).toBe(false);
    }
  });

  it("keeps a paused set consistent without allowing coverage or building an approval request", () => {
    const baseline = approvalSet({ approval_eligibility: pausedEligibility() });
    expect(approvalSetsEqual(baseline, baseline)).toBe(true);
    expect(checkedCoverage(baseline, { a: 1, b: 3 })).toBe(false);
    expect(() => approvalBody(baseline, "已经重新读过仍暂停")).toThrow(expect.objectContaining({
      code: "SOURCE_APPROVAL_BLOCKED", approval_eligibility: pausedEligibility(),
    }));
    expect(approvalBody(approvalSet(), "完整核对")).not.toHaveProperty("approval_eligibility");
  });
});

describe("admin HTTP error handling", () => {
  it("retains only verified top-level blocked eligibility and fixed safe pause wording", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: { code: "SOURCE_APPROVAL_BLOCKED", message: "password=private /Users/Admin/private" },
      approval_eligibility: pausedEligibility(),
    }, 409)));
    await expect(adminApi("groups/demo/approve", {})).rejects.toMatchObject({
      status: 409, code: "SOURCE_APPROVAL_BLOCKED", message: pausedEligibility().message, approval_eligibility: pausedEligibility(),
    });
  });

  it.each([undefined, { ...pausedEligibility(), policy: "unknown-policy" }, approvalSet().approval_eligibility,
    { ...pausedEligibility(), blocked_sources: [] }])("fails closed for a blocked error with unusable eligibility: %j", async eligibility => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: { code: "SOURCE_APPROVAL_BLOCKED", message: "private arbitrary server content" }, approval_eligibility: eligibility,
    }, 409)));
    await expect(adminApi("groups/demo/approve", {})).rejects.toMatchObject({
      status: 409, code: "SOURCE_APPROVAL_BLOCKED", approval_eligibility: null,
      message: "审批资格响应缺失或异常，当前不能批准，请联系后端核对；重新核对不能解除暂停。",
    });
  });

  it("does not attach qualification to unrelated HTTP errors or store an unvalidated constructor argument", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: { code: "CONFLICT", message: "证据已变化" }, approval_eligibility: pausedEligibility(),
    }, 409)));
    await expect(adminApi("groups/demo/approve", {})).rejects.toMatchObject({ code: "CONFLICT", message: "证据已变化", approval_eligibility: null });
    expect(new AdminError(409, "SOURCE_APPROVAL_BLOCKED", "安全提示", { arbitrary: "secret" }).approval_eligibility).toBeNull();
    expect(new AdminError(409, "SOURCE_APPROVAL_BLOCKED", "password=private", pausedEligibility()).message).toBe(pausedEligibility().message);
    expect(new AdminError(401, "SOURCE_APPROVAL_BLOCKED", "private message", pausedEligibility())).toMatchObject({
      approval_eligibility: null, message: "管理员密码不正确或登录已失效，请重新登录。",
    });
  });

  it("uses the same-origin cookie and passes cancellation without adding credentials to payloads", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ role: "styling-manager" }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await expect(adminApi("login", { password: "test-only-password" }, controller.signal)).resolves.toEqual({ role: "styling-manager" });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/admin/login", {
      cache: "no-store", credentials: "same-origin", signal: controller.signal, method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-only-password" }),
    });
  });

  it("preserves a safe backend conflict code and recovery reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "CONFLICT", message: "证据修订已变化，请重新加载" } }, 409)));
    await expect(adminApi("groups/demo/approve", {})).rejects.toMatchObject({
      name: "AdminError", status: 409, code: "CONFLICT", message: "证据修订已变化，请重新加载",
    });
  });

  it("accepts legacy detail errors while refusing raw configuration and credential messages", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ detail: "需求分组不存在" }, 404))
      .mockResolvedValueOnce(response({ detail: "password=secret /Users/private/config.json" }, 422));
    vi.stubGlobal("fetch", fetcher);
    await expect(adminApi("groups/missing")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND", message: "需求分组不存在" });
    await expect(adminApi("login", {})).rejects.toMatchObject({
      status: 422, code: "INVALID_REQUEST", message: "请求字段无效，请核对填写内容和筛选范围。",
    });
  });

  it.each([401, 500, 503])("never surfaces private server error details for HTTP %i", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "REQUEST_FAILED", message: "very-private-value" } }, status)));
    try { await adminApi("overview"); expect.fail("must reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect((error as AdminError).status).toBe(status);
      expect((error as AdminError).message).not.toContain("very-private-value");
    }
  });

  it("maps failed fetch to a safe network error without returning the exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("https://receiver/?token=private")));
    await expect(adminApi("overview")).rejects.toMatchObject({
      status: 0, code: "NETWORK_ERROR", message: "无法连接本地后端，请检查服务后重试；写操作请先刷新记录核对结果。",
    });
  });

  it("leaves deliberate cancellation recognizable to the caller", async () => {
    const cancellation = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cancellation));
    await expect(adminApi("overview")).rejects.toBe(cancellation);
  });

  it("handles invalid success JSON and HTML errors without exposing raw body", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValueOnce(new Response("<html>private traceback</html>", { status: 503 }))
      .mockResolvedValueOnce(response(null)));
    await expect(adminApi("overview")).rejects.toMatchObject({ status: 200, code: "INVALID_RESPONSE" });
    await expect(adminApi("overview")).rejects.toMatchObject({ status: 503, code: "NOT_CONFIGURED" });
    await expect(adminApi("overview")).rejects.toMatchObject({ status: 200, code: "INVALID_RESPONSE" });
  });
});

describe("frozen export", () => {
  it("preserves frozen UTF-8 bytes, Chinese text and whitespace without JSON reserialization", async () => {
    const frozenText = '{\n  "handoff_id": "DH-demo", "title": "秋季通勤裤子"\n}\n';
    const frozenBytes = new TextEncoder().encode(frozenText);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(frozenBytes, {
      headers: { "content-type": "application/json; charset=utf-8" },
    })));
    const file = await adminExport("DH-demo");
    expect(Array.from(new Uint8Array(await file.blob.arrayBuffer()))).toEqual(Array.from(frozenBytes));
  });

  it("returns a server filename and file blob without manufacturing a received state", async () => {
    const exported = new Response(JSON.stringify({ handoff_id: "DH-demo", revision: 2 }), {
      headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="DH-demo.json"' },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(exported));
    const file = await adminExport("DH-demo");
    expect(file.fileName).toBe("DH-demo.json");
    expect(await file.blob.text()).toBe(JSON.stringify({ handoff_id: "DH-demo", revision: 2 }));
  });

  it("rejects HTTP failure instead of downloading error JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "UNAUTHORIZED", message: "已过期" } }, 401)));
    await expect(adminExport("DH-demo")).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("rejects a successful HTML response and a failed file stream", async () => {
    const streamFailure = response({});
    vi.spyOn(streamFailure, "blob").mockRejectedValue(new Error("private path"));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("login", { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(streamFailure));
    await expect(adminExport("DH-demo")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(adminExport("DH-demo")).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", message: "交接包下载未完成，请重试并核对导出记录。" });
  });

  it("ignores unsafe download filenames from the header", async () => {
    const exported = response({});
    exported.headers.set("content-disposition", 'attachment; filename="../../private.json"');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(exported));
    expect((await adminExport("DH-demo")).fileName).toBe("DH-demo.json");
  });
});

describe("query and local display helpers", () => {
  it("preserves microseconds for seven-day and cumulative query boundaries", () => {
    const bounds = { window_start: "2026-10-01T00:00:00.123456Z", window_end: "2026-10-08T00:00:00.123456Z" };
    expect(windowQuery(bounds)).toEqual(bounds);
    expect(windowQuery({ ...bounds, window_start: null })).toEqual({ window_end: bounds.window_end });
    expect(adminQuery({ days: 0, ...windowQuery({ ...bounds, window_start: null }) })).toBe("?days=0&window_end=2026-10-08T00%3A00%3A00.123456Z");
  });
  it("retains zero days, page sizes and encoded filters while removing empty values", () => {
    expect(adminQuery({ days: 0, page: 2, page_size: 20, status: "", category: "裤子", unused: undefined, start: null })).toBe("?days=0&page=2&page_size=20&category=%E8%A3%A4%E5%AD%90");
    expect(adminQuery({ status: "" })).toBe("");
  });

  it("displays UTC timestamps in Shanghai and identifies unknown/invalid times", () => {
    expect(formatAdminTime("2026-10-08T00:30:00Z")).toContain("08:30:00");
    expect(formatAdminTime(null)).toBe("未记录");
    expect(formatAdminTime("bad date")).toBe("时间格式异常");
  });
});
