import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPersonalPreviewService, PERSONAL_PREVIEW_CONTRACT, PersonalPreviewApiError } from "../app/lib/personal-preview-api";
import { personalPreviewSchema as schema } from "../app/lib/personal-preview-schema";

// Synthetic fixtures mapped from backend source, not captured HTTP or real-provider results.
const hash = "a".repeat(64);
const later = "2099-10-10T08:00:00.123456Z";
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid synthetic fixture");
  return value as Record<string, unknown>;
}
function capability(): Record<string, unknown> {
  return { contract_version: PERSONAL_PREVIEW_CONTRACT, enabled: true, available: true, provider_mode: "mock", is_mock: true, real_provider_enabled: false,
    limits: { photo_max_bytes: 5 * 1024 * 1024, metadata_max_bytes: 8 * 1024, max_pixels: 20_000_000, max_side: 8192, formats: ["jpeg", "png", "webp"], active_per_owner: 1, daily_tasks: 10 },
    retention: { confirmation_seconds: 600, input_hard_seconds: 86400, result_seconds: 30 * 86400, metadata_seconds: 90 * 86400, request_tombstones: "retained", provider_retention: "unknown" }, reasons: [] };
}
function selection(): Record<string, unknown> {
  const sizes = { top: { system: "clothing_alpha", value: "M" }, bottom: { system: "clothing_alpha", value: "L" }, shoes: { system: "cn_shoe", value: "38" } };
  return { snapshot_id: `pvs-${hash.slice(0, 32)}`, snapshot_digest: hash, session_id: "synthetic-session", look_version_id: "synthetic-version", look_asset_id: "M1V2-LOOK-101",
    items: (["top", "bottom", "shoes"] as const).map((slot, index) => ({ slot, sku_id: `synthetic-sku-${slot}`, product_id: `synthetic-product-${slot}`, size: sizes[slot], price_fen: 10000 + index,
      reference_asset_id: `synthetic-reference-${slot}`, reference_version: 1, reference_sha256: "b".repeat(64) })),
    fixed_image: { asset_id: "M1V2-LOOK-101", sha256: "c".repeat(64), origin: { origin_type: "ai_generated", source_name: "合成测试来源", source_ref: "synthetic-reference", is_simulated: true, rights_confirmed: true } },
    resources: { catalog_version: "synthetic-catalog-v1", inventory_snapshot_id: "synthetic-inventory-v1", look_asset_version: "synthetic-looks-v1", rule_set_version: "synthetic-rules-v1", attribute_vocabulary_version: "synthetic-attributes-v1" },
    scene: "scene:work_commute", effective_conditions: { budget_max_fen: 80000, usual_sizes: sizes }, profile_summary: { profile_id: null, profile_version: 0, snapshot_id: "synthetic-profile-snapshot", snapshot_digest: "d".repeat(64) }, prompt_version: "personal_preview_prompt_v1" };
}
function task(): Record<string, unknown> {
  return { contract_version: PERSONAL_PREVIEW_CONTRACT, task_id: "synthetic-task", request_id: "synthetic-request", session_id: "synthetic-session", look_version_id: "synthetic-version", state: "queued", deletion_status: "active",
    created_at: later, updated_at: later, expires_at: later, selection: selection(), selection_status: "available", model_image_url: null, is_mock: true, effect_kind: "mock_not_real", effective_personal_preview: false, result_available: false, result_url: null, error: null,
    input_cleanup: { status: "retained", expires_at: later }, usage: { task_count: 1, attempt_count: 0, unknown_attempts: 0, cost_status: "not_applicable_mock" } };
}
const taskDetails = () => ({ input_cleanup: { status: "retained", expires_at: later } as Record<string, unknown>, usage: { task_count: 1, attempt_count: 1, unknown_attempts: 1, cost_status: "not_applicable_mock" } as Record<string, unknown>, effect_kind: "mock_not_real", is_mock: true });
function deletion(): Record<string, unknown> {
  return { contract_version: PERSONAL_PREVIEW_CONTRACT, task_id: "synthetic-task", deletion_status: "deleted", duplicate: false, input_deletion: "deleted", result_deletion: "deleted", provider_cancel: "not_applicable_mock", provider_deletion: "not_applicable_mock", backup_deletion: "unknown" };
}
type Mutate = (value: Record<string, unknown>) => void;

describe("source-mapped schema composed with the transport (controlled fetch, not HTTP acceptance)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const available = () => ({ contract_version: PERSONAL_PREVIEW_CONTRACT, available: true, reasons: [], selection_digest: hash, selection: selection() });
  it("reads real-shaped capability and availability fixtures and retains null historical display facts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(capability())).mockResolvedValueOnce(json(available())); vi.stubGlobal("fetch", fetcher);
    const service = createPersonalPreviewService({ schema }); const target = schema.selection(selection()).target;
    const result = await service.availability(target, new AbortController().signal); expect(result.available).toBe(true); expect(result.mode).toBe("mock"); expect(result.permit).not.toBeNull(); expect(result.selection).toEqual(target);
    expect(fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "GET"]); expect(result.costNote).toContain("真实调用费用未知");
  });
  it("accepts the real-shaped upload envelope and later bare task through the same strict parser", async () => {
    vi.stubGlobal("crypto", { subtle: webcrypto.subtle }); const now = Date.now();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(capability())).mockResolvedValueOnce(json(available()))
      .mockResolvedValueOnce(json({ contract_version: PERSONAL_PREVIEW_CONTRACT, confirmation_id: "synthetic-confirmation", confirmation_token: "t".repeat(43), issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 599000).toISOString(), selection: selection() }, 201))
      .mockResolvedValueOnce(json({ task: task(), duplicate: false }, 202)).mockResolvedValueOnce(json(task())); vi.stubGlobal("fetch", fetcher);
    const service = createPersonalPreviewService({ schema }); const signal = new AbortController().signal; const target = schema.selection(selection()).target; const conditions = await service.availability(target, signal);
    const bytes = new Uint8Array([1, 2, 3]); const photo = new File([bytes], "synthetic-source-schema.png", { type: "image/png" }); Object.defineProperty(photo, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
    const accepted = await service.submit({ requestId: "synthetic-request", target, photo, permit: conditions.permit }, signal); expect(accepted).toMatchObject({ id: "synthetic-task", requestId: "synthetic-request", status: "queued", mode: "mock", hasResult: false, target });
    expect(await service.task("synthetic-task", signal)).toEqual(accepted); expect(fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "GET", "POST", "POST", "GET"]);
    const upload = fetcher.mock.calls[3][1]?.body; expect(upload).toBeInstanceOf(FormData); const parts = Array.from((upload as FormData).entries()); expect(parts.map(part => part[0])).toEqual(["metadata", "photo"]); expect((parts[0][1] as Blob).type).toBe("application/json");
  });
});

describe("public capability route schema", () => {
  it("describes technical mock limits and known retention without inventing real effects or zero costs", () => {
    const notes = schema.capabilityNotes(capability()); expect(notes.purposeNote).toContain("本地隔离模拟"); expect(notes.purposeNote).toContain("不能作为本人真实效果"); expect(notes.retentionNote).toContain("24小时"); expect(notes.retentionNote).toContain("30天"); expect(notes.retentionNote).toContain("90天"); expect(notes.retentionNote).toContain("未知"); expect(notes.costNote).toContain("真实调用费用未知"); expect(notes.costNote).not.toMatch(/0元|免费|无需费用/);
  });
  it.each([1, 100])("uses the actual configured daily_tasks=%i within the v1.0.1 bounds", count => {
    const value = capability(); record(value.limits).daily_tasks = count; expect(schema.capabilityNotes(value).costNote).toContain(`每天最多${count}个任务`);
  });
  it("recognizes a disabled capability without fabricating permission", () => {
    const value = capability(); Object.assign(value, { enabled: false, available: false, provider_mode: "disabled", is_mock: false, reasons: ["PREVIEW_DISABLED"] }); expect(schema.capabilityNotes(value).purposeNote).toContain("不会上传");
  });
  it.each<[string, Mutate]>([
    ["extra outer identity", value => { value.owner_key = "forbidden"; }],
    ["different service-helper limits", value => { value.limits = { max_photo_bytes: 5242880, max_pixels: 20000000, max_edge: 8192, daily_tasks: 10, owner_concurrency: 1 }; }],
    ["unknown format", value => { record(value.limits).formats = ["jpeg", "png", "gif"]; }],
    ["duplicate format", value => { record(value.limits).formats = ["jpeg", "png", "png"]; }],
    ["zero daily limit", value => { record(value.limits).daily_tasks = 0; }],
    ["too-large daily limit", value => { record(value.limits).daily_tasks = 101; }],
    ["non-integer daily limit", value => { record(value.limits).daily_tasks = 1.5; }],
    ["string daily limit", value => { record(value.limits).daily_tasks = "10"; }],
    ["extra nested provider", value => { record(value.retention).provider_url = "https://not-used.invalid"; }],
    ["invented provider deletion", value => { record(value.retention).provider_retention = "deleted"; }],
    ["silently changed retention", value => { record(value.retention).input_hard_seconds = 172800; }],
    ["real provider promotion", value => { value.real_provider_enabled = true; }],
    ["contradictory mock flag", value => { value.is_mock = false; }],
    ["unknown reasons", value => { value.reasons = ["arbitrary service text"]; }],
  ])("rejects %s", (_name, mutate) => { const value = capability(); mutate(value); expect(() => schema.capabilityNotes(value)).toThrow(PersonalPreviewApiError); });
});

describe("frozen public selection projection", () => {
  it("uses only frozen IDs and reference metadata and explicitly leaves missing display facts null", () => {
    const raw = selection(); const parsed = schema.selection(raw); expect(parsed.digest).toBe(hash); expect(parsed.target).toMatchObject({ sessionId: "synthetic-session", lookVersionId: "synthetic-version", lookId: "M1V2-LOOK-101", versionNo: null, modelUrl: null, selectionDigest: hash });
    expect(parsed.target.items).toEqual(["top", "bottom", "shoes"].map(slot => ({ slot, skuId: `synthetic-sku-${slot}`, name: `synthetic-sku-${slot}`, referenceAssetId: `synthetic-reference-${slot}`, referenceVersion: "1" })));
    const serialized = JSON.stringify(parsed); expect(serialized).not.toContain("profile_summary"); expect(serialized).not.toContain("budget_max_fen"); expect(serialized).not.toContain("/api/");
    record((raw.items as unknown[])[0]).sku_id = "changed-after-parse"; expect(parsed.target.items[0].skuId).toBe("synthetic-sku-top");
  });
  it("allows known absent or reduced profile provenance without inventing current profile fields", () => {
    const raw = selection(); raw.profile_summary = null; expect(schema.selection(raw).target.modelUrl).toBeNull(); raw.profile_summary = {}; raw.effective_conditions = {}; expect(schema.selection(raw).target.versionNo).toBeNull();
  });
  it("treats cleared historical content as unknown metadata, not evidence that the original request was never accepted", () => {
    try { schema.selection({}); throw new Error("Expected metadata error"); } catch (error) { expect(error).toBeInstanceOf(PersonalPreviewApiError); expect(error).toMatchObject({ code: "PREVIEW_HISTORY_METADATA_UNAVAILABLE", definitive: false, identityInvalid: false }); }
  });
  it.each<[string, Mutate]>([
    ["snapshot/digest mismatch", value => { value.snapshot_id = "pvs-wrong"; }],
    ["missing digest", value => { delete value.snapshot_digest; }],
    ["private owner", value => { value.owner_key = "forbidden"; }],
    ["private photo hash", value => { value.photo_sha256 = hash; }],
    ["server URL not in the public contract", value => { value.model_url = "/private-current.jpg"; }],
    ["incomplete frozen references", value => { delete record((value.items as unknown[])[0]).reference_sha256; }],
    ["duplicate slots", value => { record((value.items as unknown[])[1]).slot = "top"; }],
    ["duplicate SKU", value => { record((value.items as unknown[])[1]).sku_id = "synthetic-sku-top"; }],
    ["wrong shoe size system", value => { record((value.items as unknown[])[2]).size = { system: "clothing_alpha", value: "M" }; }],
    ["extra nested measurements", value => { record(value.effective_conditions).height_cm = 165; }],
    ["extra profile measurements", value => { record(value.profile_summary).weight_kg = 55; }],
    ["extra nested reference URL", value => { record((value.items as unknown[])[0]).image_url = "https://external.invalid"; }],
    ["non-integer reference version", value => { record((value.items as unknown[])[0]).reference_version = "1"; }],
    ["negative price", value => { record((value.items as unknown[])[0]).price_fen = -1; }],
    ["wrong fixed asset", value => { record(value.fixed_image).asset_id = "M1V2-LOOK-112"; }],
    ["unconfirmed rights", value => { record(record(value.fixed_image).origin).rights_confirmed = false; }],
    ["coerced origin enum", value => { record(record(value.fixed_image).origin).origin_type = ["ai_generated"]; }],
    ["unknown resource version field", value => { record(value.resources).current_lookup = "forbidden"; }],
    ["missing resource binding", value => { delete record(value.resources).catalog_version; }],
    ["unknown prompt version", value => { value.prompt_version = "unknown"; }],
  ])("rejects %s instead of repairing it from current data", (_name, mutate) => { const value = selection(); mutate(value); expect(() => schema.selection(value)).toThrow(PersonalPreviewApiError); });
});

describe("task envelope, cleanup, usage, and deletion schema", () => {
  it("unwraps only the actual POST envelope after verifying duplicate without stripping unknown fields", () => {
    const raw = task(); expect(schema.taskEnvelope({ task: raw, duplicate: false })).toBe(raw); expect(schema.taskEnvelope({ task: raw, duplicate: true })).toBe(raw); expect(schema.taskEnvelope(raw)).toBe(raw);
    expect(() => schema.taskEnvelope({ task: raw, duplicate: true, secret: "not-allowed" })).toThrow(); expect(() => schema.taskEnvelope({ task: { ...raw, owner_key: "forbidden" }, duplicate: false })).toThrow(); expect(() => schema.taskEnvelope({ task: raw, duplicate: "false" })).toThrow(); expect(() => schema.taskEnvelope({ ...raw, duplicate: false })).toThrow();
  });
  it("accepts recorded cleanup and unknown-attempt facts without treating unknown as zero cost", () => {
    const mock = taskDetails(); expect(() => schema.taskDetails(mock)).not.toThrow();
    const unavailable = taskDetails(); unavailable.is_mock = false; unavailable.effect_kind = "unavailable"; unavailable.usage.cost_status = "unknown"; expect(() => schema.taskDetails(unavailable)).not.toThrow(); expect(unavailable.usage.cost_status).toBe("unknown");
  });
  it.each<[string, (value: ReturnType<typeof taskDetails>) => void]>([
    ["private input path", value => { value.input_cleanup.path = "/private/photo.jpg"; }],
    ["extra fee estimate", value => { value.usage.cost_fen = 0; }],
    ["unknown greater than attempts", value => { value.usage.unknown_attempts = 2; }],
    ["invented repeated attempts", value => { value.usage.attempt_count = 2; }],
    ["zero tasks", value => { value.usage.task_count = 0; }],
    ["string counter", value => { value.usage.attempt_count = "1"; }],
    ["zero cost instead of mock marker", value => { value.usage.cost_status = 0; }],
    ["mock promotion", value => { value.effect_kind = "real"; }],
    ["impossible date", value => { value.input_cleanup.expires_at = "2026-02-30T00:00:00Z"; }],
    ["coerced cleanup enum", value => { value.input_cleanup.status = ["deleted"]; }],
  ])("rejects %s", (_name, mutate) => { const value = taskDetails(); mutate(value); expect(() => schema.taskDetails(value)).toThrow(PersonalPreviewApiError); });
  it("accepts local deleting and deleted while preserving unknown external deletion semantics", () => {
    expect(schema.deletion(deletion())).toEqual({ taskId: "synthetic-task", status: "deleted" }); const pending = deletion(); Object.assign(pending, { deletion_status: "deleting", input_deletion: "failed", result_deletion: "pending", provider_cancel: "unknown", provider_deletion: "unknown" }); expect(schema.deletion(pending).status).toBe("deleting"); expect(pending.backup_deletion).toBe("unknown");
  });
  it.each<[string, Mutate]>([
    ["private deletion path", value => { value.storage_key = "forbidden"; }],
    ["active deletion response", value => { value.deletion_status = "active"; }],
    ["deleted with retained input", value => { value.input_deletion = "retained"; }],
    ["deleted with failed result unlink", value => { value.result_deletion = "failed"; }],
    ["unproven provider cancellation", value => { value.provider_cancel = "succeeded"; }],
    ["contradictory external status", value => { value.provider_deletion = "unknown"; }],
    ["unproven backup deletion", value => { value.backup_deletion = "deleted"; }],
    ["coerced external enum", value => { value.provider_cancel = ["not_applicable_mock"]; }],
  ])("rejects %s", (_name, mutate) => { const value = deletion(); mutate(value); expect(() => schema.deletion(value)).toThrow(PersonalPreviewApiError); });
});

describe("publication 1.0.2 frozen version number", () => {
  it("uses only an actually provided positive version number", () => {
    const value = selection(); value.look_version_no = 7;
    expect(schema.selection(value).target.versionNo).toBe(7);
    delete value.look_version_no; expect(schema.selection(value).target.versionNo).toBeNull();
  });
  it.each([0, -1, 1.5, "7", null])("rejects invalid frozen version %#", version => {
    const value = selection(); value.look_version_no = version; expect(() => schema.selection(value)).toThrow(PersonalPreviewApiError);
  });
});

describe("locked publication 1.0.3 real provider, pending review stays separate", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const realCaps = () => { const value = capability(); Object.assign(value, { provider_mode: "runninghub", provider_model: "rhart-image-n-pro-official/edit", is_mock: false, real_provider_enabled: true }); record(value.limits).total_real_tasks = 1; return value; };
  const realTask = () => { const value = task(); Object.assign(value, { is_mock: false, state: "output_pending_review", effect_kind: "ai_personal_reference", effective_personal_preview: false, result_available: true, result_url: "/api/v1/personal-preview/tasks/synthetic-task/result" }); Object.assign(record(value.selection), { prompt_version: "personal_preview_identity_four_refs_v1" }); Object.assign(record(value.usage), { attempt_count: 1, cost_status: "unknown", provider_model: "rhart-image-n-pro-official/edit", cost_amount: null, cost_currency: null, provider_usage: { tokens: 42 } }); return value; };
  it("discloses four-image processing, one instance task and unknown supplier deletion/cost", () => {
    const notes = schema.capabilityNotes(realCaps()); expect(notes.purposeNote).toContain("RunningHub"); expect(notes.purposeNote).toContain("本人照片"); expect(notes.purposeNote).toContain("三张参考图"); expect(notes.retentionNote).toContain("物理删除情况未知"); expect(notes.costNote).toContain("整个实例最多1个"); expect(notes.costNote).not.toContain("0元"); expect(notes.purposeNote).not.toContain("模拟");
  });
  it.each(["unknown", "too-many", "private"])("rejects unsupported provider or limits %s", kind => {
    const value = realCaps(); if (kind === "unknown") value.provider_model = "another-model"; if (kind === "too-many") record(value.limits).total_real_tasks = 2; if (kind === "private") value.secret = "no";
    expect(() => schema.capabilityNotes(value)).toThrow(PersonalPreviewApiError);
  });
  it("displays a real readable result despite effective=false, preserving pending_review", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(realTask())); vi.stubGlobal("fetch", fetcher);
    const result = await createPersonalPreviewService({ schema }).task("synthetic-task", new AbortController().signal);
    expect(result).toMatchObject({ mode: "real", status: "output_pending_review", hasResult: true }); expect(result.detail).toContain("待用户核对"); expect(fetcher.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  });
  it.each(["promote", "private-usage", "zero-fee", "wrong-effect"])("rejects unwarranted success or unsafe usage %s", async kind => {
    const value = realTask(); if (kind === "promote") Object.assign(value, { state: "succeeded", effective_personal_preview: true }); if (kind === "private-usage") record(value.usage).provider_usage = { signed_url: "https://private.invalid" }; if (kind === "zero-fee") record(value.usage).cost_amount = 0; if (kind === "wrong-effect") value.effect_kind = "mock_not_real";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(json(value)));
    await expect(createPersonalPreviewService({ schema }).task("synthetic-task", new AbortController().signal)).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
  });
});
