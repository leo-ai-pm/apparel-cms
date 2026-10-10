// @vitest-environment node
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeContent, CONTENT_LIMIT, ENVELOPE_LIMIT, makeApprovedPackage, parseStrictJson, ProtocolError, sha256, validateDesignEvent, validateSavedContent, type JsonObject } from "@/lib/partner-protocol";

vi.mock("server-only", () => ({}));
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const freeze = (value: unknown) => { const raw = bytes(value); return { digest: sha256(raw), base64: raw.toString("base64") }; };
const time = "2026-10-10T00:00:00Z";
const productPair = { source_instance_id: "product-new", target_instance_id: "design-new", authorized_scope: "scope-new" };
const eventPair = { source_instance_id: "design-new", target_instance_id: "product-new", authorized_scope: "scope-new" };

function saved() {
  const evidence = [{ evidence_id: "evidence-1", revision: 1, text: "秋季通勤宽松阔腿裤，不要紧身，预算500元以内。", field_sources: { category: ["evidence-1"], season: ["evidence-1"], scene: ["evidence-1"], fit: ["evidence-1"], silhouette: ["evidence-1"] }, data_origin: "runtime_demo" }];
  const projection = freeze(evidence);
  const signal: JsonObject = {
    schema_version: "pa-styling-signal/2", signal_id: "SIG-DH-synthetic", signal_revision: 1,
    source_product: "personal_styling", source_instance_id: "styling-new", target_instance_id: "product-new", authorized_scope: "scope-new",
    source_ref: { handoff_id: "DH-synthetic", revision: 1, payload_digest: "a".repeat(64), supplement_id: "supplement-1", supplement_digest: "b".repeat(64), metadata_digest: "c".repeat(64), direct_receive_id: "receive-1", approval_record_id: "source-approval-1", verification_id: "verify-1", verified_at: time },
    source_approval: { subject: "source-manager", identity_kind: "account_bound", approved_at: time },
    data_origin: "runtime_demo", environment: "synthetic_local", demand: { occurrences: 5, session_count: 3, attributes: { category: "裤装", season: "秋季", scene: "通勤", fit: "宽松", silhouette: "阔腿" } },
    evidence_projection: evidence, projection_base64: projection.base64, projection_digest: projection.digest,
    provenance_status: "complete", mapping_version: "dh1.4-to-signal2/1",
  };
  const requirement: JsonObject = { title: "通勤裤", requirement_desc: "秋季通勤宽松阔腿裤", design_object: "裤装", constraints: ["不要紧身", "预算500元以内"], priority_proposal: "P3", priority_reason: "合成任务顺序" };
  const prompt: JsonObject = {
    positive_prompt: "设计秋季通勤宽松阔腿裤，不要紧身，预算500元以内。", avoid_items: ["紧身"],
    design_spec: { category: "裤装", season: "秋季", scene: "通勤", fit: "宽松", silhouette: "阔腿", color: null, material: null, craft: null, knowledge_status: "pending_database", display_requirements: [{ id: "display-1", text: "完整展示裤装轮廓", origin: "display_template", template_version: "offline-v1" }] },
    generation: { mode: "human_authored", template_version: null, model: null, generated_at: time, derived_from: null },
    source_refs: [{ source_ref_id: "ref-1", signal_id: signal.signal_id, source_payload_digest: "a".repeat(64), evidence_id: "evidence-1", evidence_revision: 1, field_path: "design_spec.category", excerpt: "阔腿裤" }],
    human_additions: [], unknowns: [{ field_path: "design_spec.material", reason: "来源未知", blocking: false }], conflicts: [],
  };
  return { signal, requirement, prompt };
}
function approved() {
  const data = saved(); const requirement = freeze(data.requirement), prompt = freeze(data.prompt);
  const group = { version_group_id: "group-1", requirement_version: 1, prompt_version: 1, requirement_digest: requirement.digest, requirement_base64: requirement.base64, prompt_digest: prompt.digest, prompt_base64: prompt.base64 };
  const approval: JsonObject = { approval_schema: "pa-product-approval/2", decision_id: "decision-1", approved_by: "product-manager", approved_at: time, version_group_id: group.version_group_id, requirement_digest: requirement.digest, prompt_digest: prompt.digest, final_priority: "P2", priority_reason: "合成审核" };
  return { ...data, group, approval };
}
function event(kind: "received" | "clarification" | "design_approved" = "received"): JsonObject {
  const obj: JsonObject = {
    event_schema: "pa-design-event/2", event_id: `event-${kind}`, event_revision: 1, kind,
    source_product: "footwear_design", target_product: "product_management", ...eventPair, created_at: time,
    package_id: "PKG-WB-SIG-DH-synthetic", version: "v1", package_content_digest: "a".repeat(64), design_receive_id: "design-receive-1",
    version_group_id: "group-1", requirement_digest: "b".repeat(64), prompt_digest: "c".repeat(64), note: "", design_receipt: null, clarification: null, result: null,
  };
  if (kind === "received") obj.design_receipt = { receipt_schema: "pa-design-receipt/2", design_receive_id: obj.design_receive_id, ...productPair, package_id: obj.package_id, version: "v1", content_digest: obj.package_content_digest, status: "received", received_at: time };
  if (kind === "clarification") obj.clarification = { decision_id: "clarification-1", manager_subject: "design-manager", decided_at: time, reason: "请核对避免项" };
  if (kind === "design_approved") {
    const resultVersion = {
      schema_version: "pa-design-result-version/2", design_version_id: "design-version-1", task_id: "task-1", assignment_id: "assignment-1",
      design_receive_id: obj.design_receive_id, package_id: obj.package_id, package_version: obj.version, package_content_digest: obj.package_content_digest,
      version_group_id: obj.version_group_id, requirement_digest: obj.requirement_digest, prompt_digest: obj.prompt_digest,
      assets: [{ asset_id: "asset-1", sha256: "d".repeat(64), mime_type: "image/png", width: 16, height: 16, origin: "synthetic_fixture" }],
      summary: "合成技术素材", changes: "", checks: [{ code: "technical_fixture", status: "passed", note: "不代表生图质量" }], unknowns: ["实物效果未验"], generation_mode: "synthetic_fixture", created_by: "design-staff", created_at: time,
    };
    const frozen = freeze(resultVersion);
    obj.result = {
      task_id: resultVersion.task_id, assignment_id: resultVersion.assignment_id, submission_id: "submission-1", design_version_id: resultVersion.design_version_id,
      design_version_digest: frozen.digest, design_version_base64: frozen.base64,
      review: { review_id: "review-1", manager_subject: "design-manager", approved_at: time, decision: "approved", submission_id: "submission-1", design_version_id: resultVersion.design_version_id, design_version_digest: frozen.digest },
      assets: resultVersion.assets, summary: resultVersion.summary, changes: resultVersion.changes, checks: resultVersion.checks, unknowns: resultVersion.unknowns, generation_mode: resultVersion.generation_mode,
    };
  }
  return obj;
}
function deliver(value: JsonObject, rawContent = bytes(value)): Buffer {
  return bytes({ delivery_schema: "pa-design-event-delivery/2", source_product: value.source_product, target_product: value.target_product, source_instance_id: value.source_instance_id, target_instance_id: value.target_instance_id, authorized_scope: value.authorized_scope, event_id: value.event_id, event_revision: value.event_revision, content_digest: sha256(rawContent), content_base64: rawContent.toString("base64") });
}
// Metadata fixtures only; these tests never call an image provider or establish actual generation.
function modelEvent(): JsonObject {
  const e = event("design_approved"), r = e.result as JsonObject;
  const v = JSON.parse(Buffer.from(String(r.design_version_base64), "base64").toString()) as JsonObject;
  const execution = Buffer.from("秋季通勤宽松阔腿裤，不要紧身，预算500元以内；完整展示。", "utf8");
  const provenance = {
    schema_version: "pa-image-generation/1", provider: "isolated-provider-fixture", model: "gateway-alias-fixture", response_model: null,
    generation_task_id: "image-task-fixture", generation_attempt_id: "image-attempt-fixture", provider_request_id: null,
    execution_prompt_id: "execution-prompt-fixture", execution_prompt_digest: sha256(execution), execution_prompt_base64: execution.toString("base64"),
    source_product_prompt_digest: e.prompt_digest, authorization_ref: "authorization-fixture", started_at: "2026-10-09T23:59:58Z", completed_at: "2026-10-09T23:59:59Z", actual_cost_fen: null,
  };
  r.generation_mode = v.generation_mode = "model_generated";
  r.generation_provenance = v.generation_provenance = provenance;
  (r.assets as JsonObject[])[0].origin = "model_generated"; v.assets = r.assets;
  const frozen = freeze(v); r.design_version_base64 = frozen.base64; r.design_version_digest = frozen.digest;
  (r.review as JsonObject).design_version_digest = frozen.digest;
  return e;
}
function resealModel(e: JsonObject): void {
  const r = e.result as JsonObject, v = JSON.parse(Buffer.from(String(r.design_version_base64), "base64").toString()) as JsonObject;
  v.generation_mode = r.generation_mode; v.generation_provenance = r.generation_provenance; v.assets = r.assets;
  const frozen = freeze(v); r.design_version_base64 = frozen.base64; r.design_version_digest = frozen.digest; (r.review as JsonObject).design_version_digest = frozen.digest;
}
function rejected(fn: () => unknown, code = "INVALID_INPUT", status = 422) {
  expect(fn).toThrow(ProtocolError);
  try { fn(); } catch (error) { expect(error).toMatchObject({ code, status }); return; }
  throw new Error("expected rejection");
}

describe("strict v2 byte parsing", () => {
  it("accepts UTF-8 primitives and deep JSON values without modifying keys", () => {
    expect(parseStrictJson(Buffer.from(' {"中文":[true,false,null,-12.5,1e2],"__proto__":{"admin":true}} \n'))).toEqual({ 中文: [true, false, null, -12.5, 100], ["__proto__"]: { admin: true } });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
  it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"a":1,"a":2}}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}', '{"x":9007199254740993}', '[1,]', '{"a":1,}', 'true false', '{"a":01}', '{"a":"\n"}', '\ufeff{}', ''])('rejects invalid JSON %j', raw => rejected(() => parseStrictJson(Buffer.from(raw))));
  it("rejects invalid UTF-8 without replacement", () => rejected(() => parseStrictJson(Uint8Array.from([123, 34, 120, 34, 58, 34, 0xc3, 0x28, 34, 125]))));
  it("checks exact byte size boundary", () => { expect(parseStrictJson(Buffer.from('"中"'), 5)).toBe("中"); rejected(() => parseStrictJson(Buffer.from('"中"'), 4), "PAYLOAD_TOO_LARGE", 413); });
  it("bounds nesting", () => rejected(() => parseStrictJson(Buffer.from("[".repeat(66) + "0" + "]".repeat(66)))));
});

describe("1.0.2 model result branch with isolated provenance metadata", () => {
  it("accepts complete model branch with unknown returned model/request/cost and distinct source/execution hashes", () => {
    const e = modelEvent(), r = e.result as JsonObject, p = r.generation_provenance as JsonObject;
    expect(p.execution_prompt_digest).not.toBe(e.prompt_digest);
    expect(validateDesignEvent(deliver(e), eventPair).event).toEqual(e);
  });
  it("accepts actual nonnull returned identifiers and zero known cost", () => {
    const e = modelEvent(), p = (e.result as JsonObject).generation_provenance as JsonObject;
    p.response_model = "response-model-fixture"; p.provider_request_id = "request-fixture"; p.actual_cost_fen = 0; resealModel(e);
    expect(() => validateDesignEvent(deliver(e), eventPair)).not.toThrow();
  });
  it.each("schema_version provider model response_model generation_task_id generation_attempt_id provider_request_id execution_prompt_id execution_prompt_digest execution_prompt_base64 source_product_prompt_digest authorization_ref started_at completed_at actual_cost_fen".split(" "))("rejects missing provenance field %s", key => {
    const e = modelEvent(); delete ((e.result as JsonObject).generation_provenance as JsonObject)[key]; resealModel(e);
    rejected(() => validateDesignEvent(deliver(e), eventPair));
  });
  it("rejects missing whole provenance even when other model labels agree", () => {
    const e = modelEvent(); delete (e.result as JsonObject).generation_provenance; resealModel(e);
    rejected(() => validateDesignEvent(deliver(e), eventPair));
  });
  it("rejects an extra provenance field", () => {
    const e = modelEvent(); ((e.result as JsonObject).generation_provenance as JsonObject).extra = "unsupported"; resealModel(e); rejected(() => validateDesignEvent(deliver(e)));
  });
  it("rejects provenance mismatch against frozen design version", () => {
    const e = modelEvent(); ((e.result as JsonObject).generation_provenance as JsonObject).model = "changed-model";
    rejected(() => validateDesignEvent(deliver(e)), "BINDING_MISMATCH");
  });
  it.each(["wrong_execution_hash", "noncanonical_base64", "invalid_utf8", "empty", "too_long", "url", "photo", "secret"])("rejects invalid/private execution prompt %s", kind => {
    const e = modelEvent(), p = (e.result as JsonObject).generation_provenance as JsonObject;
    if (kind === "wrong_execution_hash") p.execution_prompt_digest = "f".repeat(64);
    else if (kind === "noncanonical_base64") p.execution_prompt_base64 = String(p.execution_prompt_base64) + "\n";
    else {
      const raw = kind === "invalid_utf8" ? Buffer.from([0xc3, 0x28]) : Buffer.from(kind === "empty" ? " " : kind === "too_long" ? "中".repeat(10001) : kind === "url" ? "https://private.example/photo" : kind === "photo" ? "本人照片" : "api_key=synthetic-secret");
      p.execution_prompt_base64 = raw.toString("base64"); p.execution_prompt_digest = sha256(raw);
    }
    resealModel(e); rejected(() => validateDesignEvent(deliver(e)), ["url", "photo", "secret"].includes(kind) ? "PRIVACY_REJECTED" : "INVALID_INPUT");
  });
  it("rejects execution provenance from another product prompt", () => {
    const e = modelEvent(); ((e.result as JsonObject).generation_provenance as JsonObject).source_product_prompt_digest = "f".repeat(64); resealModel(e);
    rejected(() => validateDesignEvent(deliver(e)), "BINDING_MISMATCH");
  });
  it.each([-1, 0.5, true, "0", Number.MAX_SAFE_INTEGER + 1])("rejects invalid actual cost %j", cost => {
    const e = modelEvent(); ((e.result as JsonObject).generation_provenance as JsonObject).actual_cost_fen = cost; resealModel(e);
    rejected(() => validateDesignEvent(deliver(e)));
  });
  it.each(["start_after_end", "end_after_version", "no_timezone"])("rejects generation timeline %s", kind => {
    const e = modelEvent(), p = (e.result as JsonObject).generation_provenance as JsonObject;
    if (kind === "start_after_end") p.started_at = time;
    if (kind === "end_after_version") p.completed_at = "2026-10-10T00:00:01Z";
    if (kind === "no_timezone") p.started_at = "2026-10-09T23:59:58";
    resealModel(e); rejected(() => validateDesignEvent(deliver(e)), kind === "no_timezone" ? "INVALID_INPUT" : "BINDING_MISMATCH");
  });
  it.each(["synthetic_fixture", "authorized_reference"])("rejects model result asset origin %s", origin => {
    const e = modelEvent(); ((e.result as JsonObject).assets as JsonObject[])[0].origin = origin; resealModel(e); rejected(() => validateDesignEvent(deliver(e)));
  });
  it("rejects more than one generated asset", () => {
    const e = modelEvent(), r = e.result as JsonObject; (r.assets as JsonObject[]).push({ ...(r.assets as JsonObject[])[0], asset_id: "second-model-asset" }); resealModel(e); rejected(() => validateDesignEvent(deliver(e)));
  });
  it("preserves old fixture exact fields and refuses provenance added to historical fixture", () => {
    const old = event("design_approved"); expect(() => validateDesignEvent(deliver(old))).not.toThrow();
    (old.result as JsonObject).generation_provenance = (modelEvent().result as JsonObject).generation_provenance;
    rejected(() => validateDesignEvent(deliver(old)));
  });
});

describe("saved dual content and frozen provenance", () => {
  it("accepts exact schema, nullable unknown material, P3 and owned source", () => { const x = saved(); expect(validateSavedContent(x.requirement, x.prompt, x.signal, "staff")).toEqual({ requirement: x.requirement, prompt: x.prompt }); });
  it.each(["requirement", "prompt", "design_spec", "generation", "source_ref"])("rejects unknown %s field", where => {
    const x = saved(); const target = where === "requirement" ? x.requirement : where === "prompt" ? x.prompt : where === "source_ref" ? (x.prompt.source_refs as JsonObject[])[0] : x.prompt[where] as JsonObject;
    target.secret_extension = "must not echo"; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"));
  });
  it.each(["signal_id", "source_payload_digest", "evidence_id", "evidence_revision", "excerpt"])("rejects forged source %s", field => {
    const x = saved(); const ref = (x.prompt.source_refs as JsonObject[])[0];
    ref[field] = field === "evidence_revision" ? 2 : field === "source_payload_digest" ? "d".repeat(64) : "unrelated-source";
    rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PROVENANCE_INCOMPLETE");
  });
  it("requires known author to equal actual actor", () => { const x = saved(); x.prompt.human_additions = [{ field_path: "positive_prompt", text: "完整展示", reason: "展示补充", author_subject: "other-staff" }]; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PROVENANCE_INCOMPLETE"); });
  it("rejects a changed category even with an otherwise valid unrelated source ref", () => { const x = saved(); x.requirement.design_object = "鞋"; (x.prompt.design_spec as JsonObject).category = "鞋"; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PROVENANCE_INCOMPLETE"); });
  it("accepts explicit actor-owned exact-value category addition", () => { const x = saved(); x.requirement.design_object = "鞋"; (x.prompt.design_spec as JsonObject).category = "鞋"; x.prompt.human_additions = [{ field_path: "design_spec.category", text: "鞋", reason: "人工提出另一个设计对象", author_subject: "staff" }]; expect(validateSavedContent(x.requirement, x.prompt, x.signal, "staff")).toBeTruthy(); });
  it("does not use another field addition as category proof", () => { const x = saved(); x.requirement.design_object = "鞋"; (x.prompt.design_spec as JsonObject).category = "鞋"; x.prompt.human_additions = [{ field_path: "design_spec.color", text: "鞋", reason: "无关字段", author_subject: "staff" }]; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PROVENANCE_INCOMPLETE"); });
  it("requires corresponding field_sources even for unchanged source attributes", () => { const x = saved(); ((x.signal.evidence_projection as JsonObject[])[0].field_sources as JsonObject).category = []; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PROVENANCE_INCOMPLETE"); });
  it.each(["season", "scene", "fit", "silhouette", "color"])("requires declared human addition for unsupported %s", field => { const x = saved(); (x.prompt.design_spec as JsonObject)[field] = "人工新值"; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PROVENANCE_INCOMPLETE"); });
  it("accepts actual human addition with reason", () => { const x = saved(); x.prompt.human_additions = [{ field_path: "positive_prompt", text: "完整展示", reason: "展示补充", author_subject: "staff" }]; expect(validateSavedContent(x.requirement, x.prompt, x.signal, "staff")).toBeTruthy(); });
  it("requires string design object and exact spec category", () => { const x = saved(); x.requirement.design_object = { category: "裤装" }; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff")); x.requirement.design_object = "裙装"; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff")); });
  it("refuses material with no source proof", () => { const x = saved(); (x.prompt.design_spec as JsonObject).material = "纯棉"; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PROVENANCE_INCOMPLETE"); });
  it("blocks text model even when its identity is supplied", () => { const x = saved(); (x.prompt.generation as JsonObject).mode = "text_model"; (x.prompt.generation as JsonObject).model = "a-model"; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "CAPABILITY_UNAVAILABLE", 503); });
  it.each(["2026-10-10T00:00:00", "2026-02-30T00:00:00Z", "2026-10-10T24:00:00Z"])("rejects invalid timezone/time %s", time => { const x = saved(); (x.prompt.generation as JsonObject).generated_at = time; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff")); });
  it("requires blocking boolean and paired conflict resolution", () => {
    const x = saved(); x.prompt.conflicts = [{ field_path: "design_spec.fit", source_ref_ids: ["ref-1"], description: "待核对", blocking: "false", resolution: null, resolved_by: null }];
    rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"));
    (x.prompt.conflicts as JsonObject[])[0].blocking = true; (x.prompt.conflicts as JsonObject[])[0].resolution = "已核对";
    rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"));
  });
});

describe("deterministic exported text privacy boundary", () => {
  it.each(["参考 http://private.example/photo", "file:///private/photo.png", "data:image/png;base64,AAAA", "发到 private@example.test", "电话13800138000", "号码138 0013 8000", "身高165cm", "体重50kg", "本人胸围80cm", "身份证110101199001010011", "session_id=raw-session", "user_photo 是原图", "api_key=private-value", "Bearer syntheticSecretTokenThatMustNotLeave", "sk-abcdefghijklmnopqrstuv"])("rejects forbidden free text %j without echo", input => {
    const x = saved(); x.prompt.positive_prompt = input; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PRIVACY_REJECTED");
    try { validateSavedContent(x.requirement, x.prompt, x.signal, "staff"); } catch (error) { expect((error as Error).message).not.toContain(input); }
  });
  it("allows clothing sizes, budget and normal digest/IDs", () => {
    expect(() => assertSafeContent(["服装S/M/L/XL，鞋码35—40，预算500元以内", "服装尺码160/84A", "a13800138000b".padEnd(64, "f"), "EVD-13800138000abc"])).not.toThrow();
  });
  it("checks nested human additions and selected original excerpts", () => { const x = saved(); x.prompt.human_additions = [{ field_path: "positive_prompt", text: "参考图", reason: "https://private.example/user_photo", author_subject: "staff" }]; rejected(() => validateSavedContent(x.requirement, x.prompt, x.signal, "staff"), "PRIVACY_REJECTED"); });
});

describe("approved package preserves source and both frozen originals", () => {
  it("uses original saved bytes, real counts, all-null uncaptured counters and exact provenance", () => {
    const x = approved(); const p = makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1");
    expect(p.package_schema).toBe("pa-design-package/2"); expect(p.sample_count).toEqual({ intent: null, simulated_cart: null, real_purchase: null });
    expect(p.attribution).toEqual({ supply_gap: null, image_gap: null, style_demand: null }); expect(p.evidence_counts).toEqual({ expressions: 5, sessions: 3, unit: "expressions_and_sessions" });
    expect(p.requirement_base64).toBe(x.group.requirement_base64); expect(p.prompt_base64).toBe(x.group.prompt_base64);
    expect(p.provenance).toEqual({ signal_schema: "pa-styling-signal/2", signal_id: x.signal.signal_id, mapping_version: "dh1.4-to-signal2/1", source_payload_digest: "a".repeat(64), source_supplement_digest: "b".repeat(64), source_approval_ref: { approval_record_id: "source-approval-1" }, source_approval_subject: "source-manager", source_approved_at: time, verification_id: "verify-1", verified_at: time, projection_digest: x.signal.projection_digest, provenance_status: "complete" });
    expect(p.source_refs).toEqual(x.prompt.source_refs); expect(p.constraints).toEqual(["不要紧身", "预算500元以内"]);
    expect(p.dedup_key).toBe(sha256(Buffer.from('["styling-new","scope-new","DH-synthetic",1]')));
  });
  it("preserves noncanonical whitespace inside saved prompt", () => { const x = approved(); const raw = Buffer.concat([Buffer.from(x.group.prompt_base64, "base64"), Buffer.from(" \n")]); x.group.prompt_base64 = raw.toString("base64"); x.group.prompt_digest = sha256(raw); x.approval.prompt_digest = x.group.prompt_digest; expect(makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v2").prompt_base64).toBe(x.group.prompt_base64); });
  it.each(["decision_id", "approved_by", "approved_at", "version_group_id", "requirement_digest", "prompt_digest"])("rejects missing approval %s", key => { const x = approved(); delete x.approval[key]; rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1")); });
  it("rejects mismatched immutable group", () => { const x = approved(); x.approval.prompt_digest = "f".repeat(64); rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1"), "BINDING_MISMATCH"); });
  it("rejects altered original bytes with old digest", () => { const x = approved(); x.group.prompt_base64 = Buffer.from("{}").toString("base64"); rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1")); });
  it("rejects incomplete provenance", () => { const x = approved(); x.signal.provenance_status = "incomplete"; rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1"), "PROVENANCE_INCOMPLETE"); });
  it("rejects projection bytes inconsistent with projection object", () => { const x = approved(); x.signal.evidence_projection = []; rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1"), "PROVENANCE_INCOMPLETE"); });
  it("requires original projection bytes, not only a claimed digest", () => { const x = approved(); delete x.signal.projection_base64; rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1")); });
  it("accepts a >2MiB frozen projection while keeping the approved output under 2MiB", () => {
    const x = approved(); const source = x.signal.evidence_projection as JsonObject[];
    for (let i = 0; i < 1200; i++) source.push({ evidence_id: `EVD-size-fixture-${i}`, revision: null, text: "仅用于投影大小边界的合成出处。".repeat(70), field_sources: {}, data_origin: "synthetic" });
    const raw = bytes(source); expect(raw.length).toBeGreaterThan(CONTENT_LIMIT); expect(raw.length).toBeLessThan(16 * 1024 * 1024);
    x.signal.projection_base64 = raw.toString("base64"); x.signal.projection_digest = sha256(raw);
    const pkg = makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1"); expect(bytes(pkg).length).toBeLessThan(CONTENT_LIMIT);
    expect((pkg.provenance as JsonObject).projection_digest).toBe(x.signal.projection_digest); expect(pkg).not.toHaveProperty("evidence_projection");
  });
  it.each(["handoff_id", "revision", "payload_digest", "supplement_id", "supplement_digest", "metadata_digest", "direct_receive_id", "approval_record_id", "verification_id", "verified_at"])("cannot omit source fact %s", key => { const x = approved(); delete (x.signal.source_ref as JsonObject)[key]; rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1")); });
  it.each(["source_product", "signal_revision"])("cannot change source identity %s", key => { const x = approved(); x.signal[key] = key === "signal_revision" ? 2 : "legacy_cms"; rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1"), "BINDING_MISMATCH"); });
  it("rejects blocking unknown at approval", () => { const x = approved(); x.prompt.unknowns = [{ field_path: "design_spec.category", reason: "缺对象", blocking: true }]; const p = freeze(x.prompt); x.group.prompt_base64 = p.base64; x.group.prompt_digest = p.digest; x.approval.prompt_digest = p.digest; rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, "v1"), "PROVENANCE_INCOMPLETE"); });
  it.each(["1", "v0", "v01", "v-1"])("rejects package version %s", v => { const x = approved(); rejected(() => makeApprovedPackage(x.signal, x.group, x.approval, productPair, v)); });
});

describe("design events validate bytes and independent branch bindings", () => {
  it.each(["received", "clarification", "design_approved"] as const)("accepts complete %s branch", kind => { const e = event(kind); const out = validateDesignEvent(deliver(e), eventPair); expect(out.event).toEqual(e); expect(Buffer.from(out.content)).toEqual(bytes(e)); });
  it("accepts changed outer whitespace but preserves inner whitespace", () => { const e = event(); const content = Buffer.concat([bytes(e), Buffer.from(" \n")]); const raw = deliver(e, content); const out = validateDesignEvent(Buffer.concat([Buffer.from(" \n"), raw]), eventPair); expect(Buffer.from(out.content)).toEqual(content); });
  it("rejects unknown outer fields and duplicate keys", () => { const raw = deliver(event()).toString(); rejected(() => validateDesignEvent(Buffer.from(raw.slice(0, -1) + ',"package_id":"wrong"}'))); rejected(() => validateDesignEvent(Buffer.from(raw.slice(0, -1) + ',"event_revision":1}'))); });
  it("rejects unknown schema without legacy fallback", () => { const e = event(); e.event_schema = "pa-design-event/1"; rejected(() => validateDesignEvent(deliver(e)), "UNSUPPORTED_SCHEMA"); });
  it("rejects wrong pair", () => rejected(() => validateDesignEvent(deliver(event()), { ...eventPair, authorized_scope: "other-scope" }), "BINDING_MISMATCH"));
  it("rejects mismatched envelope identity", () => { const outer = JSON.parse(deliver(event()).toString()); outer.event_id = "other"; rejected(() => validateDesignEvent(bytes(outer)), "BINDING_MISMATCH"); });
  it("rejects same-direction received receipt", () => { const e = event(); Object.assign(e.design_receipt as JsonObject, eventPair); rejected(() => validateDesignEvent(deliver(e)), "BINDING_MISMATCH"); });
  it("rejects wrong received receipt hash", () => { const e = event(); (e.design_receipt as JsonObject).content_digest = "f".repeat(64); rejected(() => validateDesignEvent(deliver(e)), "BINDING_MISMATCH"); });
  it("rejects multiple active branches", () => { const e = event(); e.clarification = { decision_id: "fake" }; rejected(() => validateDesignEvent(deliver(e))); });
  it("rejects empty manager clarification reason", () => { const e = event("clarification"); (e.clarification as JsonObject).reason = " "; rejected(() => validateDesignEvent(deliver(e))); });
  it("rejects private event notes and clarification reasons despite correct hashes", () => { const e = event("clarification"); (e.clarification as JsonObject).reason = "参考 file:///private/photo.png"; rejected(() => validateDesignEvent(deliver(e)), "PRIVACY_REJECTED"); });
  it.each(["summary", "task_id", "assignment_id", "design_version_id"])("rejects result/%s mismatch with frozen version", field => { const e = event("design_approved"); (e.result as JsonObject)[field] = "changed"; rejected(() => validateDesignEvent(deliver(e)), "BINDING_MISMATCH"); });
  it("rejects changed result version raw with old digest", () => { const e = event("design_approved"); (e.result as JsonObject).design_version_base64 = Buffer.from("{}").toString("base64"); rejected(() => validateDesignEvent(deliver(e))); });
  it.each(["submission_id", "design_version_id", "design_version_digest"])("rejects review %s not bound to result", key => { const e = event("design_approved"); ((e.result as JsonObject).review as JsonObject)[key] = "f".repeat(64); rejected(() => validateDesignEvent(deliver(e)), "BINDING_MISMATCH"); });
  it("rejects review predating saved result", () => { const e = event("design_approved"); ((e.result as JsonObject).review as JsonObject).approved_at = "2026-10-09T00:00:00Z"; rejected(() => validateDesignEvent(deliver(e)), "BINDING_MISMATCH"); });
  it("rejects incorrect content digest", () => { const outer = JSON.parse(deliver(event()).toString()); outer.content_digest = "0".repeat(64); rejected(() => validateDesignEvent(bytes(outer))); });
  it("rejects nonstandard base64 and noncanonical padding bits", () => { const outer = JSON.parse(deliver(event()).toString()); outer.content_base64 += "\n"; rejected(() => validateDesignEvent(bytes(outer))); outer.content_base64 = "YR=="; outer.content_digest = sha256(Buffer.from("a")); rejected(() => validateDesignEvent(bytes(outer))); });
  it("classifies missing base64 as invalid content rather than oversize", () => { const outer = JSON.parse(deliver(event()).toString()); outer.content_base64 = null; rejected(() => validateDesignEvent(bytes(outer))); });
  it("rejects envelope and decoded content limits", () => { rejected(() => validateDesignEvent(Buffer.alloc(ENVELOPE_LIMIT + 1)), "PAYLOAD_TOO_LARGE", 413); const e = event(); const raw = Buffer.alloc(CONTENT_LIMIT + 1, 32); rejected(() => validateDesignEvent(deliver(e, raw)), "PAYLOAD_TOO_LARGE", 413); });
});

describe("purpose scoped server service authentication", () => {
  const directory = mkdtempSync(join(tmpdir(), "partner-protocol-auth-")); const path = join(directory, "config.json");
  const readerToken = "fixture-reader-token-" + "r".repeat(32), writerToken = "fixture-writer-token-" + "w".repeat(32);
  const config = () => ({ instance_id: "product-new", design_instance_id: "design-new", authorized_scope: "scope-new", origin: "http://127.0.0.1:3091", services: [
    { subject: "design-reader", purpose: "design_package_reader", ...eventPair, token: readerToken },
    { subject: "design-writer", purpose: "design_event_writer", ...eventPair, token: writerToken },
  ] });
  const install = (value: unknown = config()) => { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); chmodSync(path, 0o600); vi.stubEnv("WORKBENCH_CONFIG_FILE", path); };
  const request = (token?: string) => ({ headers: new Headers(token ? { authorization: `Bearer ${token}` } : {}) });
  afterEach(() => vi.unstubAllEnvs()); afterAll(() => rmSync(directory, { recursive: true, force: true }));
  it("returns only safe service identity for both purposes", async () => { install(); const { authorizeService } = await import("@/lib/handoff-auth"); const service = authorizeService(request(readerToken), "design_package_reader"); expect(service).toEqual({ subject: "design-reader", purpose: "design_package_reader", ...eventPair }); expect(JSON.stringify(service)).not.toContain(readerToken); expect(authorizeService(request(writerToken), "design_event_writer").subject).toBe("design-writer"); });
  it("denies unknown token and wrong purpose independently", async () => { install(); const { authorizeService } = await import("@/lib/handoff-auth"); rejected(() => authorizeService(request("secret-not-configured"), "design_package_reader"), "UNAUTHORIZED", 401); rejected(() => authorizeService(request(writerToken), "design_package_reader"), "FORBIDDEN", 403); });
  it("requires bearer and disables legacy shared-key mode", async () => { install(); const { authorizeService, serviceAuthorized } = await import("@/lib/handoff-auth"); rejected(() => authorizeService(request(), "design_package_reader"), "UNAUTHORIZED", 401); vi.stubEnv("DESIGN_HANDOFF_KEY", readerToken); expect(serviceAuthorized({ headers: new Headers({ "x-handoff-key": readerToken }) } as never)).toBe(false); });
  it("requires private config and fails safely with no fallback", async () => { install(); chmodSync(path, 0o644); const { readPartnerConfig } = await import("@/lib/handoff-auth"); rejected(readPartnerConfig, "NOT_CONFIGURED", 503); chmodSync(path, 0o600); vi.stubEnv("WORKBENCH_CONFIG_FILE", ""); rejected(readPartnerConfig, "NOT_CONFIGURED", 503); });
  it("rejects service wrong direction or scope", async () => { const { readPartnerConfig } = await import("@/lib/handoff-auth"); const c = config(); c.services[0].source_instance_id = "product-new"; install(c); rejected(readPartnerConfig, "NOT_CONFIGURED", 503); c.services[0].source_instance_id = "design-new"; c.services[0].authorized_scope = "other"; install(c); rejected(readPartnerConfig, "NOT_CONFIGURED", 503); });
  it("rechecks credential revocation without process restart", async () => { install(); const { authorizeService } = await import("@/lib/handoff-auth"); expect(authorizeService(request(writerToken), "design_event_writer")).toBeTruthy(); const c = config(); c.services.pop(); install(c); rejected(() => authorizeService(request(writerToken), "design_event_writer"), "UNAUTHORIZED", 401); });
  it("allows explicitly unconfigured downstream credentials for local business approval", async () => { install({ ...config(), services: [], backend_url: "http://127.0.0.1:8091", backend_reader_token: "private-internal-fixture" }); const { readPartnerConfig } = await import("@/lib/handoff-auth"); expect(readPartnerConfig().services).toEqual([]); });
  it("rejects duplicated config keys without secret details", async () => { install(); writeFileSync(path, '{"instance_id":"secret-marker","instance_id":"other"}'); const { readPartnerConfig } = await import("@/lib/handoff-auth"); try { readPartnerConfig(); } catch (error) { expect(error).toBeInstanceOf(ProtocolError); expect((error as Error).message).not.toContain("secret-marker"); } });
});
