import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDirectSupplement, directErrorMessage, downloadEvidenceExport, getDirectDelivery, parseDirectDelivery, parseEvidenceExport, reconcileDirectHandoff, registerEvidenceExport, sendDirectHandoff, type DirectHandoffBinding } from "../app/lib/admin-direct-api";

const handoff: DirectHandoffBinding = {
  id: "DH-test", version: 1, approval_identity_kind: "account_bound", source_approval_ref: { approval_record_id: "STAPR-test" },
  metadata: { payload_digest: "a".repeat(64), approved_at: "2026-10-09T01:00:00+00:00", approved_by: "styling-manager-test" },
};
const supplement = { supplement_id: "STSUP-test", digest: "b".repeat(64) };
const when = "2026-10-09T02:00:00.123456+00:00";
const body = { request_id: "action-original", expected_revision: 1, include_supplement: true };
const actionBody = { request_id: "explicit-query", expected_revision: 1 };
function received() {
  return { transport: "direct", delivery_id: "SDLV-test", handoff_id: handoff.id, revision: 1, status: "received", operation_in_progress: false, retry_after_seconds: 0,
    source_instance_id: "styling-local-isolated", target_instance_id: "product-local-isolated", authorized_scope: "direct-pa-s1d-isolated",
    payload_digest: handoff.metadata.payload_digest, source_approval_ref: { ...handoff.source_approval_ref }, first_supplement: { ...supplement },
    receipt: { receipt_schema: "pa-direct-receipt/1", transport_schema: "pa-direct-delivery/1", direct_receive_id: "DPRCV-test", source_product: "personal_styling", target_product: "product_management",
      source_instance_id: "styling-local-isolated", target_instance_id: "product-local-isolated", authorized_scope: "direct-pa-s1d-isolated", handoff_id: handoff.id, revision: 1,
      payload_digest: handoff.metadata.payload_digest, source_approval_ref: { ...handoff.source_approval_ref }, status: "received", received_at: when, verification_id: "STV-test", supplement_id: supplement.supplement_id, supplement_digest: supplement.digest },
    current_supplement: { ...supplement }, last_error: null, supplement_delivery: null,
    attempts: [{ attempt_id: "attempt-test", operation: "send", status: "received", error_code: null, started_at: when, finished_at: when }],
  };
}
function late() {
  const first = received();
  return { ...first, first_supplement: null, receipt: { ...first.receipt, supplement_id: null, supplement_digest: null },
    supplement_delivery: { ...supplement, status: "received", last_error: null,
      receipt: { receipt_schema: "pa-direct-supplement-receipt/1", direct_receive_id: first.receipt.direct_receive_id, ...supplement, received_at: when, verification_id: "STV-late", status: "received" } },
  };
}
const notStarted = () => ({ transport: "direct", handoff_id: handoff.id, revision: 1, status: "not_started", receipt: null, current_supplement: null, supplement_delivery: null, attempts: [] });
const unconfirmed = () => ({ ...received(), status: "unconfirmed", receipt: null, current_supplement: null, last_error: "DIRECT_TIMEOUT", attempts: [{ ...received().attempts[0], status: "unconfirmed", error_code: "DIRECT_TIMEOUT" }] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("strict direct source-ledger DTOs", () => {
  it("accepts the actual minimal not_started shape without invented first-supplement or lease fields", () => {
    expect(parseDirectDelivery(notStarted(), handoff)).toEqual(notStarted());
    expect(parseDirectDelivery(notStarted(), handoff)).not.toHaveProperty("operation_in_progress");
    expect(() => parseDirectDelivery({ ...notStarted(), receipt: {} }, handoff)).toThrow();
    expect(() => parseDirectDelivery({ ...notStarted(), first_supplement: null }, handoff)).toThrow();
  });
  it("requires both the selected account-bound approval and the immutable payload digest", () => {
    expect(parseDirectDelivery(received(), handoff).status).toBe("received");
    expect(() => parseDirectDelivery(received(), { ...handoff, approval_identity_kind: "legacy_shared_role" })).toThrow(/账户绑定/);
    expect(() => parseDirectDelivery(received(), { ...handoff, source_approval_ref: { approval_record_id: "other" } })).toThrow();
    expect(() => parseDirectDelivery(received(), { ...handoff, metadata: { ...handoff.metadata, payload_digest: "c".repeat(64) } })).toThrow();
    expect(() => parseDirectDelivery(received(), { ...handoff, version: 2 })).toThrow();
    expect(() => parseDirectDelivery(received(), { ...handoff, id: "another-DH" })).toThrow();
  });
  it.each(Object.keys(received()))("rejects missing DTO field %s", field => {
    const value: Record<string, unknown> = received(); delete value[field];
    expect(() => parseDirectDelivery(value, handoff)).toThrow();
  });
  it.each([
    ["receipt_schema", "pa-dh-receipt/1"], ["transport_schema", "pa-dh-delivery/1"], ["direct_receive_id", ""],
    ["source_product", "outfit"], ["target_product", "product"], ["source_instance_id", "other-source"], ["target_instance_id", "other-target"], ["authorized_scope", "other-scope"],
    ["handoff_id", "other-DH"], ["revision", 2], ["payload_digest", "c".repeat(64)], ["source_approval_ref", { approval_record_id: "other-approval" }],
    ["status", "unconfirmed"], ["received_at", "2026-02-30T01:00:00Z"], ["verification_id", ""], ["supplement_id", "other-supplement"], ["supplement_digest", "d".repeat(64)],
  ])("rejects initial receipt mismatch at %s even when HTTP/status says received", (field, value) => {
    const dto = received(); Object.assign(dto.receipt, { [field]: value });
    expect(() => parseDirectDelivery(dto, handoff)).toThrow(/回执/);
  });
  it.each(Object.keys(received().receipt))("requires initial receipt field %s", field => {
    const dto = received(); delete (dto.receipt as Record<string, unknown>)[field];
    expect(() => parseDirectDelivery(dto, handoff)).toThrow(/回执/);
  });
  it("refuses unknown/CMS/private fields and invalid UTC times in both receipt types", () => {
    const a = received(); Object.assign(a.receipt, { cms_receive_id: "fake-CMS" });
    expect(() => parseDirectDelivery(a, handoff)).toThrow();
    expect(() => parseDirectDelivery({ ...received(), secret: "private" }, handoff)).toThrow();
    const b = late(); Object.assign(b.supplement_delivery.receipt, { raw_payload: "private" });
    expect(() => parseDirectDelivery(b, handoff)).toThrow();
    const c = received(); c.receipt.received_at = "2026-10-09T02:00:00+08:00";
    expect(() => parseDirectDelivery(c, handoff)).toThrow();
    c.receipt.received_at = "2999-01-01T00:00:00Z";
    expect(() => parseDirectDelivery(c, handoff)).toThrow();
  });
  it("keeps HTTP200 unconfirmed and late unconfirmed separate from the original received fact", () => {
    expect(parseDirectDelivery(unconfirmed(), handoff)).toMatchObject({ status: "unconfirmed", receipt: null });
    const dto = late();
    Object.assign(dto.supplement_delivery, { status: "unconfirmed", receipt: null, last_error: "DIRECT_UNREACHABLE" });
    const parsed = parseDirectDelivery(dto, handoff);
    expect(parsed).toMatchObject({ status: "received", receipt: { supplement_id: null, supplement_digest: null }, supplement_delivery: { status: "unconfirmed", receipt: null } });
  });
  it.each([
    ["receipt_schema", "pa-direct-receipt/1"], ["direct_receive_id", "another-receiver"], ["supplement_id", "another-supplement"],
    ["digest", "d".repeat(64)], ["received_at", "invalid"], ["verification_id", ""], ["status", "sending"],
  ])("requires late receipt exact %s binding independently of the initial receipt", (field, value) => {
    const dto = late(); Object.assign(dto.supplement_delivery.receipt, { [field]: value });
    expect(() => parseDirectDelivery(dto, handoff)).toThrow(/回执/);
  });
  it.each(Object.keys(late().supplement_delivery.receipt))("rejects missing late receipt field %s", field => {
    const dto = late(); delete (dto.supplement_delivery.receipt as Record<string, unknown>)[field];
    expect(() => parseDirectDelivery(dto, handoff)).toThrow(/回执/);
  });
  it("never moves late supplementation into the first receipt or invents current supplementation", () => {
    expect(parseDirectDelivery(late(), handoff)).toMatchObject({ first_supplement: null, receipt: { supplement_id: null }, supplement_delivery: { status: "received" } });
    const dto = late(); Object.assign(dto.receipt, { supplement_id: supplement.supplement_id, supplement_digest: supplement.digest });
    expect(() => parseDirectDelivery(dto, handoff)).toThrow();
    expect(() => parseDirectDelivery({ ...received(), current_supplement: null }, handoff)).toThrow();
    expect(() => parseDirectDelivery({ ...late(), current_supplement: { ...supplement, digest: "d".repeat(64) } }, handoff)).toThrow();
  });
  it("preserves independent lease states and rejects unsafe/unknown attempt payloads", () => {
    expect(parseDirectDelivery({ ...unconfirmed(), operation_in_progress: true, retry_after_seconds: 20 }, handoff)).toMatchObject({ retry_after_seconds: 20 });
    expect(() => parseDirectDelivery({ ...received(), retry_after_seconds: 5 }, handoff)).toThrow();
    expect(() => parseDirectDelivery({ ...received(), attempts: [{ ...received().attempts[0], raw_body: "private" }] }, handoff)).toThrow();
    expect(() => parseDirectDelivery({ ...received(), attempts: [received().attempts[0], received().attempts[0]] }, handoff)).toThrow();
  });
});

describe("explicit manager direct API", () => {
  it.each([[422, "不符合服务端要求"], [503, "接收尚未确认"]] as const)("gives safe Chinese guidance for unmapped HTTP %s codes", (status, message) => {
    expect(directErrorMessage("NEW_BACKEND_FAILURE", status)).toContain(message);
  });
  it("GET only reads the source ledger and transmits no machine data", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(notStarted())); vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect(await getDirectDelivery(handoff, signal)).toEqual(notStarted());
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/admin/handoffs/${handoff.id}/direct-delivery`, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  });
  it("sends only the explicit body and preserves the same complete action on an explicit repeat", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json(unconfirmed()))); vi.stubGlobal("fetch", fetcher);
    expect((await sendDirectHandoff(handoff, body)).status).toBe("unconfirmed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await sendDirectHandoff(handoff, body);
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body);
  });
  it.each(["url", "scope", "secret", "approved_by", "source_approval_ref"])("rejects extra action field %s before network", async field => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(sendDirectHandoff(handoff, { ...body, [field]: "forbidden" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reconcile and supplement send separate exact actions without silently re-sending a package", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(unconfirmed())).mockResolvedValueOnce(json(late())); vi.stubGlobal("fetch", fetcher);
    await reconcileDirectHandoff(handoff, actionBody); await appendDirectSupplement(handoff, { ...actionBody, request_id: "explicit-late" });
    expect(fetcher.mock.calls.map(c => c[0])).toEqual([`/api/v1/admin/handoffs/${handoff.id}/direct-reconcile`, `/api/v1/admin/handoffs/${handoff.id}/direct-supplement`]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(actionBody);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not retry transport failures, preserves safe backend codes, and rejects malformed success", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("secret internal"))
      .mockResolvedValueOnce(json({ error: { code: "DIRECT_REVISION_CONFLICT", message: "private token secret" } }, 409))
      .mockResolvedValueOnce(json({ status: "received" })); vi.stubGlobal("fetch", fetcher);
    await expect(sendDirectHandoff(handoff, body)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(reconcileDirectHandoff(handoff, actionBody)).rejects.toMatchObject({ status: 409, code: "DIRECT_REVISION_CONFLICT", message: expect.stringContaining("修订") });
    await expect(getDirectDelivery(handoff)).rejects.toMatchObject({ code: "DIRECT_RESPONSE_INVALID" });
  });
  it("aborts without mapping logout/unmount cancellation into a successful response", async () => {
    const aborted = new DOMException("Aborted", "AbortError"); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
    await expect(getDirectDelivery(handoff)).rejects.toBe(aborted);
  });
});

function projection() {
  return { supplement_schema: "pa-frozen-evidence/1", handoff_id: handoff.id, revision: 1, payload_digest: handoff.metadata.payload_digest,
    approved_at: handoff.metadata.approved_at, approved_by: handoff.metadata.approved_by, window_start: null, window_end: "2026-10-09T00:00:00Z",
    evidence_revisions: { occurrence: 1 }, evidence_digest: "d".repeat(64), evidence_digest_version: "resolved-sources-v1", source_snapshot: [], provenance: {},
    source_proof: { kind: "approved_metadata_projection", metadata_digest: "e".repeat(64), exported_by: "outfit-sender-test" },
  };
}
function exportFixture(value: unknown = projection()) {
  const raw = `\n${JSON.stringify(value, null, 2)}\n\n`;
  const digest = createHash("sha256").update(raw).digest("hex");
  const registration = { ...supplement, digest, handoff_id: handoff.id, revision: 1, metadata_digest: "e".repeat(64), rule_version: "styling-frozen-redaction-v1" as const, status: "registered" as const };
  return { raw, digest, registration, response: () => new Response(raw, { headers: { "content-type": "application/json; charset=utf-8", "x-content-sha256": digest } }) };
}
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob); });
}
describe("frozen evidence original bytes", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto));
  it("registers only on explicit bodyless POST, downloads by GET, and retains exact whitespace bytes", async () => {
    const fixture = exportFixture(); const fetcher = vi.fn().mockResolvedValueOnce(json(fixture.registration)).mockResolvedValueOnce(fixture.response()); vi.stubGlobal("fetch", fetcher);
    const registered = await registerEvidenceExport(handoff); expect(registered).toEqual(fixture.registration);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST" }); expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body");
    const downloaded = await downloadEvidenceExport(handoff, registered);
    expect(new TextDecoder().decode(await readBlob(downloaded.blob))).toBe(fixture.raw);
    expect(downloaded.digest).toBe(fixture.digest); expect(downloaded.fileName).toBe("STSUP-test.evidence.json");
    expect(fetcher.mock.calls[1][1].method).toBe("GET");
  });
  it.each(["digest", "handoff_id", "revision", "metadata_digest", "rule_version", "status", "supplement_id"])("rejects invalid registration %s", field => {
    const value = exportFixture().registration;
    const bad = { ...value, [field]: field === "revision" ? 2 : field === "handoff_id" ? "other" : field === "supplement_id" ? "" : "invalid" };
    expect(() => parseEvidenceExport(bad, handoff)).toThrow();
  });
  it("rejects nonmatching header/bytes/registration and never substitutes JSON reserialization", async () => {
    const fixture = exportFixture(); const badHeader = fixture.response(); badHeader.headers.set("x-content-sha256", "0".repeat(64));
    const wrongBytes = new Response(fixture.raw + " ", { headers: { "content-type": "application/json", "x-content-sha256": fixture.digest } });
    const fetcher = vi.fn().mockResolvedValueOnce(badHeader).mockResolvedValueOnce(wrongBytes); vi.stubGlobal("fetch", fetcher);
    await expect(downloadEvidenceExport(handoff, fixture.registration)).rejects.toMatchObject({ code: "DIRECT_RESPONSE_INVALID" });
    await expect(downloadEvidenceExport(handoff)).rejects.toMatchObject({ code: "DIRECT_RESPONSE_INVALID" });
  });
  it.each(["handoff_id", "revision", "payload_digest", "approved_by", "approved_at", "supplement_schema"])("rejects original projection mismatched %s despite a self-consistent hash", async field => {
    const bad = { ...projection(), [field]: field === "revision" ? 2 : "other" }; const fixture = exportFixture(bad);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixture.response()));
    await expect(downloadEvidenceExport(handoff)).rejects.toMatchObject({ code: "DIRECT_RESPONSE_INVALID" });
  });
  it("keeps unregistered404 and privacy422 as failures with their actual codes", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: { code: "EVIDENCE_EXPORT_NOT_FOUND" } }, 404)).mockResolvedValueOnce(json({ error: { code: "EVIDENCE_PRIVACY_BLOCKED" } }, 422)); vi.stubGlobal("fetch", fetcher);
    await expect(downloadEvidenceExport(handoff)).rejects.toMatchObject({ status: 404, code: "EVIDENCE_EXPORT_NOT_FOUND" });
    await expect(registerEvidenceExport(handoff)).rejects.toMatchObject({ status: 422, code: "EVIDENCE_PRIVACY_BLOCKED" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
afterEach(() => vi.unstubAllGlobals());

const contextBody = { admin_action_contract: "styling_admin_action_v1" as const,
  request_id: "00000000-0000-4000-8000-000000000001", expected_revision: 1,
  expected_admin_context: { context_contract: "styling_admin_context_v1" as const, context_id: "a".repeat(43) } };
function contextJson(value: unknown, requestId = contextBody.request_id) {
  const response = json(value);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-styling-admin-action-contract", "styling_admin_action_v1");
  response.headers.set("x-styling-admin-request-id", requestId);
  return response;
}
describe("context-bound direct API compatibility", () => {
  it("accepts actual new transmission actor while retaining missing historical identity and not-started null", () => {
    expect(parseDirectDelivery(received(), handoff)).not.toHaveProperty("transmission_actor_subject");
    expect(parseDirectDelivery({ ...received(), transmission_actor_subject: "sender:A@local" }, handoff)).toHaveProperty("transmission_actor_subject", "sender:A@local");
    expect(parseDirectDelivery({ ...notStarted(), transmission_actor_subject: null }, handoff)).toHaveProperty("transmission_actor_subject", null);
    expect(() => parseDirectDelivery({ ...notStarted(), transmission_actor_subject: "current-user" }, handoff)).toThrow();
    expect(() => parseDirectDelivery({ ...received(), transmission_actor_subject: null }, handoff)).toThrow();
    expect(() => parseDirectDelivery({ ...received(), transmission_actor_subject: "bad actor" }, handoff)).toThrow();
  });
  it("records dispatch-before invalidation as not_sent, never received", () => {
    const dto = unconfirmed(); dto.attempts[0].status = "not_sent"; dto.attempts[0].error_code = "ADMIN_AUTH_CONTEXT_CHANGED";
    expect(parseDirectDelivery(dto, handoff)).toMatchObject({ status: "unconfirmed", receipt: null, attempts: [{ status: "not_sent" }] });
  });
  it("transmits each of the four context action bodies exactly and keeps original context on explicit replay", async () => {
    const fixture = exportFixture();
    const fetcher = vi.fn().mockResolvedValueOnce(contextJson(received())).mockResolvedValueOnce(contextJson(received()))
      .mockResolvedValueOnce(contextJson(received())).mockResolvedValueOnce(contextJson(late())).mockResolvedValueOnce(contextJson(fixture.registration));
    vi.stubGlobal("fetch", fetcher);
    const sendBody = { ...contextBody, include_supplement: false };
    await sendDirectHandoff(handoff, sendBody); await sendDirectHandoff(handoff, sendBody);
    await reconcileDirectHandoff(handoff, contextBody); await appendDirectSupplement(handoff, contextBody);
    await registerEvidenceExport(handoff, contextBody);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(sendBody);
    expect(JSON.parse(fetcher.mock.calls[4][1].body)).toEqual(contextBody);
    expect(fetcher.mock.calls.map(c => c[0].split("/").at(-1))).toEqual(["direct-send", "direct-send", "direct-reconcile", "direct-supplement", "evidence-export"]);
  });
  it.each([
    { admin_action_contract: "wrong" }, { request_id: "UPPER-LEGACY" }, { expected_admin_context: null },
    { expected_admin_context: { context_contract: "styling_admin_context_v1", context_id: "x" } },
    { expected_admin_context: { context_contract: "styling_admin_context_v1", context_id: "a".repeat(43), subject: "injected" } },
    { include_supplement: "true" }, { url: "http://other.invalid" },
  ])("rejects altered strict context action before POST: %j", async patch => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(sendDirectHandoff(handoff, { ...contextBody, include_supplement: true, ...patch } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["cache-control", "x-styling-admin-action-contract", "x-styling-admin-request-id"])("rejects successful response missing correlated %s", async header => {
    const response = contextJson(received()); response.headers.delete(header);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(sendDirectHandoff(handoff, { ...contextBody, include_supplement: true })).rejects.toMatchObject({ code: "DIRECT_RESPONSE_INVALID" });
  });
  it("rejects duplicate response keys before a JSON parser can discard them", async () => {
    const response = contextJson(received()); const raw = JSON.stringify(received()).replace('"status":"received"', '"status":"unconfirmed","status":"received"');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(raw, { headers: response.headers })));
    await expect(sendDirectHandoff(handoff, { ...contextBody, include_supplement: true })).rejects.toMatchObject({ code: "DIRECT_RESPONSE_INVALID" });
  });
  it.each(["ADMIN_AUTH_CONTEXT_CHANGED", "ADMIN_ACTION_CONTEXT_CONFLICT", "ADMIN_ACTION_IN_PROGRESS", "ADMIN_ACTION_LEGACY_UNBOUND", "ADMIN_OPERATION_NOT_FOUND"])("preserves %s instead of falling back to legacy send", async code => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: { code, message: "private context", retryable: false } }, code === "ADMIN_OPERATION_NOT_FOUND" ? 404 : 409)); vi.stubGlobal("fetch", fetcher);
    await expect(sendDirectHandoff(handoff, { ...contextBody, include_supplement: true })).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
