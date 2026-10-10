import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersonalPreviewService, PERSONAL_PREVIEW_CONTRACT, parsePersonalPreviewJson, PersonalPreviewApiError, type PersonalPreviewSchema } from "../app/lib/personal-preview-api";
import type { PersonalPreviewApiService } from "../app/lib/personal-preview-api";
import type { PersonalPreviewTarget } from "../app/lib/personal-preview-model";

// Synthetic closed nested schema ONLY for transport unit tests. No field below
// locks a production response, represents an HTTP run, or uses a person's photo.
const digest = "a".repeat(64);
const token = "t".repeat(43);
const target: PersonalPreviewTarget = { sessionId: "session-test", lookVersionId: "version-test", versionNo: 1, lookId: "LOOK-TEST", modelUrl: "/look-examples/synthetic.png",
  items: [{ slot: "top", skuId: "SKU-T", name: "合成上衣" }, { slot: "bottom", skuId: "SKU-B", name: "合成裤子" }, { slot: "shoes", skuId: "SKU-S", name: "合成鞋" }] };
const own = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: unknown, keys: string[]): value is Record<string, unknown> => own(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const malformed = () => new PersonalPreviewApiError(502, "PREVIEW_INVALID_RESPONSE", "Synthetic schema rejected");
const schema: PersonalPreviewSchema = {
  capabilityNotes(value) {
    if (!closed(value.limits, ["fixture_upload_bytes"]) || value.limits.fixture_upload_bytes !== 5 * 1024 * 1024
      || !closed(value.retention, ["fixture_note"]) || value.retention.fixture_note !== "isolated") throw malformed();
    return { purposeNote: "仅本次合成协议测试", retentionNote: "非真实存储留存证据", costNote: "mock不代表真实费用或0元" };
  },
  selection(value) {
    if (!closed(value, ["fixture_digest", "fixture_target"]) || typeof value.fixture_digest !== "string" || !own(value.fixture_target)) throw malformed();
    // Exact UI projection is part of this explicit test fixture, never inferred from PP-0 prose.
    return { digest: value.fixture_digest, target: value.fixture_target as PersonalPreviewTarget };
  },
  taskEnvelope(value) {
    if (!own(value)) throw malformed();
    if ("task" in value) { if (!closed(value, ["task", "duplicate"]) || typeof value.duplicate !== "boolean" || !own(value.task)) throw malformed(); return value.task; }
    return value;
  },
  taskDetails(value) {
    if (!closed(value.input_cleanup, ["fixture_state"]) || !["removed", "pending"].includes(String(value.input_cleanup.fixture_state))
      || !closed(value.usage, ["task_count", "attempt_count", "unknown_attempts", "cost_status"])
      || !["task_count", "attempt_count", "unknown_attempts"].every(key => Number.isSafeInteger(value.usage && own(value.usage) ? value.usage[key] : null))
      || value.usage.cost_status !== "not_applicable_mock") throw malformed();
  },
  deletion(value) {
    if (!closed(value, ["fixture_task_id", "fixture_status"]) || typeof value.fixture_task_id !== "string" || !["deleting", "deleted"].includes(String(value.fixture_status))) throw malformed();
    return { taskId: value.fixture_task_id, status: value.fixture_status as "deleting" | "deleted" };
  },
};
const selected = (changes: Partial<PersonalPreviewTarget> = {}, sha = digest) => ({ fixture_digest: sha, fixture_target: { ...target, ...changes } });
const caps = (changes: Record<string, unknown> = {}) => ({ contract_version: PERSONAL_PREVIEW_CONTRACT, enabled: true, available: true, provider_mode: "mock", is_mock: true,
  real_provider_enabled: false, limits: { fixture_upload_bytes: 5 * 1024 * 1024 }, retention: { fixture_note: "isolated" }, reasons: [], ...changes });
const available = (changes: Record<string, unknown> = {}) => ({ contract_version: PERSONAL_PREVIEW_CONTRACT, available: true, reasons: [], selection_digest: digest, selection: selected(), ...changes });
const confirmation = (changes: Record<string, unknown> = {}) => ({ confirmation_id: "confirm-test", confirmation_token: token, issued_at: "2026-10-10T02:00:00Z", expires_at: "2026-10-10T02:10:00Z", selection: selected(), ...changes });
const rawTask = (changes: Record<string, unknown> = {}) => ({ contract_version: PERSONAL_PREVIEW_CONTRACT, task_id: "task-test", request_id: "request-test", session_id: target.sessionId,
  look_version_id: target.lookVersionId, state: "output_pending_review", deletion_status: "active", created_at: "2026-10-10T02:00:00Z", updated_at: "2026-10-10T02:00:01Z", expires_at: "2026-11-09T02:00:00Z",
  selection: selected(), selection_status: "available", model_image_url: null, is_mock: true, effect_kind: "mock_not_real", effective_personal_preview: false, result_available: true,
  result_url: "/api/v1/personal-preview/tasks/task-test/result", error: null, input_cleanup: { fixture_state: "removed" },
  usage: { task_count: 1, attempt_count: 1, unknown_attempts: 0, cost_status: "not_applicable_mock" }, ...changes });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const taskReply = (status: 200 | 202 = 202, duplicate = status === 200) => json({ task: rawTask(), duplicate }, status);
const failure = (code: string, status: number) => json({ error: { code, message: `sensitive upstream ${token}` } }, status);
const signal = () => new AbortController().signal;
const bytes = new Uint8Array([11, 12, 13]);
function photo() {
  const file = new File([bytes], "synthetic-unit-only.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-10T02:00:02Z"));
  vi.stubGlobal("crypto", { subtle: webcrypto.subtle }); fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function permit(service: PersonalPreviewApiService) {
  fetcher.mockResolvedValueOnce(json(caps())).mockResolvedValueOnce(json(available()));
  return service.availability(target, signal());
}
async function metadataText(body: FormData): Promise<string> {
  const value = body.get("metadata"); if (!(value instanceof Blob)) throw new Error("missing JSON part");
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("not text")); reader.onerror = () => reject(new Error("cannot read synthetic JSON part")); reader.readAsText(value); });
}
async function lostUpload(code?: string, status = 503) {
  const service = createPersonalPreviewService({ schema }); const conditions = await permit(service); const file = photo();
  fetcher.mockResolvedValueOnce(json(confirmation(), 201));
  if (code) fetcher.mockResolvedValueOnce(failure(code, status)); else fetcher.mockRejectedValueOnce(new TypeError("synthetic connection lost"));
  let caught: unknown;
  try { await service.submit({ requestId: "request-test", target, photo: file, permit: conditions.permit }, signal()); } catch (cause) { caught = cause; }
  return { service, caught, file };
}

describe("PP-0 closed parsing and explicit schema readiness", () => {
  it("fails closed without a locked nested schema and performs no confirmation/upload", async () => {
    const service = createPersonalPreviewService(); fetcher.mockResolvedValueOnce(json(caps()));
    await expect(service.availability(target, signal())).rejects.toMatchObject({ code: "PREVIEW_SCHEMA_UNAVAILABLE", definitive: false });
    await expect(service.submit({ requestId: "request-test", target, photo: photo(), permit: {} }, signal())).rejects.toMatchObject({ code: "PREVIEW_SCHEMA_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
  });
  it.each(['{"available":true,"available":false}', '{"available":true,"\\u0061vailable":false}', '{"outer":{"x":1,"x":2}}', '{"n":1e999}', '{"a":1} trailing'])
  ("rejects duplicate/escaped keys, malformed numbers and trailing JSON %#", raw => { expect(() => parsePersonalPreviewJson(raw)).toThrow(PersonalPreviewApiError); });
  it("reads capabilities then private availability with only same-origin no-store GETs", async () => {
    const service = createPersonalPreviewService({ schema }); const result = await permit(service);
    expect(result).toMatchObject({ available: true, mode: "mock", selection: { ...target, selectionDigest: digest } });
    expect(result.permit).toEqual({}); expect(JSON.stringify(result)).not.toContain(token);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/personal-preview/capabilities", "/api/v1/personal-preview/availability?session_id=session-test&look_version_id=version-test"]);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store", redirect: "error" });
  });
  it("does not read availability when the provider is disabled and never invents a permit", async () => {
    fetcher.mockResolvedValueOnce(json(caps({ enabled: false, available: false, provider_mode: "disabled", reasons: ["服务未启用"] })));
    const result = await createPersonalPreviewService({ schema }).availability(target, signal()); expect(result.available).toBe(false); expect(result.permit).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("explains an unavailable Look without inventing a target from incomplete selection", async () => {
    fetcher.mockResolvedValueOnce(json(caps())).mockResolvedValueOnce(json(available({ available: false, reasons: ["PREVIEW_REFERENCE_UNAVAILABLE"], selection: { items: [] } })));
    const result = await createPersonalPreviewService({ schema }).availability(target, signal()); expect(result).toMatchObject({ available: false, permit: null, mode: "unavailable" });
    expect(result.reasons).toEqual(["这套搭配的参考图片暂不齐全或不可用。"]); expect(result.selection).toBeUndefined();
  });
  it("unknown reasons fail closed and never expose raw sensitive messages", async () => {
    fetcher.mockResolvedValueOnce(json(caps())).mockResolvedValueOnce(json(available({ reasons: [`private token ${token}`] })));
    const result = await createPersonalPreviewService({ schema }).availability(target, signal()); expect(result.available).toBe(false); expect(result.permit).toBeNull(); expect(JSON.stringify(result)).not.toContain(token);
  });
  it.each([
    { selection_digest: "b".repeat(64) }, { selection: selected({ lookVersionId: "other-version" }) },
    { selection: { mystery: "not a locked selection" } }, { owner_key: "forbidden" },
  ])("rejects unbound/unknown availability or opaque nested shape %#", async change => {
    fetcher.mockResolvedValueOnce(json(caps())).mockResolvedValueOnce(json(available(change)));
    await expect(createPersonalPreviewService({ schema }).availability(target, signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it.each([{ state: "succeeded" }, { effective_personal_preview: true }, { effect_kind: "real_personal_preview" }])("rejects mock contradictory success flags %#", async change => {
    fetcher.mockResolvedValueOnce(json(rawTask(change))); await expect(createPersonalPreviewService({ schema }).task("task-test", signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
  });
  it("rejects a task selection not associated with the requested session/Look", async () => {
    fetcher.mockResolvedValueOnce(json(rawTask({ selection: selected({ sessionId: "other-session" }) })));
    await expect(createPersonalPreviewService({ schema }).task("task-test", signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
  });
  it("does not label a nonmock unavailable provider as a real result", async () => {
    fetcher.mockResolvedValueOnce(json(rawTask({ is_mock: false, effect_kind: "unavailable", state: "failed", result_available: false, result_url: null })));
    await expect(createPersonalPreviewService({ schema }).task("task-test", signal())).resolves.toMatchObject({ mode: "real", status: "failed", hasResult: false });
  });
  it("accepts explicitly absent historical display fields without filling them from the current Look", async () => {
    fetcher.mockResolvedValueOnce(json(rawTask({ selection: selected({ versionNo: null, modelUrl: null, items: target.items.map(item => ({ ...item, name: item.skuId })) }) })));
    const result = await createPersonalPreviewService({ schema }).task("task-test", signal()); expect(result.target.versionNo).toBeNull(); expect(result.target.modelUrl).toBeNull(); expect(result.target.items[0].name).toBe("SKU-T");
  });
});

describe("explicit confirmation, multipart upload and sensitive lifetime", () => {
  it("hashes the File then sends exact confirmation fields and metadata before photo", async () => {
    const service = createPersonalPreviewService({ schema }); const conditions = await permit(service); const file = photo();
    fetcher.mockResolvedValueOnce(json(confirmation(), 201)).mockResolvedValueOnce(taskReply());
    const result = await service.submit({ requestId: "request-test", target, photo: file, permit: conditions.permit }, signal());
    const expectedSha = Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ contract_version: PERSONAL_PREVIEW_CONTRACT, session_id: target.sessionId, look_version_id: target.lookVersionId,
      selection_digest: digest, photo_sha256: expectedSha, confirmed_photo_rights: true, confirmed_ai_reference: true });
    const upload = fetcher.mock.calls[3][1]!; const body = upload.body as FormData;
    expect([...body.keys()]).toEqual(["metadata", "photo"]); expect((body.get("metadata") as Blob).type).toBe("application/json"); const metadata = JSON.parse(await metadataText(body));
    expect(metadata).toEqual({ contract_version: PERSONAL_PREVIEW_CONTRACT, request_id: "request-test", session_id: target.sessionId, look_version_id: target.lookVersionId,
      selection_digest: digest, photo_sha256: expectedSha, confirmation_id: "confirm-test", confirmation_token: token });
    expect(Object.keys(metadata)).not.toContain("owner_key"); expect(Object.keys(metadata)).not.toContain("sku_ids"); expect(Object.keys(metadata)).not.toContain("provider");
    expect((body.get("photo") as File).name).toBe("personal-photo");
    expect(new Headers(upload.headers).has("content-type")).toBe(false); expect(new Headers(upload.headers).has("authorization")).toBe(false);
    expect(result).toMatchObject({ status: "output_pending_review", mode: "mock", hasResult: true, target: { selectionDigest: digest } });
    expect(service.canRetry("request-test")).toBe(false); expect(result.detail).not.toContain(token);
  });
  it("does not accept a forged or already consumed permit", async () => {
    const service = createPersonalPreviewService({ schema }); await permit(service);
    await expect(service.submit({ requestId: "request-test", target, photo: photo(), permit: {} }, signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_REQUEST", definitive: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([[202, true], [200, false]] as const)("keeps a contradictory HTTP %s duplicate=%s reply uncertain without another POST", async (status, duplicate) => {
    const service = createPersonalPreviewService({ schema }); const conditions = await permit(service);
    fetcher.mockResolvedValueOnce(json(confirmation(), 201)).mockResolvedValueOnce(taskReply(status, duplicate));
    await expect(service.submit({ requestId: "request-test", target, photo: photo(), permit: conditions.permit }, signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE", definitive: false });
    expect(service.canRetry("request-test")).toBe(false); expect(fetcher.mock.calls.filter(([, init]) => init?.body instanceof FormData)).toHaveLength(1);
  });
  it.each([
    { selection: selected({}, "b".repeat(64)) }, { selection: selected({ lookVersionId: "other-version" }) },
    { confirmation_token: "not-43-characters" }, { expires_at: "2026-10-10T02:00:01Z" }, { issued_at: "2026-02-30T02:00:00Z" },
    { expires_at: "2026-10-10T02:20:00Z" },
  ])("rejects changed/invalid confirmation before any photo upload %#", async change => {
    const service = createPersonalPreviewService({ schema }); const conditions = await permit(service); fetcher.mockResolvedValueOnce(json(confirmation(change), 201));
    await expect(service.submit({ requestId: "request-test", target, photo: photo(), permit: conditions.permit }, signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE", definitive: true });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(fetcher.mock.calls.every(([, init]) => !(init?.body instanceof FormData))).toBe(true);
  });
  it("never continues from a late confirmation after identity release", async () => {
    const service = createPersonalPreviewService({ schema }); const conditions = await permit(service);
    let resolve!: (value: Response) => void; fetcher.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const submitted = service.submit({ requestId: "request-test", target, photo: photo(), permit: conditions.permit }, signal());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3)); service.releaseSensitive();
    expect(fetcher.mock.calls[2][1]?.signal?.aborted).toBe(true); resolve(json(confirmation(), 201));
    await expect(submitted).rejects.toMatchObject({ code: "PREVIEW_ABORTED" }); expect(fetcher).toHaveBeenCalledTimes(3); expect(service.canRetry("request-test")).toBe(false);
  });
});

describe("original request lookup and explicit original-body retry", () => {
  it("keeps an uncertain upload and requires lookup before explicit identical retry", async () => {
    const { service, caught } = await lostUpload(); expect(caught).toMatchObject({ code: "PREVIEW_NETWORK_ERROR", definitive: false });
    expect(service.canRetry("request-test")).toBe(false); await expect(service.retry("request-test", signal())).rejects.toMatchObject({ code: "PREVIEW_RETRY_UNAVAILABLE" }); expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockResolvedValueOnce(failure("PREVIEW_NOT_FOUND", 404)); expect(await service.findRequest("request-test", signal())).toBeNull(); expect(service.canRetry("request-test")).toBe(true);
    const original = fetcher.mock.calls[3][1]?.body as FormData;
    fetcher.mockResolvedValueOnce(taskReply(200)); await service.retry("request-test", signal()); const replay = fetcher.mock.calls[5][1]?.body as FormData;
    expect(await metadataText(replay)).toBe(await metadataText(original)); expect((replay.get("photo") as File).size).toBe((original.get("photo") as File).size);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/confirmations"))).toHaveLength(1); expect(service.canRetry("request-test")).toBe(false);
  });
  it("an accepted response body read failure remains uncertain and never exposes upstream text", async () => {
    const service = createPersonalPreviewService({ schema }); const conditions = await permit(service); const response = taskReply();
    vi.spyOn(response, "text").mockRejectedValue(new Error(token)); fetcher.mockResolvedValueOnce(json(confirmation(), 201)).mockResolvedValueOnce(response);
    let caught: unknown; try { await service.submit({ requestId: "request-test", target, photo: photo(), permit: conditions.permit }, signal()); } catch (cause) { caught = cause; }
    expect(caught).toMatchObject({ code: "PREVIEW_NETWORK_ERROR", definitive: false }); expect((caught as Error).message).not.toContain(token); expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("404 without an original in-memory File/metadata never permits a task upload", async () => {
    const service = createPersonalPreviewService({ schema }); fetcher.mockResolvedValueOnce(failure("PREVIEW_NOT_FOUND", 404)); expect(await service.findRequest("safe-old-request", signal())).toBeNull();
    expect(service.canRetry("safe-old-request")).toBe(false); await expect(service.retry("safe-old-request", signal())).rejects.toMatchObject({ code: "PREVIEW_RETRY_UNAVAILABLE", definitive: false }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("unknown 404 bodies cannot be interpreted as a retry permission", async () => {
    const { service } = await lostUpload(); fetcher.mockResolvedValueOnce(new Response("not found private detail", { status: 404 }));
    await expect(service.findRequest("request-test", signal())).rejects.toMatchObject({ code: "PREVIEW_HTTP_ERROR" }); expect(service.canRetry("request-test")).toBe(false);
  });
  it("finds an accepted original without another submission and releases its sensitive retry data", async () => {
    const { service } = await lostUpload(); fetcher.mockResolvedValueOnce(json(rawTask())); const result = await service.findRequest("request-test", signal());
    expect(result?.requestId).toBe("request-test"); expect(service.canRetry("request-test")).toBe(false); expect(fetcher.mock.calls.filter(([, init]) => init?.body instanceof FormData)).toHaveLength(1);
  });
  it.each([{ request_id: "wrong-request" }, { selection: selected({ lookVersionId: "other-version" }), look_version_id: "other-version" }, { selection: selected({}, "b".repeat(64)) }])
  ("rejects lookup metadata not matching the original ID/target/digest %#", async change => {
    const { service } = await lostUpload(); fetcher.mockResolvedValueOnce(json(rawTask(change)));
    await expect(service.findRequest("request-test", signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE", definitive: false }); expect(service.canRetry("request-test")).toBe(false);
  });
  it("forbids expired original confirmation retry without generating a new ID", async () => {
    const { service } = await lostUpload(); fetcher.mockResolvedValueOnce(failure("PREVIEW_NOT_FOUND", 404)); await service.findRequest("request-test", signal());
    vi.setSystemTime(new Date("2026-10-10T02:11:00Z")); expect(service.canRetry("request-test")).toBe(false);
    await expect(service.retry("request-test", signal())).rejects.toMatchObject({ code: "PREVIEW_RETRY_UNAVAILABLE" }); expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it.each(["PREVIEW_REQUEST_CONFLICT", "PREVIEW_ACTION_CONFLICT"])("%s does not claim the original ID was never accepted", async code => {
    const { caught } = await lostUpload(code, 409); expect(caught).toMatchObject({ code, status: 409, definitive: false }); expect((caught as Error).message).not.toContain(token);
  });
  it.each([["PREVIEW_CONCURRENCY_LIMIT", 409], ["PREVIEW_DAILY_LIMIT", 429], ["PREVIEW_STORAGE_UNAVAILABLE", 503]] as const)("preserves %s original-body retry after lookup", async (code, status) => {
    const { service, caught } = await lostUpload(code, status); expect(caught).toMatchObject({ code, status, definitive: false }); expect((caught as Error).message).not.toContain(token);
    fetcher.mockResolvedValueOnce(failure("PREVIEW_NOT_FOUND", 404)); await service.findRequest("request-test", signal()); expect(service.canRetry("request-test")).toBe(true);
  });
  it("marks a proven selection rejection definitive and drops its sensitive retry body", async () => {
    const { service, caught } = await lostUpload("PREVIEW_SELECTION_CHANGED", 409); expect(caught).toMatchObject({ definitive: true });
    fetcher.mockResolvedValueOnce(failure("PREVIEW_NOT_FOUND", 404)); await service.findRequest("request-test", signal()); expect(service.canRetry("request-test")).toBe(false);
  });
  it("identity rejection releases all sensitive permits/bodies and keeps safe code/status", async () => {
    const { service } = await lostUpload(); fetcher.mockResolvedValueOnce(failure("PROFILE_OWNER_INVALID", 403));
    await expect(service.findRequest("request-test", signal())).rejects.toMatchObject({ code: "PROFILE_OWNER_INVALID", status: 403, identityInvalid: true });
    expect(service.canRetry("request-test")).toBe(false);
  });
});

describe("bounded history, private results and factual deletion reads", () => {
  it("reads all cursor pages with limit 50 and keeps frozen task versions", async () => {
    fetcher.mockResolvedValueOnce(json({ items: [rawTask()], next_cursor: "cursor-one" })).mockResolvedValueOnce(json({ items: [rawTask({ task_id: "task-two", request_id: "request-two", result_available: false, result_url: null })], next_cursor: null }));
    const result = await createPersonalPreviewService({ schema }).history(signal()); expect(result.map(row => row.id)).toEqual(["task-test", "task-two"]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/v1/personal-preview/tasks?limit=50", "/api/v1/personal-preview/tasks?limit=50&cursor=cursor-one"]);
  });
  it.each(["cursor", "duplicate"])("rejects history %s loops instead of reporting a partial full history", async kind => {
    fetcher.mockResolvedValueOnce(json({ items: [rawTask()], next_cursor: "cursor-one" })).mockResolvedValueOnce(json({ items: kind === "duplicate" ? [rawTask()] : [], next_cursor: kind === "cursor" ? "cursor-one" : null }));
    await expect(createPersonalPreviewService({ schema }).history(signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("enforces a finite page bound", async () => {
    let count = 0; fetcher.mockImplementation(async () => json({ items: [], next_cursor: `cursor-${++count}` }));
    await expect(createPersonalPreviewService({ schema }).history(signal())).rejects.toMatchObject({ code: "PREVIEW_HISTORY_LIMIT" }); expect(fetcher).toHaveBeenCalledTimes(100);
  });
  it.each(["https://provider.invalid/private-result?secret=bad", "//provider.invalid/result", "/api/v1/personal-preview/tasks/other/result"])("rejects an unbound result URL %s", async result_url => {
    fetcher.mockResolvedValueOnce(json(rawTask({ result_url }))); await expect(createPersonalPreviewService({ schema }).task("task-test", signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
  });
  it("reads JPEG only from a fixed authorized route without re-generating", async () => {
    const service = createPersonalPreviewService({ schema }); fetcher.mockResolvedValueOnce(json(rawTask())); const current = await service.task("task-test", signal());
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } }));
    const blob = await service.image(current, signal()); expect(blob.type).toBe("image/jpeg"); expect(blob.size).toBe(4);
    expect(fetcher.mock.calls[1][0]).toBe("/api/v1/personal-preview/tasks/task-test/result"); expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error", credentials: "include" });
  });
  it("preserves result read errors without using another URL or submitting a new task", async () => {
    const service = createPersonalPreviewService({ schema }); fetcher.mockResolvedValueOnce(json(rawTask())); const current = await service.task("task-test", signal()); fetcher.mockResolvedValueOnce(failure("PREVIEW_RESULT_EXPIRED", 410));
    await expect(service.image(current, signal())).rejects.toMatchObject({ code: "PREVIEW_RESULT_EXPIRED", status: 410 }); expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
  it("rejects a private result without no-store rather than treating it as an authorized cached image", async () => {
    const service = createPersonalPreviewService({ schema }); fetcher.mockResolvedValueOnce(json(rawTask())); const current = await service.task("task-test", signal());
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "content-type": "image/jpeg" } }));
    await expect(service.image(current, signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
  });
  it("reads delete receipt, actual deletion and actual task without inventing cleanup success", async () => {
    const service = createPersonalPreviewService({ schema }); fetcher.mockResolvedValueOnce(json(rawTask())); const current = await service.task("task-test", signal());
    fetcher.mockResolvedValueOnce(json({ fixture_task_id: current.id, fixture_status: "deleting" })).mockResolvedValueOnce(json({ fixture_task_id: current.id, fixture_status: "deleted" }))
      .mockResolvedValueOnce(json(rawTask({ deletion_status: "deleted", result_available: false, result_url: null })));
    const deleted = await service.remove(current, "delete-test", signal()); expect(deleted.deletion).toBe("deleted"); expect(deleted.hasResult).toBe(false);
    expect(fetcher.mock.calls.slice(1).map(([url]) => url)).toEqual(["/api/v1/personal-preview/tasks/task-test/delete", "/api/v1/personal-preview/tasks/task-test/deletion", "/api/v1/personal-preview/tasks/task-test"]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ contract_version: PERSONAL_PREVIEW_CONTRACT, delete_action_id: "delete-test" });
  });
  it("does not call an active task deleted when deletion and task facts contradict", async () => {
    const service = createPersonalPreviewService({ schema }); fetcher.mockResolvedValueOnce(json(rawTask())); const current = await service.task("task-test", signal());
    fetcher.mockResolvedValueOnce(json({ fixture_task_id: current.id, fixture_status: "deleted" })).mockResolvedValueOnce(json({ fixture_task_id: current.id, fixture_status: "deleted" })).mockResolvedValueOnce(json(rawTask()));
    await expect(service.remove(current, "delete-test", signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
  });
  it("rejects unexpected task IDs on authorized detail reads", async () => {
    fetcher.mockResolvedValueOnce(json(rawTask({ task_id: "other-task", result_available: false, result_url: null })));
    await expect(createPersonalPreviewService({ schema }).task("task-test", signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
  });
});

describe("publication 1.0.2 frozen task metadata and protected model image", () => {
  it("keeps cleared records beside full records without filling historical content", async () => {
    fetcher.mockResolvedValueOnce(json({ items: [rawTask(), rawTask({ task_id: "cleared-task", request_id: "cleared-request", selection_status: "content_cleared", selection: {}, result_available: false, result_url: null, model_image_url: null })], next_cursor: null }));
    const rows = await createPersonalPreviewService({ schema }).history(signal());
    expect(rows).toHaveLength(2); expect(rows[1]).toMatchObject({ id: "cleared-task", selectionStatus: "content_cleared", target: { sessionId: target.sessionId, lookVersionId: target.lookVersionId, lookId: null, modelUrl: null, versionNo: null, items: [], contentCleared: true } });
    expect(fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["GET"]);
  });
  it.each([
    { selection_status: "content_cleared", selection: { invented: true }, result_available: false, result_url: null },
    { selection_status: "content_cleared", selection: {}, result_available: true },
    { model_image_url: "/api/v1/personal-preview/tasks/another-task/model-image" },
    { model_image_url: "https://external.invalid/private.png" },
    { selection_status: "invented" },
  ])("rejects inconsistent historical metadata %#", async changes => {
    fetcher.mockResolvedValueOnce(json(rawTask(changes)));
    await expect(createPersonalPreviewService({ schema }).task("task-test", signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
  });
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  async function png(headers: Record<string, string> = {}) {
    const sha = Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", pngBytes))).map(byte => byte.toString(16).padStart(2, "0")).join("");
    return new Response(pngBytes, { headers: { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-content-sha256": sha, ...headers } });
  }
  it("checks the frozen model bytes and SHA with one authorized GET and no generation", async () => {
    const service = createPersonalPreviewService({ schema });
    fetcher.mockResolvedValueOnce(json(rawTask({ model_image_url: "/api/v1/personal-preview/tasks/task-test/model-image" })));
    const current = await service.task("task-test", signal()); fetcher.mockResolvedValueOnce(await png());
    const blob = await service.modelImage!(current, signal()); expect(blob.type).toBe("image/png"); expect(blob.size).toBe(pngBytes.length);
    expect(fetcher.mock.calls[1]).toEqual(["/api/v1/personal-preview/tasks/task-test/model-image", expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store", redirect: "error" })]);
    expect(fetcher.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  });
  it.each<Record<string, string>>([{ "x-content-sha256": "f".repeat(64) }, { "x-content-type-options": "" }, { "cache-control": "public" }, { "content-type": "image/jpeg" }])("rejects unchecked model content %#", async headers => {
    const service = createPersonalPreviewService({ schema }); fetcher.mockResolvedValueOnce(json(rawTask({ model_image_url: "/api/v1/personal-preview/tasks/task-test/model-image" })));
    const current = await service.task("task-test", signal()); fetcher.mockResolvedValueOnce(await png(headers));
    await expect(service.modelImage!(current, signal())).rejects.toMatchObject({ code: "PREVIEW_INVALID_RESPONSE" });
    expect(fetcher.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  });
});

describe("instance real quota is a definitive refusal", () => {
  it("discards retry material and explains total quota, without repeating POST", async () => {
    const { service, caught } = await lostUpload("PREVIEW_TOTAL_LIMIT", 429);
    expect(caught).toMatchObject({ code: "PREVIEW_TOTAL_LIMIT", definitive: true }); expect((caught as Error).message).toContain("失败或删除不重置额度");
    expect(service.canRetry("request-test")).toBe(false); const count = fetcher.mock.calls.length;
    await expect(service.retry("request-test", signal())).rejects.toBeInstanceOf(PersonalPreviewApiError); expect(fetcher).toHaveBeenCalledTimes(count);
  });
});
