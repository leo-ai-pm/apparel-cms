import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;
export type PartnerPair = { source_instance_id: string; target_instance_id: string; authorized_scope: string };
export type SavedGroup = {
  version_group_id: string; requirement_version: number; prompt_version: number;
  requirement_digest: string; requirement_base64: string; prompt_digest: string; prompt_base64: string;
};
export const CONTENT_LIMIT = 2 * 1024 * 1024;
export const ENVELOPE_LIMIT = 3 * 1024 * 1024;
const PROJECTION_LIMIT = 16 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(public code: string, public status: number, message = "请求内容或绑定不符合交接契约") {
    super(message); this.name = "ProtocolError";
  }
}
function fail(code = "INVALID_INPUT", status = 422): never { throw new ProtocolError(code, status); }
function ensure(condition: unknown, code = "INVALID_INPUT", status = 422): asserts condition { if (!condition) fail(code, status); }

/** Parses bytes without accepting duplicate decoded keys, non-finite numbers or replacement UTF-8. */
export function parseStrictJson(raw: Uint8Array, maxBytes = ENVELOPE_LIMIT): unknown {
  ensure(raw.byteLength <= maxBytes, "PAYLOAD_TOO_LARGE", 413);
  let input: string;
  try { input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { fail(); }
  let at = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(input[at] ?? "\0")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < input.length) {
      const c = input[at++];
      if (c === '"') {
        try { return JSON.parse(input.slice(start, at)) as string; } catch { fail(); }
      }
      if (c === "\\") at++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    ensure(depth <= 64); whitespace();
    const c = input[at];
    if (c === '"') return string();
    if (c === "{") {
      at++; whitespace(); const out: JsonObject = {}; const keys = new Set<string>();
      if (input[at] === "}") { at++; return out; }
      while (at < input.length) {
        whitespace(); ensure(input[at] === '"'); const key = string(); ensure(!keys.has(key)); keys.add(key);
        whitespace(); ensure(input[at++] === ":");
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        whitespace(); const end = input[at++]; if (end === "}") return out; ensure(end === ",");
      }
      return fail();
    }
    if (c === "[") {
      at++; whitespace(); const out: unknown[] = [];
      if (input[at] === "]") { at++; return out; }
      while (at < input.length) {
        out.push(value(depth + 1)); whitespace(); const end = input[at++];
        if (end === "]") return out; ensure(end === ",");
      }
      return fail();
    }
    for (const [literal, decoded] of [["true", true], ["false", false], ["null", null]] as const) {
      if (input.startsWith(literal, at)) { at += literal.length; return decoded; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(at));
    ensure(number); at += number[0].length; const decoded = Number(number[0]);
    ensure(Number.isFinite(decoded) && (!Number.isInteger(decoded) || Number.isSafeInteger(decoded)));
    return decoded;
  };
  const result = value(0); whitespace(); ensure(at === input.length); return result;
}

export function object(value: unknown): JsonObject {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value)); return value as JsonObject;
}
function shape(value: unknown, fields: string): JsonObject {
  const obj = object(value); const keys = fields.split(" ");
  ensure(Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key))); return obj;
}
function text(value: unknown, max = 10000, empty = false): string {
  ensure(typeof value === "string" && value.length <= max && (empty || value.trim().length > 0));
  ensure(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)); return value;
}
function id(value: unknown): string { return text(value, 180); }
function digest(value: unknown): string { ensure(typeof value === "string" && /^[a-f0-9]{64}$/.test(value)); return value; }
function integer(value: unknown, min = 1): number { ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= min); return value; }
function list(value: unknown): unknown[] { ensure(Array.isArray(value) && value.length <= 10000); return value; }
function strings(value: unknown): string[] { return list(value).map(item => text(item)); }
function nullableText(value: unknown): void { if (value !== null) text(value); }
function timestamp(value: unknown): string {
  const s = text(value, 80); const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(s);
  ensure(match && Number.isFinite(Date.parse(s)));
  const [, y, m, d, h, minute, sec] = match;
  ensure(+m >= 1 && +m <= 12 && +d >= 1 && +d <= new Date(Date.UTC(+y, +m, 0)).getUTCDate() && +h < 24 && +minute < 60 && +sec < 60);
  return s;
}
function choice(value: unknown, allowed: string[]): string { ensure(typeof value === "string" && allowed.includes(value)); return value; }
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as JsonObject, right = b as JsonObject;
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
  }
  return false;
}
export function sha256(raw: Uint8Array): string { return createHash("sha256").update(raw).digest("hex"); }
function decoded(value: unknown, expected: unknown, maxBytes = CONTENT_LIMIT): Uint8Array {
  ensure(typeof value === "string");
  ensure(value.length <= 4 * Math.ceil(maxBytes / 3), "PAYLOAD_TOO_LARGE", 413);
  // Avoid repeated regexp groups: large valid base64 can exhaust V8's regexp stack.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  ensure(value.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding)));
  const raw = Buffer.from(value, "base64"); ensure(raw.byteLength <= maxBytes, "PAYLOAD_TOO_LARGE", 413);
  ensure(raw.toString("base64") === value && sha256(raw) === digest(expected)); return raw;
}
function pairFields(value: JsonObject, pair?: PartnerPair): void {
  for (const key of ["source_instance_id", "target_instance_id", "authorized_scope"] as const) {
    id(value[key]); if (pair) ensure(value[key] === pair[key], "BINDING_MISMATCH");
  }
}
function packageVersion(value: unknown): string { const s = text(value, 180); ensure(/^v[1-9][0-9]*$/.test(s)); return s; }

/** Deterministic rejection only: this is not a claim of complete semantic anonymization. */
export function assertSafeContent(value: unknown): void {
  if (typeof value === "string") {
    if (/^[a-f0-9]{64}$/.test(value) || /^(?:SIG-DH|EVD|DH|PKG-WB|VG|ASSIGN|SUB|DEC)-[A-Za-z0-9-]+$/.test(value)) return;
    const unsafe = /(?:\b(?:https?|file|data):|[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|身高|体重|胸围|腰围|臀围|身份证|手机号|电话号码|(?:session[_ -]?id|user[_ -]?photo|photo_base64|body_type_tag|raw_photo)|本人照片|消费者照片|个人照片)/i;
    const phone = /(?<!\d)(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?!\d)/;
    const identity = /(?<![A-Za-z0-9])[1-9]\d{16}[\dXx](?![A-Za-z0-9])/;
    const credential = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:api[_ -]?key|access[_ -]?token|password|secret|authorization|cookie)\s*[:=]\s*\S+|\b(?:sk-|AIza)[A-Za-z0-9_-]{16,})/i;
    ensure(!unsafe.test(value) && !phone.test(value) && !identity.test(value) && !credential.test(value), "PRIVACY_REJECTED");
  } else if (Array.isArray(value)) value.forEach(assertSafeContent);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { assertSafeContent(key); assertSafeContent(item); }
  }
}

function validateContent(requirement: unknown, prompt: unknown): { requirement: JsonObject; prompt: JsonObject } {
  assertSafeContent(requirement); assertSafeContent(prompt);
  const r = shape(requirement, "title requirement_desc design_object constraints priority_proposal priority_reason");
  text(r.title, 500, true); text(r.requirement_desc, 10000, true); id(r.design_object); strings(r.constraints);
  choice(r.priority_proposal, ["P0", "P1", "P2", "P3"]); text(r.priority_reason, 10000, true);
  const p = shape(prompt, "positive_prompt avoid_items design_spec generation source_refs human_additions unknowns conflicts");
  text(p.positive_prompt); strings(p.avoid_items);
  const spec = shape(p.design_spec, "category season scene fit silhouette color material craft knowledge_status display_requirements");
  ensure(id(spec.category) === r.design_object);
  for (const key of ["season", "scene", "fit", "silhouette", "color", "material", "craft"]) nullableText(spec[key]);
  ensure(spec.knowledge_status === "pending_database");
  for (const entry of list(spec.display_requirements)) {
    const d = shape(entry, "id text origin template_version"); id(d.id); text(d.text);
    choice(d.origin, ["display_template", "human_authored"]);
    if (d.origin === "display_template") id(d.template_version); else ensure(d.template_version === null);
  }
  const generation = shape(p.generation, "mode template_version model generated_at derived_from");
  choice(generation.mode, ["human_authored", "offline_template", "text_model"]);
  ensure(generation.mode !== "text_model", "CAPABILITY_UNAVAILABLE", 503);
  ensure(generation.model === null); nullableText(generation.template_version);
  if (generation.mode === "offline_template") id(generation.template_version);
  timestamp(generation.generated_at);
  if (generation.derived_from !== null) {
    const d = shape(generation.derived_from, "kind id prompt_digest"); choice(d.kind, ["candidate", "saved_prompt"]); id(d.id); digest(d.prompt_digest);
  }
  const refIds = new Set<string>();
  for (const entry of list(p.source_refs)) {
    const ref = shape(entry, "source_ref_id signal_id source_payload_digest evidence_id evidence_revision field_path excerpt");
    const refId = id(ref.source_ref_id); ensure(!refIds.has(refId)); refIds.add(refId);
    id(ref.signal_id); digest(ref.source_payload_digest); id(ref.evidence_id);
    if (ref.evidence_revision !== null) integer(ref.evidence_revision);
    text(ref.field_path, 500); text(ref.excerpt, 4000);
  }
  for (const entry of list(p.human_additions)) {
    const h = shape(entry, "field_path text reason author_subject"); text(h.field_path, 500); text(h.text); text(h.reason); id(h.author_subject);
  }
  for (const entry of list(p.unknowns)) {
    const u = shape(entry, "field_path reason blocking"); text(u.field_path, 500); text(u.reason); ensure(typeof u.blocking === "boolean");
  }
  for (const entry of list(p.conflicts)) {
    const c = shape(entry, "field_path source_ref_ids description blocking resolution resolved_by"); text(c.field_path, 500); text(c.description);
    strings(c.source_ref_ids).forEach(refId => ensure(refIds.has(refId))); ensure(typeof c.blocking === "boolean");
    nullableText(c.resolution); nullableText(c.resolved_by); ensure((c.resolution === null) === (c.resolved_by === null));
  }
  return { requirement: r, prompt: p };
}

/** Caller supplies the assignment's frozen server projection, never a browser supplied signal. */
export function validateSavedContent(requirement: unknown, prompt: unknown, signal: JsonObject, actor: string): { requirement: JsonObject; prompt: JsonObject } {
  const out = validateContent(requirement, prompt); id(actor);
  const source = object(signal.source_ref); const evidence = list(signal.evidence_projection).map(object);
  evidence.forEach(e => assertSafeContent(e.text));
  for (const entry of list(out.prompt.source_refs)) {
    const ref = object(entry); const authorized = evidence.find(e => e.evidence_id === ref.evidence_id);
    ensure(ref.signal_id === signal.signal_id && ref.source_payload_digest === source.payload_digest && authorized && authorized.revision === ref.evidence_revision, "PROVENANCE_INCOMPLETE");
    ensure(typeof authorized.text === "string" && authorized.text.includes(ref.excerpt as string), "PROVENANCE_INCOMPLETE");
  }
  for (const entry of list(out.prompt.human_additions)) ensure(object(entry).author_subject === actor, "PROVENANCE_INCOMPLETE");
  for (const entry of list(out.prompt.conflicts)) {
    const conflict = object(entry); if (conflict.resolved_by !== null) ensure(conflict.resolved_by === actor, "PROVENANCE_INCOMPLETE");
  }
  const spec = object(out.prompt.design_spec);
  const attributes = object(object(signal.demand).attributes);
  for (const key of ["category", "season", "scene", "fit", "silhouette", "color"]) {
    const value = spec[key]; if (value === null) continue;
    if (value === attributes[key]) {
      const sourceIds = new Set(evidence.flatMap(e => {
        const fields = object(e.field_sources); return Array.isArray(fields[key]) ? fields[key] as unknown[] : [];
      }));
      ensure(list(out.prompt.source_refs).some(entry => sourceIds.has(object(entry).evidence_id)), "PROVENANCE_INCOMPLETE");
    } else {
      ensure(list(out.prompt.human_additions).some(entry => {
        const addition = object(entry);
        const paths = [`design_spec.${key}`, `prompt.design_spec.${key}`, ...(key === "category" ? ["design_object", "requirement.design_object"] : [])];
        return paths.includes(addition.field_path as string) && addition.text === value && addition.author_subject === actor;
      }), "PROVENANCE_INCOMPLETE");
    }
  }
  for (const key of ["material", "craft"]) {
    if (spec[key] !== null) ensure(list(out.prompt.source_refs).some(entry => {
      const ref = object(entry); return [key, `design_spec.${key}`, `prompt.design_spec.${key}`].includes(ref.field_path as string) && (ref.excerpt as string).includes(spec[key] as string);
    }), "PROVENANCE_INCOMPLETE");
  }
  return out;
}

export function makeApprovedPackage(signal: JsonObject, group: SavedGroup, approval: JsonObject, pair: PartnerPair, version: string): JsonObject {
  ensure(signal.schema_version === "pa-styling-signal/2", "UNSUPPORTED_SCHEMA");
  ensure(signal.source_product === "personal_styling" && signal.signal_revision === 1, "BINDING_MISMATCH");
  ensure(signal.target_instance_id === pair.source_instance_id && signal.authorized_scope === pair.authorized_scope, "BINDING_MISMATCH");
  ensure(signal.provenance_status === "complete", "PROVENANCE_INCOMPLETE");
  ensure(signal.mapping_version === "dh1.4-to-signal2/1" && signal.environment === "synthetic_local");
  id(signal.signal_id); id(signal.source_instance_id); pairFields(pair); packageVersion(version);
  const source = shape(signal.source_ref, "handoff_id revision payload_digest supplement_id supplement_digest metadata_digest direct_receive_id approval_record_id verification_id verified_at");
  id(source.handoff_id); integer(source.revision); digest(source.payload_digest); id(source.supplement_id); digest(source.supplement_digest);
  digest(source.metadata_digest); id(source.direct_receive_id); id(source.approval_record_id); id(source.verification_id); timestamp(source.verified_at);
  const srcApproval = shape(signal.source_approval, "subject identity_kind approved_at");
  id(srcApproval.subject); ensure(srcApproval.identity_kind === "account_bound"); timestamp(srcApproval.approved_at);
  assertSafeContent(srcApproval);
  const rawRequirement = decoded(group.requirement_base64, group.requirement_digest), rawPrompt = decoded(group.prompt_base64, group.prompt_digest);
  const { requirement, prompt } = validateContent(parseStrictJson(rawRequirement, CONTENT_LIMIT), parseStrictJson(rawPrompt, CONTENT_LIMIT));
  ensure(list(prompt.source_refs).length > 0, "PROVENANCE_INCOMPLETE");
  const refSource = object(signal.source_ref); const projection = list(signal.evidence_projection).map(object);
  for (const entry of list(prompt.source_refs)) {
    const ref = object(entry); const evidence = projection.find(item => item.evidence_id === ref.evidence_id);
    ensure(ref.signal_id === signal.signal_id && ref.source_payload_digest === refSource.payload_digest && evidence?.revision === ref.evidence_revision && typeof evidence?.text === "string" && evidence.text.includes(ref.excerpt as string), "PROVENANCE_INCOMPLETE");
  }
  ensure(!list(prompt.unknowns).some(item => object(item).blocking === true), "PROVENANCE_INCOMPLETE");
  ensure(!list(prompt.conflicts).some(item => object(item).blocking === true && object(item).resolution === null), "PROVENANCE_INCOMPLETE");
  const approved = shape(approval, "approval_schema decision_id approved_by approved_at version_group_id requirement_digest prompt_digest final_priority priority_reason");
  assertSafeContent(approved);
  ensure(approved.approval_schema === "pa-product-approval/2", "UNSUPPORTED_SCHEMA");
  id(approved.decision_id); id(approved.approved_by); timestamp(approved.approved_at); choice(approved.final_priority, ["P0", "P1", "P2", "P3"]); text(approved.priority_reason);
  id(group.version_group_id); integer(group.requirement_version); integer(group.prompt_version);
  ensure(approved.version_group_id === group.version_group_id && approved.requirement_digest === group.requirement_digest && approved.prompt_digest === group.prompt_digest, "BINDING_MISMATCH");
  const demand = object(signal.demand); const projectionDigest = digest(signal.projection_digest);
  const projectionRaw = decoded(signal.projection_base64, projectionDigest, PROJECTION_LIMIT);
  ensure(same(parseStrictJson(projectionRaw, PROJECTION_LIMIT), signal.evidence_projection), "PROVENANCE_INCOMPLETE");
  const result: JsonObject = {
    package_schema: "pa-design-package/2", package_id: `PKG-WB-${signal.signal_id}`, version,
    source_product: "product_management", target_product: "footwear_design", ...pair,
    source_agent: "product", status: "approved", signal_ids: [signal.signal_id], source: "穿搭已批准需求 · 产品管理工作台",
    dedup_key: sha256(Buffer.from(JSON.stringify([signal.source_instance_id, signal.authorized_scope, source.handoff_id, source.revision]), "utf8")),
    dedup_rule: "一条批准需求集合建包；不推断群体需求", data_origin: choice(signal.data_origin, ["synthetic", "runtime_demo", "mixed_demo"]), environment: "synthetic_local",
    sample_count: { intent: null, simulated_cart: null, real_purchase: null },
    evidence_counts: { expressions: integer(demand.occurrences, 0), sessions: integer(demand.session_count, 0), unit: "expressions_and_sessions" },
    attribution: { supply_gap: null, image_gap: null, style_demand: null }, requirement_desc: requirement.requirement_desc,
    constraints: requirement.constraints, source_refs: prompt.source_refs,
    provenance: { signal_schema: signal.schema_version, signal_id: signal.signal_id, mapping_version: signal.mapping_version,
      source_payload_digest: source.payload_digest, source_supplement_digest: source.supplement_digest,
      source_approval_ref: { approval_record_id: source.approval_record_id }, source_approval_subject: srcApproval.subject,
      source_approved_at: srcApproval.approved_at, verification_id: source.verification_id, verified_at: source.verified_at,
      projection_digest: projectionDigest, provenance_status: signal.provenance_status },
    version_group_id: group.version_group_id, requirement_version: group.requirement_version, prompt_version: group.prompt_version,
    requirement_digest: group.requirement_digest, requirement_base64: group.requirement_base64,
    prompt_digest: group.prompt_digest, prompt_base64: group.prompt_base64, approval: approved,
  };
  id(result.package_id); ensure(Buffer.byteLength(JSON.stringify(result), "utf8") <= CONTENT_LIMIT, "PAYLOAD_TOO_LARGE", 413);
  return result;
}

function assets(value: unknown): void {
  const entries = list(value); ensure(entries.length > 0); const ids = new Set<string>();
  for (const entry of entries) {
    const asset = shape(entry, "asset_id sha256 mime_type width height origin");
    const assetId = id(asset.asset_id); ensure(!ids.has(assetId)); ids.add(assetId); digest(asset.sha256);
    choice(asset.mime_type, ["image/png", "image/jpeg", "image/webp"]); integer(asset.width); integer(asset.height);
    choice(asset.origin, ["synthetic_fixture", "model_generated", "authorized_reference"]);
  }
}
function checks(value: unknown): void {
  for (const entry of list(value)) { const check = shape(entry, "code status note"); id(check.code); choice(check.status, ["passed", "failed", "not_checked"]); text(check.note, 10000, true); }
}
function receipt(value: unknown, event: JsonObject): void {
  const r = shape(value, "receipt_schema design_receive_id source_instance_id target_instance_id authorized_scope package_id version content_digest status received_at");
  ensure(r.receipt_schema === "pa-design-receipt/2", "UNSUPPORTED_SCHEMA"); ensure(r.status === "received"); timestamp(r.received_at);
  ensure(r.source_instance_id === event.target_instance_id && r.target_instance_id === event.source_instance_id && r.content_digest === event.package_content_digest, "BINDING_MISMATCH");
  for (const key of ["design_receive_id", "authorized_scope", "package_id", "version"]) ensure(r[key] === event[key], "BINDING_MISMATCH");
}

function generationProvenance(value: unknown, event: JsonObject, version: JsonObject): void {
  const p = shape(value, "schema_version provider model response_model generation_task_id generation_attempt_id provider_request_id execution_prompt_id execution_prompt_digest execution_prompt_base64 source_product_prompt_digest authorization_ref started_at completed_at actual_cost_fen");
  ensure(p.schema_version === "pa-image-generation/1", "UNSUPPORTED_SCHEMA");
  for (const key of ["provider", "model", "generation_task_id", "generation_attempt_id", "execution_prompt_id", "authorization_ref"]) id(p[key]);
  for (const key of ["response_model", "provider_request_id"]) if (p[key] !== null) id(p[key]);
  digest(p.source_product_prompt_digest);
  ensure(p.source_product_prompt_digest === event.prompt_digest, "BINDING_MISMATCH");
  const promptRaw = decoded(p.execution_prompt_base64, p.execution_prompt_digest, 40000);
  let prompt: string;
  try { prompt = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(promptRaw); } catch { fail(); }
  text(prompt, 10000); assertSafeContent(prompt);
  // The actual execution text is checked after UTF-8 decoding, rather than treating
  // opaque base64 as proof that an otherwise forbidden URL/photo/credential is safe.
  for (const [key, item] of Object.entries(p)) if (key !== "execution_prompt_base64") assertSafeContent(item);
  timestamp(p.started_at); timestamp(p.completed_at);
  ensure(Date.parse(p.started_at as string) <= Date.parse(p.completed_at as string) && Date.parse(p.completed_at as string) <= Date.parse(version.created_at as string), "BINDING_MISMATCH");
  if (p.actual_cost_fen !== null) integer(p.actual_cost_fen, 0);
}

/** Stored package identity and received-event predecessor must additionally be checked inside the caller's transaction. */
export function validateDesignEvent(raw: Uint8Array, pair?: PartnerPair): { envelope: JsonObject; event: JsonObject; content: Uint8Array } {
  const envelope = shape(parseStrictJson(raw), "delivery_schema source_product target_product source_instance_id target_instance_id authorized_scope event_id event_revision content_digest content_base64");
  ensure(envelope.delivery_schema === "pa-design-event-delivery/2", "UNSUPPORTED_SCHEMA");
  ensure(envelope.source_product === "footwear_design" && envelope.target_product === "product_management"); pairFields(envelope, pair);
  id(envelope.event_id); ensure(envelope.event_revision === 1);
  const content = decoded(envelope.content_base64, envelope.content_digest);
  const event = shape(parseStrictJson(content, CONTENT_LIMIT), "event_schema event_id event_revision kind source_product target_product source_instance_id target_instance_id authorized_scope created_at package_id version package_content_digest design_receive_id version_group_id requirement_digest prompt_digest note design_receipt clarification result");
  ensure(event.event_schema === "pa-design-event/2", "UNSUPPORTED_SCHEMA");
  for (const key of ["event_id", "event_revision", "source_product", "target_product", "source_instance_id", "target_instance_id", "authorized_scope"]) ensure(event[key] === envelope[key], "BINDING_MISMATCH");
  timestamp(event.created_at); id(event.package_id); packageVersion(event.version); id(event.design_receive_id); id(event.version_group_id);
  digest(event.package_content_digest); digest(event.requirement_digest); digest(event.prompt_digest); text(event.note, 10000, true);
  assertSafeContent(event.note);
  choice(event.kind, ["received", "clarification", "design_approved"]);
  const active = event.kind === "received" ? "design_receipt" : event.kind === "clarification" ? "clarification" : "result";
  for (const key of ["design_receipt", "clarification", "result"]) ensure(key === active ? event[key] !== null : event[key] === null);
  if (active === "design_receipt") receipt(event.design_receipt, event);
  else if (active === "clarification") {
    const c = shape(event.clarification, "decision_id manager_subject decided_at reason"); id(c.decision_id); id(c.manager_subject); timestamp(c.decided_at); text(c.reason);
    assertSafeContent(c);
  } else {
    const mode = choice(object(event.result).generation_mode, ["synthetic_fixture", "model_generated"]);
    const extra = mode === "model_generated" ? " generation_provenance" : "";
    const r = shape(event.result, "task_id assignment_id submission_id design_version_id design_version_digest design_version_base64 review assets summary changes checks unknowns generation_mode" + extra);
    for (const key of ["task_id", "assignment_id", "submission_id", "design_version_id"]) id(r[key]);
    const versionRaw = decoded(r.design_version_base64, r.design_version_digest);
    const v = shape(parseStrictJson(versionRaw, CONTENT_LIMIT), "schema_version design_version_id task_id assignment_id design_receive_id package_id package_version package_content_digest version_group_id requirement_digest prompt_digest assets summary changes checks unknowns generation_mode created_by created_at" + extra);
    ensure(v.schema_version === "pa-design-result-version/2", "UNSUPPORTED_SCHEMA"); id(v.created_by); timestamp(v.created_at);
    for (const key of ["design_version_id", "task_id", "assignment_id", "assets", "summary", "changes", "checks", "unknowns", "generation_mode"]) ensure(same(v[key], r[key]), "BINDING_MISMATCH");
    for (const key of ["design_receive_id", "package_id", "package_content_digest", "version_group_id", "requirement_digest", "prompt_digest"]) ensure(v[key] === event[key], "BINDING_MISMATCH");
    ensure(v.package_version === event.version, "BINDING_MISMATCH");
    assets(r.assets); text(r.summary); text(r.changes, 10000, true); checks(r.checks); strings(r.unknowns);
    for (const key of ["assets", "summary", "changes", "checks", "unknowns"]) assertSafeContent(r[key]);
    ensure(list(r.assets).every(item => object(item).origin === mode));
    if (mode === "model_generated") {
      ensure(list(r.assets).length === 1);
      ensure(same(v.generation_provenance, r.generation_provenance), "BINDING_MISMATCH");
      generationProvenance(r.generation_provenance, event, v);
    }
    const review = shape(r.review, "review_id manager_subject approved_at decision submission_id design_version_id design_version_digest");
    assertSafeContent(review);
    id(review.review_id); id(review.manager_subject); timestamp(review.approved_at); ensure(review.decision === "approved");
    for (const key of ["submission_id", "design_version_id", "design_version_digest"]) ensure(review[key] === r[key], "BINDING_MISMATCH");
    ensure(Date.parse(v.created_at as string) <= Date.parse(review.approved_at as string) && Date.parse(review.approved_at as string) <= Date.parse(event.created_at as string), "BINDING_MISMATCH");
  }
  return { envelope, event, content };
}
