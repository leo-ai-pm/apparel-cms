import { invalidResponse, isObject, request } from "@/lib/api/client";
import type { DraftInput, EvidenceRecord, PublishResult, PullResult } from "./types";

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseRecord(value: unknown): EvidenceRecord {
  if (!isObject(value) || !count(value.id) || !stringArray(value.signal_ids) || !stringArray(value.constraints)) return invalidResponse();
  if (!["version", "status", "dedup_key", "dedup_rule", "source", "created_at"].every((key) => typeof value[key] === "string")) return invalidResponse();
  if (!["package_id", "requirement_desc", "published_at"].every((key) => value[key] === null || typeof value[key] === "string")) return invalidResponse();
  if (value.priority !== null && value.priority !== undefined && !["P0", "P1", "P2", "P3"].includes(String(value.priority))) return invalidResponse();
  if (value.priority_basis !== null && value.priority_basis !== undefined && typeof value.priority_basis !== "string") return invalidResponse();
  const sample = value.sample_count;
  const attribution = value.attribution;
  if (!isObject(sample) || ![sample.intent, sample.simulated_cart, sample.real_purchase].every(count)) return invalidResponse();
  if (!isObject(attribution) || ![attribution.supply_gap, attribution.image_gap, attribution.style_demand].every((x) => typeof x === "boolean")) return invalidResponse();
  return { ...value, priority: value.priority ?? null, priority_basis: value.priority_basis ?? null } as EvidenceRecord;
}

function parseList(value: unknown, key: string): EvidenceRecord[] {
  if (!isObject(value) || !Array.isArray(value[key])) return invalidResponse();
  return value[key].map(parseRecord);
}

export const workspaceApi = {
  drafts: () => request("/drafts", (v) => parseList(v, "drafts")),
  packages: () => request("/packages", (v) => parseList(v, "packages")),
  draft: (id: number) => request(`/drafts/${id}`, parseRecord),
  save: (id: number, body: DraftInput) => request(`/drafts/${id}`, parseRecord, { method: "PATCH", body: JSON.stringify(body) }),
  pull: () => request<PullResult>("/pull", (v) => {
    if (!isObject(v) || !count(v.new_count) || (v.new_count > 0 && !count(v.draft_id))) return invalidResponse();
    return { new_count: v.new_count, draft_id: count(v.draft_id) ? v.draft_id : undefined };
  }, { method: "POST" }),
  publish: (id: number, body: DraftInput) => request<PublishResult>(`/drafts/${id}/publish`, (v) => {
    if (!isObject(v) || !isObject(v.package) || typeof v.package.package_id !== "string" || !isObject(v.cms) || typeof v.cms.status !== "string") return invalidResponse();
    return { package: { package_id: v.package.package_id }, cms: { status: v.cms.status } };
  }, { method: "POST", body: JSON.stringify(body) }),
  rework: (id: string) => request(`/packages/${encodeURIComponent(id)}/rework`, (v) => {
    if (!isObject(v) || !count(v.draft_id) || typeof v.version !== "string") return invalidResponse();
    return { draft_id: v.draft_id, version: v.version };
  }, { method: "POST" }),
};
