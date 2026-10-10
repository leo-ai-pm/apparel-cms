// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeFeedback, METHOD, sha, stableJson, validateBatch, validateEvidenceReferences } from "@/lib/reasoning-rules";
import { SAMPLE_BASE64, SAMPLE_DIGEST } from "@/lib/reasoning-sample";
import type { FeedbackBatch, ReasoningGroup, ReasoningResult } from "@/lib/reasoning-types";

// Public synthetic oracle is test-only; server/lib never imports this fixture.
const expected = JSON.parse(readFileSync(new URL("./fixtures/reasoning-expected-v1.json", import.meta.url), "utf8"));
const source = () => validateBatch(Buffer.from(SAMPLE_BASE64, "base64"));
const result = (input = source()) => analyzeFeedback(input);
const group = (r: ReasoningResult, code: string, scene = "commute") => r.groups.find(g => g.reason_code === code && g.scope.scene === scene)!;
const caseIds = (refs: ReasoningGroup["support_refs"]) => [...new Set(refs.map(ref => ref.case_id))].sort();
const semantic = (r: ReasoningResult) => r.groups.map(g => ({ code: g.reason_code, scene: g.scope.scene, size: g.scope.selected_size, support: g.support_refs.map(i => i.quote).sort(), counter: g.counterexample_refs.map(i => i.quote).sort(), opposing: g.opposing_preference_refs.map(i => i.quote).sort(), contextual: g.contextual_refs.map(i => i.quote).sort(), counts: g.counts, stage: g.proposed_action.stage, band: g.proposed_action.order_band, kind: g.proposed_action.action_kind })).sort((a,b) => stableJson(a).localeCompare(stableJson(b)));
function variant(number: number): FeedbackBatch {
  const input = source(), transformation = expected.transformations[number - 1];
  if (transformation.cases) input.items = input.items.filter(i => !transformation.cases.includes(i.case_id));
  if (transformation.operation === "append_feedback") {
    const t = transformation.item, template = input.items.find(i => i.case_id === t.copy_context_from)!;
    input.items.push({ ...structuredClone(template), case_id: t.case_id, source_id: t.source_id, origin_event_id: t.origin_event_id, raw_text: t.raw_text });
  }
  if (transformation.operation === "replace_raw_text") {
    input.items.find(i => i.case_id === transformation.case_id)!.raw_text = transformation.raw_text;
    if (transformation.also_remove_cases) input.items = input.items.filter(i => !transformation.also_remove_cases.includes(i.case_id));
  }
  if (transformation.operation === "append_duplicate_of") input.items.push({ ...structuredClone(input.items.find(i => i.case_id === transformation.copy_entire_feedback_from)!), case_id: transformation.case_id });
  if (transformation.operation === "replace_product_and_context") {
    const item = input.items.find(i => i.case_id === transformation.case_id)!;
    item.product_id = transformation.product_id; item.context_id = transformation.context_id;
  }
  if (transformation.operation === "rename_ids_and_reorder") {
    for (const item of input.items) for (const field of ["case_id", "source_id", "origin_event_id", "product_id", "context_id"] as const) item[field] = `RENAMED-${item[field]}`;
    input.items.reverse(); input.batch_id = "RENAMED-BATCH";
  }
  return input;
}
describe("transparent multi-feedback rules with independent acceptance oracle", () => {
  it("preserves exact original input digest and declared rules, no model", () => { expect(sha(Buffer.from(SAMPLE_BASE64, "base64"))).toBe(SAMPLE_DIGEST); expect(SAMPLE_DIGEST).toBe("1879859fef05354d903a3dce66f3663f513d5d0468ba9a31c2c2b460b8e8804a"); expect(result().method).toEqual(METHOD); expect(METHOD.kind).toBe("transparent_rules"); });
  it("matches the 12/11/11/11 dedup counts and retains duplicate originals", () => { const r = result(); expect(r.counts).toEqual(expected.baseline.counts); expect(r.canonical_feedback.filter(i => i.member_case_ids.length > 1).map(i => i.member_case_ids)).toEqual(expected.baseline.duplicate_sets); });
  it.each(expected.baseline.groups as Record<string, unknown>[])("correct scope, support/counter/opposing/contextual and action $reason_code/$scene", (oracle) => {
    const g = group(result(), String(oracle.reason_code), String(oracle.scene));
    expect(caseIds(g.support_refs)).toEqual(oracle.support_cases); expect(caseIds(g.counterexample_refs)).toEqual(oracle.counterexample_cases); expect(caseIds(g.opposing_preference_refs)).toEqual(oracle.opposing_preference_cases); expect(caseIds(g.contextual_refs)).toEqual(oracle.contextual_cases);
    expect(g.counts.support.unique_source_count).toBe(oracle.support_unique_sources);
    expect(g.proposed_action).toMatchObject({ stage: oracle.proposed_stage, order_band: oracle.order_band, action_kind: oracle.action_kind, design_ready: false });
  });
  it("keeps two causes and budget amounts without assigning forbidden causes", () => {
    const r = result(); expect(r.groups).toHaveLength(6);
    for (const [caseId, causes] of Object.entries(expected.baseline.multiple_causes)) expect(r.canonical_feedback.find(i => i.case_id === caseId)!.reason_codes).toEqual([...(causes as string[])].sort());
    for (const [caseId, forbidden] of Object.entries(expected.baseline.must_not_assign)) for (const cause of forbidden as string[]) expect(r.canonical_feedback.find(i => i.case_id === caseId)!.reason_codes).not.toContain(cause);
    for (const [caseId, amount] of Object.entries(expected.baseline.budget_limits_cny)) expect(r.canonical_feedback.find(i => i.case_id === caseId)!.budget_limit_cny).toBe(amount);
  });
  it("validates all references including facts, inferences and action evidence", () => { const input = source(); for (const g of result(input).groups) validateEvidenceReferences(input, [...g.support_refs, ...g.counterexample_refs, ...g.opposing_preference_refs, ...g.contextual_refs, ...g.facts.flatMap(i => i.evidence_refs), ...g.inferences.flatMap(i => i.evidence_refs), ...g.proposed_action.evidence_refs]); });
  it("rejects forged source, field, canonical representative, quote and occurrence", () => {
    const ref = result().groups[0].support_refs[0];
    for (const change of [{ source_id: "forged" }, { case_id: "forged" }, { canonical_id: "forged" }, { field: "secret" }, { quote: "不存在的原文" }, { occurrence_index: 99 }]) expect(() => validateEvidenceReferences(source(), [{ ...ref, ...change }])).toThrow();
  });
  it("M1 remove duplicate only changes import/duplicate counts, not evidence/actions", () => { const r = result(variant(1)); const counts = Object.fromEntries(Object.entries(expected.transformations[0].expected).filter(([,v]) => typeof v === "number")); expect(r.counts).toMatchObject(counts); expect(semantic(r)).toEqual(semantic(result())); });
  it("M2 new independent positive source increases source counts, not expression count", () => { const r = result(variant(2)); expect(r.counts).toMatchObject({ unique_source_count: 12, canonical_feedback_count: 12, deduplicated_expression_count: 11 }); expect(group(r, "size_waist").counts.counterexample.unique_source_count).toBe(2); expect(group(r, "fit_loose_preference").counts.counterexample.unique_source_count).toBe(2); expect(sha(stableJson(r))).not.toBe(sha(stableJson(result()))); });
  it("M3 removal of opposing preference removes group and changes rationale/action", () => { const r = result(variant(3)), g = group(r, "fit_loose_preference"); expect(group(r, "fit_slim_preference")).toBeUndefined(); expect(g.proposed_action.stage).toBe("clarify_first"); expect(g.counts.opposing_preference.unique_source_count).toBe(0); expect(g.proposed_action.reason).not.toContain("同情境存在相反偏好，两方向共存"); });
  it("M4 same ID changed text replaces unknown with budget", () => { const r = result(variant(4)); expect(group(r, "unresolved")).toBeUndefined(); expect(group(r, "budget_limit").counts.support.unique_source_count).toBe(3); expect(r.canonical_feedback.find(i => i.case_id === "PMR-CASE-09")!.budget_limit_cny).toBe(220); });
  it("M5 same source new event counts another event, never another source", () => { const r = result(variant(5)); expect(r.counts).toMatchObject({ raw_record_count: 13, canonical_feedback_count: 12, deduplicated_expression_count: 12, unique_source_count: 11 }); expect(group(r, "size_waist").counts.support).toEqual({ canonical_feedback_count: 4, unique_source_count: 3 }); });
  it("M6 identity renaming/reorder preserves semantic analysis", () => { expect(semantic(result(variant(6)))).toEqual(semantic(result())); expect(result(variant(6)).counts).toEqual(result().counts); });
  it("M7 positive/negation retains full phrase and never creates size/loose complaint", () => { const r = result(variant(7)), changed = r.canonical_feedback.find(i => i.case_id === "PMR-CASE-01")!; expect(changed.reason_codes).not.toContain("size_waist"); expect(changed.reason_codes).not.toContain("fit_loose_preference"); expect(changed.negated_quotes.join("")).toContain("不喜欢宽松裤腿"); });
  it("M8 extra same-event duplicate only changes import count", () => { const r = result(variant(8)); expect(r.counts).toMatchObject({ raw_record_count: 13, canonical_feedback_count: 11, deduplicated_expression_count: 11, unique_source_count: 11, duplicate_record_count: 2 }); expect(semantic(r)).toEqual(semantic(result())); });
  it.each([9, 10])("M%s deleted/moved counterexample no longer counts against original scope", n => { const r = result(variant(n)), g = group(r, "size_waist"); expect(g.counts.counterexample.unique_source_count).toBe(0); expect(group(r, "fit_loose_preference").counts.counterexample.unique_source_count).toBe(0); expect(g.evidence_balance.reason).toContain("未有同情境直接反例"); expect(caseIds(g.support_refs)).toEqual(caseIds(group(result(), "size_waist").support_refs)); expect(r.groups.every(i => i.proposed_action.design_ready === false)).toBe(true); });
  it.each(["腰围不合适。", "腰围并不太紧，不喜欢宽松裤腿，不希望加宽。", "版型不是本次问题，售价399元超预算。"])("handles supported localized negation without broad language claim: %s", raw_text => { const b = source(); b.items = [{ ...b.items[0], raw_text }]; const r = result(b); expect(r.canonical_feedback[0].reason_codes).not.toContain("fit_loose_preference"); if (raw_text !== "腰围不合适。") expect(r.canonical_feedback[0].reason_codes).not.toContain("size_waist"); expect(r.canonical_feedback[0].positive_codes).not.toContain("size_positive"); });
  it.each(["腰围不勒，不需要放大。", "腰围不是太紧", "腰围不合适。"])("R1 independent review negation: %s", raw_text => { const b = source(); b.items = [{ ...b.items[0], raw_text }]; const r = result(b); expect(r.canonical_feedback[0].reason_codes).not.toContain("size_waist"); if (raw_text === "腰围不合适。") expect(r.canonical_feedback[0].positive_codes).not.toContain("size_positive"); if (raw_text.startsWith("腰围不勒")) expect(r.canonical_feedback[0].positive_codes).toContain("size_positive"); });
  it("rejects conflicting context/event and unknown fields", () => { const b = source(); b.items[1].raw_text = "改变同事件原文"; expect(() => result(b)).toThrow("同一原反馈事件"); const c = source(); c.items[1].context.scene = "different"; expect(() => result(c)).toThrow("同一反馈情境"); expect(() => validateBatch(Buffer.from(JSON.stringify({ ...source(), answer: "prewritten" })))).toThrow(); });
});
