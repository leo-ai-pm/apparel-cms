import { createHash } from "node:crypto";
import { parseStrictJson } from "./partner-protocol";
import type { CanonicalFeedback, EvidenceRef, FeedbackBatch, FeedbackItem, ReasonCode, ReasoningGroup, ReasoningResult, RuleMethod } from "./reasoning-types";
export class ReasoningError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); }
}
export const sha = (raw: string | Uint8Array) => createHash("sha256").update(raw).digest("hex");
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function ensure(value: unknown, code = "INVALID_INPUT", status = 422, message = "字段不符合研判测试契约"): asserts value {
  if (!value) throw new ReasoningError(code, message, status);
}
export function shape(value: unknown, fields: string): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value));
  const object = value as Record<string, unknown>, keys = fields.split(" ");
  ensure(Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key)));
  return object;
}
export function text(value: unknown, max = 180): string { ensure(typeof value === "string" && value.trim().length && value.length <= max); return value; }
export function id(value: unknown): string { const result = text(value); ensure(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)); return result; }
export function natural(value: unknown, min = 0): number { ensure(Number.isSafeInteger(value) && Number(value) >= min); return Number(value); }
export function validateBatch(raw: Uint8Array): FeedbackBatch {
  const b = shape(parseStrictJson(raw, 1024 * 1024), "schema_version batch_id input_revision test_data purpose origin source_identity_basis items");
  ensure(b.schema_version === "pa-feedback-batch/1" && b.test_data === true);
  id(b.batch_id); natural(b.input_revision, 1);
  for (const key of ["purpose", "origin", "source_identity_basis"]) text(b[key], 1000);
  ensure(Array.isArray(b.items) && b.items.length > 0 && b.items.length <= 200);
  const cases = new Set<string>(), contexts = new Map<string, string>(), events = new Map<string, string>();
  for (const entry of b.items) {
    const i = shape(entry, "case_id source_id origin_event_id product_id context_id context raw_text test_data source_kind");
    for (const key of ["case_id", "source_id", "origin_event_id", "product_id", "context_id"]) id(i[key]);
    ensure(!cases.has(String(i.case_id))); cases.add(String(i.case_id));
    text(i.raw_text, 4000); ensure(i.test_data === true && i.source_kind === "synthetic_test_feedback");
    const c = shape(i.context, "scene variant selected_size listed_price_cny currency");
    for (const key of ["scene", "variant", "selected_size"]) text(c[key], 80);
    ensure(c.currency === "CNY" && typeof c.listed_price_cny === "number" && Number.isFinite(c.listed_price_cny) && c.listed_price_cny >= 0 && c.listed_price_cny <= 1e8);
    const context = stableJson(c), event = stableJson([i.source_id, i.product_id, i.context_id, c, i.raw_text]);
    ensure(!contexts.has(String(i.context_id)) || contexts.get(String(i.context_id)) === context, "CONTEXT_CONFLICT", 422, "同一反馈情境标识对应不同内容，请核对测试资料");
    ensure(!events.has(String(i.origin_event_id)) || events.get(String(i.origin_event_id)) === event, "ORIGIN_EVENT_CONFLICT", 422, "同一原反馈事件出现不同来源或原文，请保留资料并核对");
    contexts.set(String(i.context_id), context); events.set(String(i.origin_event_id), event);
  }
  return b as unknown as FeedbackBatch;
}
// These are general lexical rules. No batch, source, case, product or context identity is a rule input.
const patterns = {
  size: /(?:腰围|腰部|腰).{0,4}(?:太紧|偏紧|很紧|勒腰|勒)|勒腰/gu,
  loose: /(?:喜欢|想穿|想要|希望|需要|偏好).{0,6}(?:宽松|更宽|加宽)|(?:裤腿|这条).{0,5}(?:太贴身|太窄)|(?:希望|想).{0,4}裤腿.{0,6}(?:宽|松)/gu,
  slim: /(?:喜欢|想穿|想要|希望|需要|偏好).{0,6}(?:修身|更窄|收窄)|裤腿.{0,4}太宽/gu,
  budget: /超(?:出)?(?:我的)?预算|预算不足|太贵|价格太高|买不起|最多(?:只)?(?:花|付|支付)\s*\d+(?:\.\d+)?\s*元/gu,
  sizePositive: /(?:腰围|腰部)(?:很|正|挺|都|比较)?(?:合适|正好|刚好|不紧|不勒)/gu,
  fitPositive: /裤腿(?:的|很|都)?(?:宽窄正好|正合适|刚好|正好)|版型(?:正好|合适)/gu,
};
const ruleNotes = [
  "先按source_id+origin_event_id去重复导入，再按商品/颜色/场景/原因分组；尺寸另含尺码、偏好含方向。",
  "在完整局部语句中匹配腰围紧/勒、宽松与修身偏好、超预算或最多花金额；各原因独立，多原因不增加来源人数。",
  "先识别局部否定和正面表达。匹配前的否定词及版型不是本次问题阻止对应诉求；完整语句原样引用。",
  "腰围合适与裤腿正好另作正面证据；反例限定同商品/颜色/场景，尺寸再限定尺码。跨场景/尺码仅参考，跨商品不直接反驳。",
  "相反偏好并列分段验证；缺相反偏好则先补问。尺码/预算先可逆核对；缺原因保持未知，不按票数造P0。",
];
const ruleLimitations = ["规则只覆盖上述中文明确表达和局部否定，不理解任意自然语言因果、复杂转述或讽刺。", "原话是自述，商品情境为合成设定，不能证明真实尺寸、市场需求、成交或收益。", "未提供会话标识，session_count=null；技术来源未经自然人核验。", "其他商品不作为本商品直接证据；未识别原文保留并需人工补问。"];
export const METHOD: RuleMethod = { kind: "transparent_rules", version: "pmr-rules/1", rules_digest: sha(stableJson({ patterns: Object.fromEntries(Object.entries(patterns).map(([key, value]) => [key, value.source])), ruleNotes, ruleLimitations })), rules: ruleNotes, limitations: ruleLimitations };
type Interpretation = { reasons: Map<ReasonCode, string[]>; positives: Map<string, string[]>; negated: string[]; budget: number | null };
function interpret(raw: string): Interpretation {
  const out: Interpretation = { reasons: new Map(), positives: new Map(), negated: [], budget: null };
  const sentences = raw.match(/[^。！？；;\n]+[。！？；;\n]?/gu) ?? [raw];
  const add = (map: Map<string, string[]>, key: string, sentence: string) => map.set(key, [...new Set([...(map.get(key) ?? []), sentence])]);
  for (const sentence of sentences) {
    const hit = (pattern: RegExp, fit = false) => {
      const matches = [...sentence.matchAll(new RegExp(pattern.source, "gu"))];
      return matches.some(match => {
        const before = sentence.slice(0, match.index).split(/[，,]/u).at(-1)?.slice(-12) ?? "";
        const internalNegation = pattern !== patterns.sizePositive && pattern !== patterns.fitPositive
          && /(?:不|没|并非|不是)(?:太|很|再|更)?(?:紧|勒|太紧|偏紧|宽松|加宽|收窄|修身|太窄|太宽|超预算)/u.test(match[0]);
        const negated = internalNegation || /(?:不|没|并非|不是|无需|不用|不要|拒绝)(?:太|很|再|更|需要|希望|喜欢|想|要|觉得|认为|存在){0,3}$/u.test(before)
          || (fit && /版型.{0,3}(?:不是|并非|不算).{0,8}(?:问题|原因)/u.test(sentence));
        if (negated) { if (!out.negated.includes(sentence)) out.negated.push(sentence); return false; }
        return true;
      });
    };
    if (hit(patterns.size)) add(out.reasons, "size_waist", sentence);
    if (hit(patterns.loose, true)) add(out.reasons, "fit_loose_preference", sentence);
    if (hit(patterns.slim, true)) add(out.reasons, "fit_slim_preference", sentence);
    if (hit(patterns.budget)) add(out.reasons, "budget_limit", sentence);
    if (hit(patterns.sizePositive)) add(out.positives, "size_positive", sentence);
    if (hit(patterns.fitPositive)) add(out.positives, "fit_positive", sentence);
    if (/(?:不希望|不需要|不喜欢|无需|不是这次|不是本次)/u.test(sentence) && !out.negated.includes(sentence)) out.negated.push(sentence);
    const amount = sentence.match(/(?:最多(?:只)?(?:花|付|支付)|预算(?:上限|只有|为|是))\s*(\d+(?:\.\d+)?)\s*元/u);
    if (amount) out.budget = Number(amount[1]);
  }
  if (!out.reasons.size && !out.positives.size) out.reasons.set("unresolved", [raw]);
  return out;
}
function canonicalize(batch: FeedbackBatch): CanonicalFeedback[] {
  const groups = new Map<string, FeedbackItem[]>();
  for (const item of batch.items) { const key = stableJson([item.source_id, item.origin_event_id]); groups.set(key, [...(groups.get(key) ?? []), item]); }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]) => {
    members.sort((a, b) => a.case_id.localeCompare(b.case_id)); const item = members[0], parsed = interpret(item.raw_text);
    return { ...item, canonical_id: `PMRC-${sha(key)}`, representative_case_id: item.case_id, member_case_ids: members.map(i => i.case_id), reason_codes: [...parsed.reasons.keys()].sort(), positive_codes: [...parsed.positives.keys()].sort(), negated_quotes: parsed.negated, budget_limit_cny: parsed.budget, duplicate_reason: members.length > 1 ? "相同虚构来源与原反馈事件重复导入；保留全部记录，不重复计入原事件/来源" : null };
  });
}
function reference(item: CanonicalFeedback, quote: string): EvidenceRef { return { canonical_id: item.canonical_id, case_id: item.case_id, source_id: item.source_id, field: "raw_text", quote, occurrence_index: 1 }; }
function refs(items: CanonicalFeedback[], code: string, positive = false): EvidenceRef[] {
  return items.flatMap(item => { const parsed = interpret(item.raw_text); return ((positive ? parsed.positives : parsed.reasons).get(code as ReasonCode) ?? []).map(quote => reference(item, quote)); });
}
function count(evidence: EvidenceRef[]) { return { canonical_feedback_count: new Set(evidence.map(r => r.canonical_id)).size, unique_source_count: new Set(evidence.map(r => r.source_id)).size }; }
export function validateEvidenceReferences(batch: FeedbackBatch, evidence: EvidenceRef[]): void {
  const canonical = new Map(canonicalize(batch).map(i => [i.canonical_id, i]));
  for (const ref of evidence) {
    shape(ref, "canonical_id case_id source_id field quote occurrence_index");
    const item = canonical.get(ref.canonical_id);
    ensure(item && ref.case_id === item.case_id && ref.source_id === item.source_id, "REFERENCE_INVALID");
    ensure(ref.field === "raw_text" || /^context\.(scene|variant|selected_size|listed_price_cny|currency)$/.test(ref.field), "REFERENCE_INVALID");
    const value = ref.field === "raw_text" ? item.raw_text : String(item.context[ref.field.slice(8) as keyof typeof item.context]);
    ensure(typeof ref.quote === "string" && ref.quote.length && Number.isSafeInteger(ref.occurrence_index) && ref.occurrence_index >= 1, "REFERENCE_INVALID");
    let from = 0, found = -1;
    for (let n = 0; n < ref.occurrence_index; n++) { found = value.indexOf(ref.quote, from); if (found < 0) break; from = found + ref.quote.length; }
    ensure(found >= 0, "REFERENCE_INVALID", 422, "证据片段不属于本版冻结输入");
  }
}
const titles: Record<ReasonCode, string> = { size_waist: "腰围自述问题", fit_loose_preference: "宽松裤腿偏好", fit_slim_preference: "修身裤腿偏好", budget_limit: "预算限制", unresolved: "原因未明确" };
export function analyzeFeedback(batch: FeedbackBatch): ReasoningResult {
  // Validate callers too; the analyzer never reads files, expectations, models or old business databases.
  validateBatch(Buffer.from(JSON.stringify(batch)));
  const canonical = canonicalize(batch), grouped = new Map<string, { code: ReasonCode; items: CanonicalFeedback[] }>();
  for (const item of canonical) for (const code of item.reason_codes) {
    const key = stableJson([item.product_id, item.context.variant, item.context.scene, code, code === "size_waist" ? item.context.selected_size : null]);
    const previous = grouped.get(key); grouped.set(key, { code, items: [...(previous?.items ?? []), item] });
  }
  const groups: ReasoningGroup[] = [...grouped.entries()].map(([key, { code, items }]) => {
    const first = items[0], c = first.context, sameProduct = (i: CanonicalFeedback) => i.product_id === first.product_id && i.context.variant === c.variant;
    const sameScope = (i: CanonicalFeedback) => sameProduct(i) && i.context.scene === c.scene && (code !== "size_waist" || i.context.selected_size === c.selected_size);
    const positiveCode = code === "size_waist" ? "size_positive" : code.startsWith("fit_") ? "fit_positive" : null;
    const oppositeCode = code === "fit_loose_preference" ? "fit_slim_preference" : code === "fit_slim_preference" ? "fit_loose_preference" : null;
    const positive = positiveCode ? canonical.filter(i => sameScope(i) && i.positive_codes.includes(positiveCode)) : [];
    const opposite = oppositeCode ? canonical.filter(i => sameScope(i) && i.reason_codes.includes(oppositeCode)) : [];
    const contextual = canonical.filter(i => sameProduct(i) && !sameScope(i) && (i.reason_codes.includes(code) || code === "size_waist" && i.positive_codes.includes("size_positive")));
    const support_refs = refs(items, code), counterexample_refs = positiveCode ? refs(positive, positiveCode, true) : [], opposing_preference_refs = oppositeCode ? refs(opposite, oppositeCode) : [];
    const contextual_refs = contextual.flatMap(i => i.reason_codes.includes(code) ? refs([i], code) : positiveCode ? refs([i], positiveCode, true) : []);
    const counts = { support: count(support_refs), counterexample: count(counterexample_refs), opposing_preference: count(opposing_preference_refs), contextual: count(contextual_refs) };
    const unknowns = code === "size_waist" ? ["真实成衣/人体尺寸未提供", "是否选对尺码尚未核对"] : code === "budget_limit" ? ["预算内商品是否可售未核验", "价格条件和套装取舍需补问"] : code === "unresolved" ? ["模糊反馈原因未说明，不能默认尺码/版型/预算"] : ["偏好分段与版型参照未提供", "真实穿着尺寸及偏好人群分布未验证"];
    const evidenceReason = `${counts.support.unique_source_count}个虚构来源自述支持，${counts.counterexample.unique_source_count}个同情境正面反例，${counts.opposing_preference.unique_source_count}个相反偏好来源，${counts.contextual.unique_source_count}个跨情境参考来源。${counterexample_refs.length ? "反例限定适用情境，不否认其他反馈经历。" : "未有同情境直接反例，不等于普遍需求成立。"}跨商品资料不直接适用，各角色来源数不能相加当人数。`;
    const stage = code === "size_waist" || code === "budget_limit" ? "verify_information" : opposite.length ? "segmented_validation" : "clarify_first";
    const action_kind = code === "size_waist" ? "size_information_check" : code === "budget_limit" ? "budget_product_matching" : opposite.length ? "preference_segment_validation" : "clarifying_question";
    const actionReason = (code === "size_waist" ? "原因自述明确，先核对尺码说明/实测和选择条件，不能直接统一放大。" : code === "budget_limit" ? "预算为各自限制，先询问并匹配预算内商品或套装，不推断应降价或可实现成本。" : opposite.length ? "同情境存在相反偏好，两方向共存，先补偏好分段与版型参照，不以多数票淘汰少数。" : code === "unresolved" ? "没有明确原因，先询问不合适具体指什么。" : "尚缺同情境双向偏好证据，先补分段/参照或单源访谈，不保留不存在的双向设计验证理由。") + evidenceReason;
    const group: ReasoningGroup = {
      group_id: `PMRG-${sha(key)}`, reason_code: code, title: `${titles[code]} · ${c.scene}${code === "size_waist" ? ` · ${c.selected_size}` : ""}`,
      scope: { product_id: first.product_id, variant: c.variant, scene: c.scene, selected_size: code === "size_waist" ? c.selected_size : null, preference: code === "fit_loose_preference" ? "loose" : code === "fit_slim_preference" ? "slim" : null },
      support_refs, counterexample_refs, opposing_preference_refs, contextual_refs, counts,
      facts: support_refs.map(r => ({ kind: "self_report", text: `反馈者原话：${r.quote}`, evidence_refs: [r] })),
      inferences: [{ kind: code === "unresolved" ? "unknown" : "inferred", text: `${titles[code]}为规则辅助归类，非实际商品诊断。${evidenceReason}`, evidence_refs: [...support_refs, ...counterexample_refs, ...opposing_preference_refs] }],
      unknowns,
      grouping_explanation: `按商品${first.product_id}、颜色${c.variant}、场景${c.scene}${code === "size_waist" ? `、尺码${c.selected_size}` : ""}与${titles[code]}归组。同因异句保留每条原文；同句不同原因分别归组，多原因可同时引用但不新增来源。重复导入成员保留而不加权，跨场景/尺码参考及其他商品不能变成本组直接证据。`,
      evidence_balance: { kind: code === "unresolved" ? "insufficient" : opposite.length ? "opposing_preferences" : positive.length ? "mixed" : counts.support.unique_source_count >= 2 ? "corroborated_self_report" : "single_source", reason: evidenceReason },
      proposed_action: { stage, order_band: stage === "verify_information" ? 1 : stage === "segmented_validation" ? 2 : 3, action_kind, reason: actionReason, evidence_refs: [...support_refs, ...counterexample_refs, ...opposing_preference_refs], unknowns,
        change_conditions: ["补充真实尺寸/商品条件或偏好分段后重新核对；输入变化必须保存新版本", "新的同情境支持、反例或相反偏好会改变证据平衡和下一步"],
        alternative_considered: code === "size_waist" ? "立即改版放大需要真实尺寸与选码证据，先信息核对更可逆。" : code === "budget_limit" ? "直接降价或新产品设计缺成本与可售证据，先预算商品匹配。" : "立即确定唯一版型方向缺偏好分段/参照，先核对和补问，不能把来源票数当设计批准。", design_ready: false },
    };
    validateEvidenceReferences(batch, [...support_refs, ...counterexample_refs, ...opposing_preference_refs, ...contextual_refs]);
    return group;
  }).sort((a, b) => a.proposed_action.order_band - b.proposed_action.order_band || a.group_id.localeCompare(b.group_id));
  return { test_data: true, review_scope: "test_reasoning_only", method: METHOD,
    counts: { raw_record_count: batch.items.length, canonical_feedback_count: canonical.length, deduplicated_expression_count: new Set(canonical.map(i => sha(JSON.stringify({ product_id: i.product_id, context_id: i.context_id, raw_text: i.raw_text })))).size, unique_source_count: new Set(canonical.map(i => i.source_id)).size, duplicate_record_count: batch.items.length - canonical.length, session_count: null },
    counting_explanation: ["导入记录含重复；原事件按source_id+origin_event_id精确去重。", "去重表达使用UTF-8紧凑JSON {product_id,context_id,raw_text} 的SHA256，不做模糊语义判重。", "来源数仅是虚构source_id数量，同源新事件不增加来源；不同来源同原话不去重。", "会话未提供，session_count=null；分组及各证据角色可能重叠，不相加当人数。"],
    canonical_feedback: canonical, groups, limitations: ruleLimitations };
}
