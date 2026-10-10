import { createHash } from "node:crypto";
type Obj = Record<string, unknown>;
export const TEMPLATE_VERSION = "partner-outfit-design/1";
export function templateCandidate(signal: Obj, category: string, at: string) {
    const demand = signal.demand as Obj;
    const attrs = demand.attributes as Obj;
    const ref = signal.source_ref as Obj;
    const evidence = signal.evidence_projection as Obj[];
    const parts = [attrs.season, attrs.scene, attrs.fit, attrs.silhouette, attrs.color].filter(x => typeof x === "string" && x.trim()).map(String);
    const description = String(demand.description);
    // Copy explicit source clauses without inventing unmentioned budgets or exclusions.
    const clauses = description.split(/[，,。；;\n]+/u).map(x => x.trim()).filter(Boolean);
    const constraints = clauses.filter(x => /不要|避免|禁止|不能|不得|预算|价格|价位|不超过|以内|至少|不低于/u.test(x));
    const avoid_items = clauses.filter(x => /^(?:不要|避免|禁止|不得)/u.test(x)).map(x => x.replace(/^(?:不要|避免|禁止|不得)\s*/u, "")).filter(Boolean);
    const text = `为${parts.join("、") || "待核对使用场景"}设计一款${category}。来源需求：${description}\n展示要求：清晰展示完整单品轮廓，使用简洁产品展示画面。`;
    const selected = new Map<string, Obj>(evidence.slice(0, 8).map(e => [String(e.evidence_id), e]));
    // A required field can cite an evidence turn beyond the first display excerpt.
    for (const key of ["category", "season", "scene", "fit", "silhouette", "color"]) {
        if (attrs[key] == null) continue;
        const sourceIds = evidence.flatMap(e => {
            const fields = e.field_sources as Obj;
            return Array.isArray(fields?.[key]) ? fields[key] as string[] : [];
        });
        const cited = evidence.find(e => sourceIds.includes(String(e.evidence_id)));
        if (cited) selected.set(String(cited.evidence_id), cited);
    }
    const source_refs = [...selected.values()].map((e, i) => ({ source_ref_id: `REF-${i + 1}`, signal_id: signal.signal_id, source_payload_digest: ref.payload_digest, evidence_id: e.evidence_id, evidence_revision: e.revision, field_path: "positive_prompt", excerpt: String(e.text).slice(0, 500) }));
    return { requirement: { title: String(demand.title), requirement_desc: String(demand.description), design_object: category, constraints, priority_proposal: "P2", priority_reason: "人工待核对的初始建议" }, prompt: { positive_prompt: text, avoid_items, design_spec: { category, season: attrs.season ?? null, scene: attrs.scene ?? null, fit: attrs.fit ?? null, silhouette: attrs.silhouette ?? null, color: attrs.color ?? null, material: null, craft: null, knowledge_status: "pending_database", display_requirements: [{ id: "complete-item", text: "清晰展示完整单品轮廓，使用简洁产品展示画面。", origin: "display_template", template_version: TEMPLATE_VERSION }] }, generation: { mode: "offline_template", template_version: TEMPLATE_VERSION, model: null, generated_at: at, derived_from: null }, source_refs, human_additions: [], unknowns: [...(attrs.color == null ? ["color"] : []), "material", "craft"].map(field_path => ({ field_path: `design_spec.${field_path}`, reason: "来源未提供，保持未知", blocking: false })), conflicts: [] } };
}
export function sameJson(a: unknown, b: unknown): boolean { const normalized = (v: unknown): unknown => Array.isArray(v) ? v.map(normalized) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalized(x)])) : v; return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b)); }
export const sha = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");
export function candidateReference(candidate: {
    prompt: unknown;
}, at: string) { return { kind: "candidate", id: `TPC1_${Buffer.from(at).toString("base64url")}`, prompt_digest: sha(Buffer.from(JSON.stringify(candidate.prompt))) }; }
export function recoverCandidate(signal: Obj, id: string) { if (!id.startsWith("TPC1_"))
    throw new Error("Unknown candidate"); const at = Buffer.from(id.slice(5), "base64url").toString("utf8"); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || new Date(at).toISOString() !== at)
    throw new Error("Invalid candidate timestamp"); const category = String(((signal.demand as Obj).attributes as Obj).category); return templateCandidate(signal, category, at); }
