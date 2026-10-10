// @vitest-environment node
// Real product route handlers, identity/business SQLite and protocol validation; only Python signal HTTP is a fixture.
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate, createSession, hashPassword, requirePerson, revokeSession, type PersonSession } from "@/lib/auth";
import { createStaffInvite, registerStaff } from "@/lib/users-db";
import { sha256, type JsonObject } from "@/lib/partner-protocol";
import { partnerDatabase } from "@/lib/partner-store";
import { templateCandidate } from "@/lib/partner-template";
import { GET as detail, PATCH as patch } from "@/app/api/workbench/case/route";
import { GET as list } from "@/app/api/workbench/signals/route";
import { GET as history } from "@/app/api/workbench/history/route";
import { POST as postEvent, GET as getEvent } from "@/app/api/design-link/events/route";
import { GET as packages } from "@/app/api/design-link/packages/route";
import { POST as preview } from "@/app/api/workbench/template-preview/route";
import { GET as assetRoute } from "@/app/api/workbench/design-assets/[event_id]/[asset_id]/route";

vi.mock("server-only", () => ({}));
const origin = "http://127.0.0.1:3091";
const scope = "test-partner-scope";
const writer = "only-synthetic-design-writer-" + "w".repeat(32), reader = "only-synthetic-design-reader-" + "r".repeat(32);
const pair = { source_instance_id: "design-test", target_instance_id: "product-test", authorized_scope: scope };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
type Login = { token: string; person: PersonSession };
let directory: string, configPath: string, manager: Login, staff: Login, other: Login, signal: JsonObject, actionNumber = 0;
const directories: string[] = [];
const ids = { manager: "manager", staff: "staff", other: "other-staff" };
const password = "Synthetic-Password-Only-42";

function makeSignal(id = "SIG-DH-isolated-workflow"): JsonObject {
  const original = "秋季通勤宽松阔腿裤，不要紧身，预算500元以内。";
  const projection = [{ evidence_id: "EVD-synthetic-1", revision: 1, text: original, field_sources: { category: ["EVD-synthetic-1"], season: ["EVD-synthetic-1"], scene: ["EVD-synthetic-1"], fit: ["EVD-synthetic-1"], silhouette: ["EVD-synthetic-1"] }, data_origin: "synthetic" }];
  const raw = bytes(projection), time = "2026-10-10T00:00:00Z";
  return {
    schema_version: "pa-styling-signal/2", signal_id: id, signal_revision: 1,
    source_product: "personal_styling", source_instance_id: "styling-test", target_instance_id: "product-test", authorized_scope: scope,
    source_ref: { handoff_id: "DH-workflow-fixture", revision: 1, payload_digest: "a".repeat(64), supplement_id: "SUP-fixture", supplement_digest: "b".repeat(64), metadata_digest: "c".repeat(64), direct_receive_id: "DPRCV-fixture", approval_record_id: "STAPR-fixture", verification_id: "STV-fixture", verified_at: time },
    source_approval: { subject: "styling-manager-fixture", identity_kind: "account_bound", approved_at: time }, data_origin: "synthetic", environment: "synthetic_local",
    timestamp: time, timestamp_kind: "source_approved_at", scene: "通勤", season: "秋季", preference: original, change_reason: null, body_type_tag: null,
    outfit_plan: { items: [], note: null }, feedback_type: "demand_expression", source_agent: "outfit",
    demand: { title: "秋季通勤裤", description: original, attributes: { category: "裤装", season: "秋季", scene: "通勤", fit: "宽松", silhouette: "阔腿" }, occurrences: 1, session_count: 1, window_days: 7, material: null, craft: null, knowledge_status: "pending_database" },
    evidence_projection: projection, projection_base64: raw.toString("base64"), projection_digest: sha256(raw), provenance_status: "complete", mapping_version: "dh1.4-to-signal2/1",
  };
}
function setConfig(services = true) {
  writeFileSync(configPath, JSON.stringify({ instance_id: "product-test", design_instance_id: "design-test", authorized_scope: scope, origin, backend_url: "http://127.0.0.1:8091", backend_reader_token: "synthetic-python-reader-no-network-" + "x".repeat(32), services: services ? [
    { subject: "design-reader", purpose: "design_package_reader", ...pair, token: reader },
    { subject: "design-writer", purpose: "design_event_writer", ...pair, token: writer },
  ] : [] }), { mode: 0o600 }); chmodSync(configPath, 0o600);
}
function request(login: Login, path: string, raw?: string, method = "GET"): Request {
  return new Request(origin + path, { method, headers: { cookie: `zhixu_session=${login.token}`, origin, "x-csrf-token": login.person.csrf_token, ...(raw === undefined ? {} : { "content-type": "application/json" }) }, ...(raw === undefined ? {} : { body: raw }) });
}
function login(username: string, role: "staff" | "manager"): Login {
  const authenticated = authenticate(username, password); expect(authenticated?.role).toBe(role);
  const token = createSession(authenticated!);
  const person = requirePerson(new Request(origin, { headers: { cookie: `zhixu_session=${token}` } }));
  return { token, person };
}
function mutation(login: Login, action: string, revision: number, extra: JsonObject = {}, id = String(signal.signal_id), actionId?: string) {
  return { id, action, action_id: actionId ?? `action-${++actionNumber}`, expected_context: login.person.context, expected_revision: revision, ...extra };
}
async function send(login: Login, value: JsonObject) {
  const response = await patch(request(login, "/api/workbench/case", JSON.stringify(value), "PATCH"));
  return { status: response.status, body: await response.json() };
}
async function assign(id = String(signal.signal_id), assignee = "staff") {
  const result = await send(manager, mutation(manager, "assign", 0, { assignee, note: "合成测试分派" }, id));
  expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body;
}
async function save() {
  const candidate = templateCandidate(signal, "裤装", new Date().toISOString());
  const result = await send(staff, mutation(staff, "save_draft", 1, candidate));
  expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body;
}
function groupRef(saved: Awaited<ReturnType<typeof save>>): JsonObject { return { version_group_id: saved.case.version_group_id, requirement_digest: saved.case.requirement_digest, prompt_digest: saved.case.prompt_digest }; }
async function approved() {
  await assign(); const saved = await save(); const submitted = await send(staff, mutation(staff, "submit", 2, groupRef(saved)));
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const result = await send(manager, mutation(manager, "approve", 3, { ...groupRef(saved), submission_id: submitted.body.case.submission_id, final_priority: "P3", priority_reason: "合成优先级确认" }));
  expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body;
}
async function delivery(): Promise<JsonObject> {
  const response = await packages(new Request(origin + "/api/design-link/packages", { headers: { authorization: `Bearer ${reader}` } }));
  expect(response.status).toBe(200); return (await response.json()).items[0];
}
function designEvent(pkg: JsonObject, kind: "received" | "clarification" = "received") {
  const content = JSON.parse(Buffer.from(String(pkg.content_base64), "base64").toString());
  return { event_schema: "pa-design-event/2", event_id: `event-${kind}`, event_revision: 1, kind, source_product: "footwear_design", target_product: "product_management", ...pair,
    created_at: new Date().toISOString(), package_id: pkg.package_id, version: pkg.version, package_content_digest: pkg.content_digest, design_receive_id: "design-receive-fixture",
    version_group_id: content.version_group_id, requirement_digest: content.requirement_digest, prompt_digest: content.prompt_digest, note: "",
    design_receipt: kind === "received" ? { receipt_schema: "pa-design-receipt/2", design_receive_id: "design-receive-fixture", source_instance_id: "product-test", target_instance_id: "design-test", authorized_scope: scope, package_id: pkg.package_id, version: pkg.version, content_digest: pkg.content_digest, status: "received", received_at: new Date().toISOString() } : null,
    clarification: kind === "clarification" ? { decision_id: "design-decision-fixture", manager_subject: "design-manager", decided_at: new Date().toISOString(), reason: "请明确预算范围" } : null, result: null };
}
function envelope(event: JsonObject, content = bytes(event)) { return { delivery_schema: "pa-design-event-delivery/2", source_product: "footwear_design", target_product: "product_management", ...pair, event_id: event.event_id, event_revision: 1, content_digest: sha256(content), content_base64: content.toString("base64") }; }
async function eventRequest(event: JsonObject, raw = JSON.stringify(envelope(event)), token = writer) {
  const response = await postEvent(new Request(origin + "/api/design-link/events", { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": String(event.event_id), "content-type": "application/json" }, body: raw }));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "partner-workflow-isolated-")); directories.push(directory); configPath = join(directory, "config.json");
  signal = makeSignal(); actionNumber = 0; setConfig();
  vi.stubEnv("WORKBENCH_CONFIG_FILE", configPath); vi.stubEnv("WORKBENCH_USERS_DB", join(directory, "identities.sqlite")); vi.stubEnv("WORKBENCH_CASES_DB", join(directory, "cases.sqlite"));
  vi.stubEnv("WORKBENCH_SESSION_SECRET", "synthetic-secret-" + "s".repeat(40));
  const hash = hashPassword(password);
  vi.stubEnv("WORKBENCH_STAFF_USERNAME", ids.staff); vi.stubEnv("WORKBENCH_STAFF_PASSWORD_HASH", hash); vi.stubEnv("WORKBENCH_MANAGER_USERNAME", ids.manager); vi.stubEnv("WORKBENCH_MANAGER_PASSWORD_HASH", hash);
  vi.stubEnv("WORKBENCH_STAFF_ENABLED", "true"); vi.stubEnv("WORKBENCH_MANAGER_ENABLED", "true");
  const invite = createStaffInvite("manager"); expect(registerStaff(ids.other, "另一个合成员工", hash, invite.code, [ids.manager, ids.staff])).toBe("ok");
  manager = login(ids.manager, "manager"); staff = login(ids.staff, "staff"); other = login(ids.other, "staff");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(url)); expect(target.origin).toBe("http://127.0.0.1:8091"); expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer synthetic-python-reader-no-network-" + "x".repeat(32));
    if (target.pathname === "/api/internal/signals") return Response.json({ items: [signal, makeSignal("SIG-DH-other")], next_cursor: null });
    if (target.pathname === `/api/internal/signals/${signal.signal_id}`) return Response.json({ signal });
    if (target.pathname === "/api/internal/signals/SIG-DH-other") return Response.json({ signal: makeSignal("SIG-DH-other") });
    throw new Error("Unexpected fixture network target");
  }));
});

// Application routes and identity/business databases are real and isolated here.
// Design review/asset fetches are fixtures; these tests do not claim live design delivery or generation.
const fixturePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=", "base64");
function approvedDesignEvent(pkg: JsonObject, model = false): JsonObject {
  const event: JsonObject = { ...designEvent(pkg), event_id: "event-approved-assets", kind: "design_approved", design_receipt: null };
  const version: JsonObject = {
    schema_version: "pa-design-result-version/2", design_version_id: "design-version-assets", task_id: "design-task-assets", assignment_id: "design-assignment-assets",
    design_receive_id: event.design_receive_id, package_id: event.package_id, package_version: event.version, package_content_digest: event.package_content_digest,
    version_group_id: event.version_group_id, requirement_digest: event.requirement_digest, prompt_digest: event.prompt_digest,
    assets: [{ asset_id: "design-asset-fixture", sha256: sha256(fixturePng), mime_type: "image/png", width: 1, height: 1, origin: "synthetic_fixture" }],
    summary: "隔离素材代理测试", changes: "", checks: [], unknowns: ["真实设计图片待验"], generation_mode: "synthetic_fixture", created_by: "design-staff", created_at: new Date().toISOString(),
  };
  if (model) {
    const rawPrompt = Buffer.from("设计秋季通勤宽松阔腿裤，不要紧身，预算500元以内。", "utf8");
    version.generation_mode = "model_generated"; (version.assets as JsonObject[])[0].origin = "model_generated";
    version.generation_provenance = {
      schema_version: "pa-image-generation/1", provider: "fixture-only-no-provider-call", model: "fixture-alias", response_model: null,
      generation_task_id: "generation-task-fixture", generation_attempt_id: "generation-attempt-fixture", provider_request_id: null,
      execution_prompt_id: "execution-fixture", execution_prompt_digest: sha256(rawPrompt), execution_prompt_base64: rawPrompt.toString("base64"), source_product_prompt_digest: event.prompt_digest,
      authorization_ref: "authorization-fixture", started_at: new Date(Date.now() - 2000).toISOString(), completed_at: new Date(Date.now() - 1000).toISOString(), actual_cost_fen: null,
    };
  }
  const frozen = bytes(version), hash = sha256(frozen);
  event.result = {
    task_id: version.task_id, assignment_id: version.assignment_id, submission_id: "design-submission-assets", design_version_id: version.design_version_id,
    design_version_digest: hash, design_version_base64: frozen.toString("base64"),
    review: { review_id: "design-review-assets", manager_subject: "design-manager", approved_at: new Date().toISOString(), decision: "approved", submission_id: "design-submission-assets", design_version_id: version.design_version_id, design_version_digest: hash },
    assets: version.assets, summary: version.summary, changes: version.changes, checks: version.checks, unknowns: version.unknowns, generation_mode: version.generation_mode,
  };
  if (model) (event.result as JsonObject).generation_provenance = version.generation_provenance;
  event.created_at = new Date().toISOString();
  return event;
}
function designFixture(event: JsonObject, assetResponse: () => Response | Promise<Response> = () => new Response(fixturePng, { headers: { "content-type": "image/png" } }), proofOverride?: JsonObject) {
  const c = JSON.parse(readFileSync(configPath, "utf8"));
  c.design_asset_base_url = "http://127.0.0.1:8092"; c.design_asset_reader_token = "synthetic-asset-reader-" + "a".repeat(32);
  writeFileSync(configPath, JSON.stringify(c), { mode: 0o600 });
  const priorFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, opts) => {
    const target = new URL(String(url));
    if (target.origin !== "http://127.0.0.1:8092") return priorFetch(url, opts);
    expect(opts?.redirect).toBe("error"); expect(opts?.cache).toBe("no-store");
    expect(new Headers(opts?.headers).get("authorization")).toBe("Bearer " + c.design_asset_reader_token);
    if (target.pathname === `/api/design-integration/events/${event.event_id}/review`) {
      const body = envelope(event); return Response.json(proofOverride ?? { event_schema: event.event_schema, event_id: event.event_id, event_revision: event.event_revision, content_digest: body.content_digest, content_base64: body.content_base64 });
    }
    expect(target.pathname).toBe(`/api/design-integration/events/${event.event_id}/assets/design-asset-fixture`);
    return assetResponse();
  });
}
async function assetRequest(who: Login | null, eventId = "event-approved-assets", assetId = "design-asset-fixture") {
  const req = who ? request(who, `/api/workbench/design-assets/${eventId}/${assetId}`) : new Request(origin + `/api/workbench/design-assets/${eventId}/${assetId}`);
  return assetRoute(req, { params: Promise.resolve({ event_id: eventId, asset_id: assetId }) });
}
async function receiveFixtureResult(model = false) {
  await approved(); const d = await delivery(); expect((await eventRequest(designEvent(d))).status).toBe(201);
  const result = approvedDesignEvent(d, model); designFixture(result);
  expect((await eventRequest(result)).status).toBe(201); return result;
}

describe("private reviewed design assets with real authorization and fixture upstream", () => {
  it("receives provenance-bound model metadata once, conflicts on changed inner bytes, and serves privately", async () => {
    const e = await receiveFixtureResult(true); const repeat = await eventRequest(e);
    expect(repeat.status).toBe(200); expect(repeat.body.receipt_schema).toBe("pa-design-event-receipt/2");
    const queried = await getEvent(new Request(origin + `/api/design-link/events?event_id=${e.event_id}`, { headers: { authorization: `Bearer ${writer}` } }));
    expect(await queried.json()).toEqual(repeat.body);
    const conflict = await eventRequest(e, JSON.stringify(envelope(e, Buffer.concat([bytes(e), Buffer.from(" ")]))));
    expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe("EVENT_CONFLICT");
    expect((await eventRequest(e, JSON.stringify(envelope(e)), reader)).status).toBe(403);
    const badPair = { ...e, event_id: "other-scope-event", authorized_scope: "wrong-scope" };
    expect((await eventRequest(badPair)).status).toBe(422);
    const asset = await assetRequest(staff); expect(asset.status).toBe(200); expect(Buffer.from(await asset.arrayBuffer())).toEqual(fixturePng);
    expect(partnerDatabase().prepare("SELECT count(*) AS n FROM partner_events").get()?.n).toBe(2);
    const row = partnerDatabase().prepare("SELECT content FROM partner_events WHERE event_id=?").get(String(e.event_id)) as { content: Uint8Array };
    expect(Buffer.from(row.content)).toEqual(bytes(e));
  });
  it("refuses model metadata without the received predecessor before querying design", async () => {
    await approved(); const d = await delivery(); const e = approvedDesignEvent(d, true); designFixture(e); vi.mocked(fetch).mockClear();
    const early = await eventRequest(e); expect(early.status).toBe(409); expect(early.body.error.code).toBe("RECEIPT_NOT_CONFIRMED");
    expect(fetch).not.toHaveBeenCalled(); expect(partnerDatabase().prepare("SELECT count(*) AS n FROM partner_events").get()?.n).toBe(0);
  });
  it("serves exact reviewed bytes to manager and assigned staff with private headers", async () => {
    await receiveFixtureResult();
    for (const who of [manager, staff]) {
      const response = await assetRequest(who); expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fixturePng);
      expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-content-sha256")).toBe(sha256(fixturePng));
    }
  });
  it("blocks anonymous, unrelated staff, unknown assets and received-only resources before fetch", async () => {
    await receiveFixtureResult(); vi.mocked(fetch).mockClear();
    expect((await assetRequest(null)).status).toBe(401); expect((await assetRequest(other)).status).toBe(404);
    expect((await assetRequest(manager, "event-approved-assets", "unknown-asset")).status).toBe(404);
    expect((await assetRequest(manager, "event-received")).status).toBe(404); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["mime", "magic", "digest"])("rejects %s mismatch without serving upstream bytes", async failure => {
    const e = await receiveFixtureResult();
    designFixture(e, () => new Response(failure === "magic" ? Buffer.from("not-an-image") : failure === "digest" ? Buffer.concat([fixturePng, Buffer.from("changed")]) : fixturePng, { headers: { "content-type": failure === "mime" ? "image/jpeg" : "image/png" } }));
    const response = await assetRequest(manager); expect(response.status).toBe(502); expect((await response.json()).error.code).toBe("ASSET_MISMATCH");
  });
  it("rejects a resource exceeding10MiB", async () => {
    const e = await receiveFixtureResult(); designFixture(e, () => new Response(Buffer.alloc(10 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }));
    const response = await assetRequest(manager); expect(response.status).toBe(502); expect((await response.json()).error.code).toBe("TOO_LARGE");
  });
  it("rechecks a revoked employee session after the upstream await", async () => {
    const e = await receiveFixtureResult(); designFixture(e, () => { revokeSession(staff.person); return new Response(fixturePng, { headers: { "content-type": "image/png" } }); });
    expect((await assetRequest(staff)).status).toBe(401);
  });
  it("refuses a reviewed result whose fixed service proof differs and does not store it", async () => {
    await approved(); const d = await delivery(); expect((await eventRequest(designEvent(d))).status).toBe(201);
    const e = approvedDesignEvent(d); designFixture(e, undefined, { event_schema: e.event_schema, event_id: e.event_id, event_revision: 1, content_digest: "f".repeat(64), content_base64: "e30=" });
    const response = await eventRequest(e); expect(response.status).toBe(409); expect(response.body.error.code).toBe("EVENT_CONFLICT");
    expect(partnerDatabase().prepare("SELECT count(*) AS n FROM partner_events").get()?.n).toBe(1);
  });
});
afterEach(() => {
  // Close the current isolated real connection. Every test uses a new absolute path, so the closed cached handle is never reused.
  try { partnerDatabase().close(); } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("partner workflow with real identities and isolated SQLite", () => {
  it("assigns, saves exact template snapshots, submits fixed group and approves P3 without downstream credentials", async () => {
    setConfig(false); const result = await approved(); expect(result.case.status).toBe("approved"); expect(result.case.transport_status).toBe("not_configured");
    const row = partnerDatabase().prepare("SELECT content,digest FROM partner_packages").get() as { content: Uint8Array; digest: string };
    const pkg = JSON.parse(Buffer.from(row.content).toString()); expect(sha256(row.content)).toBe(row.digest); expect(pkg.approval.final_priority).toBe("P3"); expect(pkg.version_group_id).toBe(result.case.version_group_id);
    expect(JSON.parse(Buffer.from(pkg.prompt_base64, "base64").toString())).toEqual(result.version.prompt); expect(pkg.data_origin).toBe("synthetic");
  });
  it("filters staff list server-side and rejects direct other detail/history", async () => {
    await assign(); await assign("SIG-DH-other", "other-staff"); vi.mocked(fetch).mockClear();
    const response = await list(request(staff, "/api/workbench/signals")); const body = await response.json(); expect(response.status).toBe(200);
    expect(body.signals.map((x: JsonObject) => x.signal_id)).toEqual([signal.signal_id]); expect(body.staff).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    for (const handler of [detail, history]) expect((await handler(request(staff, "/api/workbench/case?id=SIG-DH-other"))).status).toBe(404);
    expect((await detail(request(other, `/api/workbench/case?id=${signal.signal_id}`))).status).toBe(404);
  });
  it("rejects old revision and other session context without a saved version", async () => {
    await assign(); const candidate = templateCandidate(signal, "裤装", new Date().toISOString());
    const stale = await send(staff, mutation(staff, "save_draft", 0, candidate)); expect(stale.status).toBe(409); expect(stale.body.error.code).toBe("REVISION_CONFLICT");
    const wrong = await send(staff, mutation(staff, "save_draft", 1, { ...candidate, expected_context: other.person.context })); expect(wrong.status).toBe(409); expect(wrong.body.error.code).toBe("CONTEXT_CONFLICT");
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_versions").get()?.n).toBe(0);
  });
  it("returns original action response only for exact bytes and live original identity", async () => {
    const value = mutation(manager, "assign", 0, { assignee: "staff", note: "原动作" }, String(signal.signal_id), "stable-action");
    const first = await send(manager, value), repeat = await send(manager, value); expect(repeat).toEqual(first);
    const changed = await send(manager, { ...value, note: "不同内容" }); expect(changed.status).toBe(409); expect(changed.body.error.code).toBe("ACTION_CONFLICT");
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_actions").get()?.n).toBe(1);
    revokeSession(manager.person); expect((await send(manager, value)).status).toBe(401);
  });
  it("cannot submit floating text or wrong digest; keeps immutable saved version", async () => {
    await assign(); const saved = await save(); const original = JSON.stringify(saved.version);
    const floating = await send(staff, mutation(staff, "submit", 2, { ...groupRef(saved), prompt: { positive_prompt: "新稿" } })); expect(floating.status).toBe(422);
    const wrong = await send(staff, mutation(staff, "submit", 2, { ...groupRef(saved), prompt_digest: "0".repeat(64) })); expect(wrong.status).toBe(409);
    const current = await (await detail(request(staff, `/api/workbench/case?id=${signal.signal_id}`))).json(); expect(JSON.stringify(current.version)).toBe(original); expect(current.case.status).toBe("assigned");
  });
  it("requires explicit author/source and refuses invented template body", async () => {
    await assign(); const candidate = templateCandidate(signal, "裤装", new Date().toISOString()); candidate.prompt.positive_prompt = "随意改为红色鞋";
    const result = await send(staff, mutation(staff, "save_draft", 1, candidate)); expect(result.status).toBe(422); expect(result.body.error.code).toBe("INVALID_INPUT");
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_versions").get()?.n).toBe(0);
  });
  it("rejects nonexistent candidate derivation and accepts an actual saved prompt derivation", async () => {
    await assign(); const original = await save();
    const candidate = templateCandidate(signal, "裤装", new Date().toISOString());
    const generation = candidate.prompt.generation as JsonObject;
    generation.mode = "human_authored"; generation.derived_from = { kind: "candidate", id: "unpersisted-candidate", prompt_digest: original.version.prompt_digest };
    const fake = await send(staff, mutation(staff, "save_draft", 2, candidate)); expect(fake.status).toBe(422);
    generation.derived_from = { kind: "saved_prompt", id: original.version.version_group_id, prompt_digest: original.version.prompt_digest };
    const actual = await send(staff, mutation(staff, "save_draft", 2, candidate)); expect(actual.status, JSON.stringify(actual.body)).toBe(200);
    expect(actual.body.version.prompt.generation.mode).toBe("human_authored"); expect(actual.body.version.prompt.generation.derived_from.id).toBe(original.version.version_group_id);
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_versions").get()?.n).toBe(2);
  });
  it("rejects assigning a disabled bootstrap staff without creating case or action", async () => {
    vi.stubEnv("WORKBENCH_STAFF_ENABLED", "false");
    const result = await send(manager, mutation(manager, "assign", 0, { assignee: "staff", note: "停用身份不得分派" })); expect(result.status).toBe(422);
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_cases").get()?.n).toBe(0); expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_actions").get()?.n).toBe(0);
  });
  it("rejects incomplete provenance and wrong target before creating any assignment or action", async () => {
    for (const change of [{ provenance_status: "incomplete" }, { target_instance_id: "another-product-instance" }]) {
      signal = { ...makeSignal(), ...change };
      const result = await send(manager, mutation(manager, "assign", 0, { assignee: "staff", note: "来源必须完整且目标匹配" }));
      expect(result.status).toBe(422); expect(result.body.error.code).toBe("PROVENANCE_INCOMPLETE");
      expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_cases").get()?.n).toBe(0);
      expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_actions").get()?.n).toBe(0);
    }
  });
  it.each(["disabled", "revoked"] as const)("rechecks identity %s while awaiting streamed preview body", async change => {
    await assign();
    const input = { id: signal.signal_id, expected_context: staff.person.context, expected_revision: 1, design_object: "裤装" };
    let markReadStarted!: () => void, releaseRead!: () => void, controller!: ReadableStreamDefaultController<Uint8Array>;
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { markReadStarted(); return readReleased; } }, { highWaterMark: 0 });
    const req = new Request(origin + "/api/workbench/template-preview", {
      method: "POST", headers: { cookie: `zhixu_session=${staff.token}`, origin, "x-csrf-token": staff.person.csrf_token, "content-type": "application/json" },
      body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = preview(req);
    await readStarted; // Real requirePerson has succeeded; the handler is now blocked inside body().
    if (change === "disabled") vi.stubEnv("WORKBENCH_STAFF_ENABLED", "false"); else revokeSession(staff.person);
    controller.enqueue(bytes(input)); controller.close(); releaseRead();
    const response = await pending; const result = await response.json();
    expect(response.status).toBe(401); expect(result.error.code).toBe("UNAUTHORIZED"); expect(result).not.toHaveProperty("candidate");
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_versions").get()?.n).toBe(0);
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_actions").get()?.n).toBe(1); // Only the preceding manager assignment.
  });
  it("preserves known avoidance and budget in template, not only buried source excerpt", () => {
    const candidate = templateCandidate(signal, "裤装", new Date().toISOString());
    expect(candidate.prompt.positive_prompt).toContain("不要紧身"); expect(candidate.prompt.positive_prompt).toContain("500");
    expect(candidate.requirement.constraints.join(" ")).toContain("不要紧身"); expect(candidate.requirement.constraints.join(" ")).toContain("500"); expect(candidate.prompt.avoid_items.join(" ")).toContain("紧身");
  });
  it("retains a required field source at the ninth evidence position and saves it", async () => {
    const projection = signal.evidence_projection as JsonObject[];
    (projection[0].field_sources as JsonObject).fit = ["EVD-required-ninth"];
    for (let i = 2; i <= 8; i++) projection.push({ evidence_id: `EVD-display-${i}`, revision: 1, text: `第${i}条合成展示片段`, field_sources: {}, data_origin: "synthetic" });
    projection.push({ evidence_id: "EVD-required-ninth", revision: null, text: "明确希望宽松版型", field_sources: { fit: ["EVD-required-ninth"] }, data_origin: "synthetic" });
    const raw = bytes(projection); signal.projection_base64 = raw.toString("base64"); signal.projection_digest = sha256(raw);
    await assign(); const result = await save();
    const refs = result.version.prompt.source_refs as JsonObject[];
    expect(refs.some(ref => ref.evidence_id === "EVD-required-ninth" && ref.evidence_revision === null && ref.excerpt === "明确希望宽松版型")).toBe(true);
    expect(result.version.prompt.design_spec.fit).toBe("宽松"); expect(result.case.requirement_version).toBe(1); expect(result.case.prompt_version).toBe(1);
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_versions").get()?.n).toBe(1);
  });
  it("preserves known color in full prompt and spec, then saves without invented unknown", async () => {
    const demand = signal.demand as JsonObject; (demand.attributes as JsonObject).color = "浅蓝";
    demand.description = `${demand.description}颜色选择浅蓝。`;
    const projection = signal.evidence_projection as JsonObject[]; projection[0].text = `${projection[0].text}颜色选择浅蓝。`;
    (projection[0].field_sources as JsonObject).color = [projection[0].evidence_id];
    const raw = bytes(projection); signal.projection_base64 = raw.toString("base64"); signal.projection_digest = sha256(raw);
    await assign(); const result = await save();
    expect(result.version.prompt.positive_prompt).toContain("浅蓝"); expect(result.version.prompt.design_spec.color).toBe("浅蓝");
    expect((result.version.prompt.unknowns as JsonObject[]).some(item => item.field_path === "design_spec.color")).toBe(false);
    expect(result.version.prompt.human_additions).toEqual([]); expect(result.case.status).toBe("assigned");
    const stored = partnerDatabase().prepare("SELECT data FROM partner_versions").get() as { data: string };
    expect(JSON.parse(stored.data).prompt.design_spec.color).toBe("浅蓝");
  });
  it("serializes the direct strict12-field event receipt for first delivery, retry and query", async () => {
    await approved(); const d = await delivery(); const e = designEvent(d);
    const first = await eventRequest(e); expect(first.status).toBe(201);
    const fields = "receipt_schema event_receive_id event_id event_revision source_instance_id target_instance_id authorized_scope content_digest package_id version status received_at".split(" ").sort();
    expect(Object.keys(first.body).sort()).toEqual(fields);
    expect(first.body).toMatchObject({ receipt_schema: "pa-design-event-receipt/2", event_id: e.event_id, event_revision: 1, ...pair, package_id: e.package_id, version: e.version, content_digest: envelope(e).content_digest, status: "received" });
    const stored = partnerDatabase().prepare("SELECT receipt FROM partner_events WHERE event_id=?").get(e.event_id) as { receipt: string };
    expect(first.body).toEqual(JSON.parse(stored.receipt));
    const repeat = await eventRequest(e); expect(repeat.status).toBe(200); expect(repeat.body).toEqual(first.body);
    const query = await getEvent(new Request(origin + `/api/design-link/events?event_id=${e.event_id}`, { headers: { authorization: `Bearer ${writer}` } }));
    expect(query.status).toBe(200); expect(await query.text()).toBe(stored.receipt);
    expect(partnerDatabase().prepare("SELECT count(*) AS n FROM partner_events").get()?.n).toBe(1);
  });
  it("records real received event once; outer whitespace repeats, original content whitespace conflicts", async () => {
    await approved(); const d = await delivery(); const e = designEvent(d); const raw = JSON.stringify(envelope(e));
    const first = await eventRequest(e, raw); expect(first.status, JSON.stringify(first.body)).toBe(201);
    const repeat = await eventRequest(e, " \n" + raw); expect(repeat.status).toBe(200); expect(repeat.body).toEqual(first.body);
    const innerWhitespace = JSON.stringify(envelope(e, Buffer.concat([bytes(e), Buffer.from(" ")]))); const conflict = await eventRequest(e, innerWhitespace);
    expect(conflict.status).toBe(409); expect(conflict.body.error.code).toBe("EVENT_CONFLICT");
    const query = await getEvent(new Request(origin + `/api/design-link/events?event_id=${e.event_id}`, { headers: { authorization: `Bearer ${writer}` } })); expect(await query.json()).toEqual(first.body);
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_events").get()?.n).toBe(1);
  });
  it("refuses clarification before received, then preserves separate event and explicit reopen", async () => {
    await approved(); const d = await delivery(); const clarification = designEvent(d, "clarification");
    const early = await eventRequest(clarification); expect(early.status).toBe(409); expect(early.body.error.code).toBe("RECEIPT_NOT_CONFIRMED");
    expect((await eventRequest(designEvent(d))).status).toBe(201); expect((await eventRequest(clarification)).status).toBe(201);
    const before = await (await detail(request(manager, `/api/workbench/case?id=${signal.signal_id}`))).json(); expect(before.case.status).toBe("approved");
    const reopened = await send(manager, mutation(manager, "reopen", before.case.case_revision)); expect(reopened.status).toBe(200); expect(reopened.body.case.status).toBe("returned"); expect(reopened.body.case.assignee).toBe("staff"); expect(reopened.body.case.note).toBe("请明确预算范围");
    expect(partnerDatabase().prepare("SELECT COUNT(*) AS n FROM partner_events").get()?.n).toBe(2);
  });
  it("requires event header/purpose and rejects received relation changes", async () => {
    await approved(); const d = await delivery(); const e = designEvent(d);
    expect((await eventRequest(e, JSON.stringify(envelope(e)), reader)).status).toBe(403);
    expect((await eventRequest(e)).status).toBe(201);
    const changed = designEvent(d); changed.event_id = "second-receive"; changed.design_receive_id = "other-receive"; changed.design_receipt!.design_receive_id = "other-receive";
    const result = await eventRequest(changed); expect(result.status).toBe(409); expect(result.body.error.code).toBe("EVENT_CONFLICT");
  });
});
