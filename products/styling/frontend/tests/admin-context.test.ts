import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminError, responseError } from "@/app/lib/admin-api";
import {
  ADMIN_ACTION_CONTRACT, adminActionBodyDigest, adminIdentityNamespace, adminOperationMatchesAction, canReplayAdminAction, canonicalAdminAction, createAdminAction,
  executeAdminAction, getAdminIdentity, getAdminOperation, parseAdminIdentity, parseAdminJson,
  parseAdminOperation, parseStoredAdminAction, readAdminContextResource, sameAdminIdentity, serializeAdminAction,
  type AdminIdentity, type AdminOperation,
} from "@/app/lib/admin-context";

const requestId = "00000000-0000-4000-8000-000000000001";
const identity = (changes: Partial<AdminIdentity> = {}): AdminIdentity => ({
  identity_contract: "styling_admin_identity_v1", subject: "technical.A", role: "styling-manager",
  audience: "personal_styling", scope: "isolated.scope", source_instance_id: "styling.instance",
  auth_method: "password_single_account", approval_identity_kind: "account_bound",
  expires_at: "2026-10-10T07:00:00.123456Z",
  authorization_context: { context_contract: "styling_admin_context_v1", context_id: "a".repeat(43), expires_at: "2026-10-10T07:00:00.123456Z" },
  ...changes,
});
const operation = (changes: Partial<AdminOperation> = {}): AdminOperation => ({
  operation_contract: ADMIN_ACTION_CONTRACT, request_id: requestId, actor_subject: "technical.A", operation_kind: "reject",
  context_binding: "bound", operation_context_ref: createHash("sha256").update("a".repeat(43)).digest("hex"),
  body_digest: createHash("sha256").update(canonicalAdminAction(rejectAction())).digest("hex"), state: "completed", outcome: "completed",
  accepted_at: "2026-10-10T00:00:00.123456Z", completed_at: "2026-10-10T00:00:01Z",
  result_ref: { kind: "demand_occurrence", id: "occurrence-1", revision: 2 }, ...changes,
});
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
});
const actionResponse = (body: unknown, headers: Record<string, string> = {}) => response(body, 200, {
  "x-styling-admin-action-contract": ADMIN_ACTION_CONTRACT, "x-styling-admin-request-id": requestId, ...headers,
});
const rejectAction = () => createAdminAction(identity(), "occurrences/occurrence-1/reject", { note: "人工核对后排除", expected_revision: 1 }, requestId);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("strict private JSON and trusted me", () => {
  it("reads nested values without losing escaped Unicode or accepting duplicate escaped keys", () => {
    expect(parseAdminJson('{"value":[true,null,-1.5e2,"中文\\u0020名字",{"key":"a\\\"b"}]}')).toEqual({ value: [true, null, -150, "中文 名字", { key: 'a"b' }] });
    for (const raw of ['{"subject":"A","\\u0073ubject":"B"}', '{"a":{"context_id":"A","context_id":"B"}}', '{"a":1,"a":2}', '{"a":1,}', '[1,]', '1e999', 'NaN', '{}x']) {
      expect(() => parseAdminJson(raw)).toThrow(AdminError);
    }
  });

  it.each([
    { extra: "untrusted" }, { identity_contract: "unknown" }, { approval_identity_kind: "legacy_shared_role" },
    { subject: "" }, { scope: true }, { source_instance_id: "../elsewhere" }, { expires_at: "2026-02-30T00:00:00Z" },
    { authorization_context: { ...identity().authorization_context, expires_at: "2026-10-10T07:00:01Z" } },
    { authorization_context: { ...identity().authorization_context, context_id: "a".repeat(42) } },
    { authorization_context: { ...identity().authorization_context, extra: "session" } },
    { expires_at: "2026-10-10T07:00:00+00:00", authorization_context: { ...identity().authorization_context, expires_at: "2026-10-10T07:00:00+00:00" } },
  ])("rejects malformed or unknown identity facts: %j", changes => {
    expect(parseAdminIdentity({ ...identity(), ...changes })).toBeNull();
  });

  it("gets and freezes me only through a private no-store browser request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(identity())); vi.stubGlobal("fetch", fetchMock);
    const current = await getAdminIdentity();
    expect(current).toEqual(identity()); expect(Object.isFrozen(current.authorization_context)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/me", expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" }));
  });

  it.each(["2026-10-10T00:00:00Z", "2026-10-10T08:00:01Z"])("fails closed on expired or over-eight-hour identity %s", async expires_at => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(identity({ expires_at, authorization_context: { ...identity().authorization_context, expires_at } }))));
    await expect(getAdminIdentity()).rejects.toBeInstanceOf(AdminError);
  });

  it("missing me or malformed headers never tries another mode or endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ detail: "Not Found" }, 404))
      .mockResolvedValueOnce(response(identity(), 200, { "cache-control": "public" }))
      .mockResolvedValueOnce(new Response(JSON.stringify(identity()).replace('"subject":"technical.A"', '"subject":"technical.A","\\u0073ubject":"other"'), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAdminIdentity()).rejects.toMatchObject({ status: 404 });
    await expect(getAdminIdentity()).rejects.toMatchObject({ code: "INVALID_ADMIN_RESPONSE" });
    await expect(getAdminIdentity()).rejects.toMatchObject({ code: "INVALID_ADMIN_RESPONSE" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(3).fill("/api/v1/admin/me"));
  });

  it("namespaces every source, scope, subject and context independently", () => {
    const current = identity(); const original = adminIdentityNamespace(current);
    for (const changed of [identity({ source_instance_id: "other.instance" }), identity({ scope: "other.scope" }), identity({ subject: "other.A" }), identity({ authorization_context: { ...current.authorization_context, context_id: "b".repeat(43) } })]) {
      expect(adminIdentityNamespace(changed)).not.toBe(original); expect(sameAdminIdentity(current, changed)).toBe(false);
    }
    expect(sameAdminIdentity(current, identity())).toBe(true);
    expect(sameAdminIdentity(current, null)).toBe(false);
  });
});

describe("personal operation metadata, separate from business DTO", () => {
  it("accepts bound completed and pending facts, and genuinely old pending DIRECT metadata", () => {
    expect(parseAdminOperation(operation(), requestId, identity())).toEqual(operation());
    expect(parseAdminOperation(operation({ state: "pending", outcome: null, completed_at: null, result_ref: null }))).not.toBeNull();
    const old = operation({ request_id: "old.direct:1", operation_kind: "direct_send", context_binding: "legacy_unbound", operation_context_ref: null, body_digest: null, accepted_at: null, completed_at: null, state: "pending", outcome: null, result_ref: { kind: "direct_delivery", id: "DEL-old", revision: 1 } });
    expect(parseAdminOperation(old)).toEqual(old);
  });

  it.each([
    { private_body: "forbidden" }, { request_id: "non.uuid" }, { context_binding: "unknown" }, { operation_context_ref: null },
    { body_digest: "B".repeat(64) }, { accepted_at: null }, { completed_at: null },
    { completed_at: "2026-10-10T00:00:00.123455Z" }, { state: "pending" }, { outcome: "failed" },
    { result_ref: { kind: "demand_occurrence", id: "occurrence-1", revision: true } },
    { result_ref: { kind: "demand_occurrence", id: "occurrence-1", revision: 1, session_id: "forbidden" } },
    { operation_kind: "logout" }, { state: "unconfirmed", outcome: "received" },
  ])("rejects contradictory metadata without type coercion: %j", changes => {
    expect(parseAdminOperation({ ...operation(), ...changes })).toBeNull();
  });

  it("GET associates the exact original request and current trusted actor", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(operation())).mockResolvedValueOnce(response(operation({ actor_subject: "other.A" }))).mockResolvedValueOnce(response(operation({ request_id: "00000000-0000-4000-8000-000000000002" })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAdminOperation(requestId, identity())).resolves.toEqual(operation());
    await expect(getAdminOperation(requestId, identity())).rejects.toMatchObject({ code: "INVALID_ADMIN_RESPONSE" });
    await expect(getAdminOperation(requestId, identity())).rejects.toMatchObject({ code: "INVALID_ADMIN_RESPONSE" });
    expect(fetchMock.mock.calls.every(([, options]) => options.method === "GET" && options.body === undefined)).toBe(true);
  });

  it("preserves legitimately missing result references and revisions as explicit null", () => {
    expect(parseAdminOperation(operation({ result_ref: null }))).not.toBeNull();
    expect(parseAdminOperation(operation({ result_ref: { kind: "demand_occurrence", id: "occurrence-1", revision: null } }))).not.toBeNull();
  });

  it("a metadata 404 is unknown and never authorizes a POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: { code: "ADMIN_OPERATION_NOT_FOUND", message: "untrusted", retryable: false } }, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAdminOperation("old.direct:1", identity())).rejects.toMatchObject({ status: 404, code: "ADMIN_OPERATION_NOT_FOUND", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/admin/operations/old.direct%3A1");
  });
});

describe("original management intent is immutable and narrowly permitted", () => {
  it.each([
    ["groups/group-1/approve", { note: "人工逐条核对", days: 0, expected_occurrence_ids: ["occurrence-1"], expected_revisions: { "occurrence-1": 1 }, expected_evidence_digest: "a".repeat(64), window_end: "2026-10-10T00:00:00.123456Z" }, "approve"],
    ["occurrences/occurrence-1/reject", { note: "理由已核对", expected_revision: 1 }, "reject"],
    ["turns/turn-1/retry", {}, "retry"], ["handoffs/DH-1/evidence-export", { expected_revision: 1 }, "evidence_export"],
    ["handoffs/DH-1/direct-send", { expected_revision: 1, include_supplement: true }, "direct_send"],
    ["handoffs/DH-1/direct-reconcile", { expected_revision: 1 }, "direct_reconcile"],
    ["handoffs/DH-1/direct-supplement", { expected_revision: 1 }, "direct_supplement"], ["logout", {}, "logout"],
  ] as const)("binds %s to the same exact original context and canonical UUID", (path, business, kind) => {
    const original = createAdminAction(identity(), path, business, requestId);
    expect(original.kind).toBe(kind); expect(original.operation_kind).toBe(kind);
    expect(original.body).toEqual({ ...business, admin_action_contract: ADMIN_ACTION_CONTRACT, request_id: requestId, expected_admin_context: { context_contract: "styling_admin_context_v1", context_id: "a".repeat(43) } });
    expect(JSON.parse(original.body_json)).toEqual(original.body);
    expect(Object.isFrozen(original.body)).toBe(true);
    expect(parseStoredAdminAction(serializeAdminAction(original))).toEqual(original);
  });

  it.each([
    ["handoffs/DH-1/send", {}], ["occurrences/occurrence-1/restore", { note: "尝试恢复" }], ["../logout", {}],
    ["logout?scope=elsewhere", {}], ["logout", { subject: "other" }], ["turns/turn-1/retry", { expected_revision: 1 }],
    ["handoffs/DH-1/direct-send", { expected_revision: true }], ["handoffs/DH-1/direct-send", { expected_revision: 1, include_supplement: "true" }],
    ["occurrences/occurrence-1/reject", { note: "理由正常", expected_admin_context: { context_id: "b".repeat(43) } }],
  ])("never offers an unlisted or malformed write: %s", (path, body) => {
    expect(() => createAdminAction(identity(), path as string, body as Record<string, unknown>, requestId)).toThrow(AdminError);
  });

  it("does not silently drop undefined/non-finite intent or allow malformed approval sets", () => {
    for (const body of [{ note: "核对理由", unused: undefined }, { note: "核对理由", expected_revision: Infinity }, { note: "核对理由", expected_revision: 1.5 }]) {
      expect(() => createAdminAction(identity(), "occurrences/occurrence-1/reject", body, requestId)).toThrow(AdminError);
    }
    expect(() => createAdminAction(identity(), "groups/group-1/approve", { note: "人工核对", days: 7, expected_occurrence_ids: ["a", "a"], expected_revisions: { a: 1 }, expected_evidence_digest: "b".repeat(64), window_start: "2026-10-03T00:00:00Z", window_end: "2026-10-10T00:00:00Z" }, requestId)).toThrow(AdminError);
  });

  it("serialized pending survives reload without adopting a new context, body or ID", () => {
    const original = rejectAction(); const raw = serializeAdminAction(original);
    const restored = parseStoredAdminAction(raw, identity())!;
    expect(restored.body_json).toBe(original.body_json); expect(restored.request_id).toBe(requestId);
    expect(parseStoredAdminAction(raw, identity({ authorization_context: { ...identity().authorization_context, context_id: "b".repeat(43) } }))).toBeNull();
    expect(parseStoredAdminAction({ ...original, request_id: "00000000-0000-4000-8000-000000000002" })).toBeNull();
    expect(parseStoredAdminAction({ ...original, body_json: original.body_json.replace("人工核对后排除", "另一个理由") })).toBeNull();
    expect(parseStoredAdminAction(raw.replace('"kind":"reject"', '"kind":"reject","\\u006bind":"reject"'))).toBeNull();
    vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
    expect(parseStoredAdminAction(raw)).not.toBeNull();
  });

  it("posts the original frozen body and checks headers before exposing a business DTO", async () => {
    const original = rejectAction(); const fetchMock = vi.fn().mockResolvedValue(actionResponse({ status: "rejected", revision: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeAdminAction(original)).resolves.toEqual({ status: "rejected", revision: 2 });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/occurrences/occurrence-1/reject", expect.objectContaining({ method: "POST", body: original.body_json, cache: "no-store", credentials: "same-origin", redirect: "error" }));
  });

  const invalidActionHeaders: Record<string, string>[] = [
    { "x-styling-admin-request-id": "00000000-0000-4000-8000-000000000002" },
    { "x-styling-admin-action-contract": "unknown" }, { "cache-control": "private" },
  ];
  it.each(invalidActionHeaders)("rejects success-looking wrong response linkage: %j", async headers => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(actionResponse({ status: "rejected", revision: 2 }, headers)));
    await expect(executeAdminAction(rejectAction())).rejects.toMatchObject({ code: "INVALID_ADMIN_RESPONSE" });
  });

  it("does not convert an HTTP200 extraction failure into success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(actionResponse({ id: "turn-1", status: "extraction_failed", extraction_attempts: 4, error_code: "EXTRACTION_FAILED" })));
    await expect(executeAdminAction(createAdminAction(identity(), "turns/turn-1/retry", {}, requestId))).rejects.toMatchObject({ status: 200, code: "ADMIN_EXTRACTION_FAILED" });
  });

  it("accepts the actual successful retry DTO's empty error_code", async () => {
    const dto = { id: "turn-1", status: "extracted", extraction_attempts: 4, error_code: "" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(actionResponse(dto)));
    await expect(executeAdminAction(createAdminAction(identity(), "turns/turn-1/retry", {}, requestId))).resolves.toEqual(dto);
  });

  it("checks evidence/object revision and preserves unconfirmed DIRECT state for its separate strict validator", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(actionResponse({ supplement_id: "SUP-1", digest: "a".repeat(64), metadata_digest: "b".repeat(64), handoff_id: "DH-other", revision: 1, rule_version: "1", status: "registered" }))
      .mockResolvedValueOnce(actionResponse({ transport: "direct", handoff_id: "DH-1", revision: 1, status: "unconfirmed" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeAdminAction(createAdminAction(identity(), "handoffs/DH-1/evidence-export", { expected_revision: 1 }, requestId))).rejects.toMatchObject({ code: "INVALID_ADMIN_RESPONSE" });
    const validate = vi.fn((value: unknown) => { expect(value).toMatchObject({ status: "unconfirmed" }); return { state: "unconfirmed" }; });
    await expect(executeAdminAction(createAdminAction(identity(), "handoffs/DH-1/direct-send", { expected_revision: 1 }, requestId), undefined, validate)).resolves.toEqual({ state: "unconfirmed" });
    expect(validate).toHaveBeenCalledTimes(1);
  });
});

describe("read-only recovery and explicit original-body replay gate", () => {
  it("canonicalizes decoded paths, omitted Review defaults and Pydantic UTC microseconds", async () => {
    const original = createAdminAction(identity(), "occurrences/occurrence%3A1/reject", { note: "保留中文理由", window_start: "2026-10-03T00:00:00.123+00:00", window_end: "2026-10-10T00:00:00.000000Z" }, requestId);
    const expected = '{"body":{"admin_action_contract":"styling_admin_action_v1","days":7,"expected_admin_context":{"context_contract":"styling_admin_context_v1","context_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"expected_evidence_digest":null,"expected_occurrence_ids":[],"expected_revision":null,"expected_revisions":null,"note":"保留中文理由","request_id":"00000000-0000-4000-8000-000000000001","window_end":"2026-10-10T00:00:00Z","window_start":"2026-10-03T00:00:00.123000Z"},"method":"POST","path":"/api/v1/admin/occurrences/occurrence:1/reject"}';
    expect(canonicalAdminAction(original)).toBe(expected);
    // Golden from Python stdlib JSON sort_keys/ensure_ascii=False + UTF-8 SHA256.
    await expect(adminActionBodyDigest(original)).resolves.toBe("45240fa2b214c1721dfef1426a273db90206ef9b0d83e4a16a3e8d3f2e47d780");
    expect(original.body.window_start).toBe("2026-10-03T00:00:00.123+00:00");
  });

  it("sorts numeric-looking revision keys lexically, without JavaScript integer-key reordering", async () => {
    const original = createAdminAction(identity(), "groups/group-1/approve", { note: "数字来源核对", days: 0, expected_occurrence_ids: ["10", "2"], expected_revisions: { "2": 2, "10": 1 }, expected_evidence_digest: "a".repeat(64), window_end: "2026-10-10T00:00:00Z" }, requestId);
    expect(canonicalAdminAction(original)).toContain('"expected_revisions":{"10":1,"2":2}');
    expect(canonicalAdminAction(original)).not.toContain('"expected_revisions":{"2":2,"10":1}');
    await expect(adminActionBodyDigest(original)).resolves.toBe("7b44b733e3d0901ce8271196a7934e0c37ae2dfdf7d408ccacd5f03eda4b28e2");
    const direct = createAdminAction(identity(), "handoffs/DH%3A1/direct-send", { expected_revision: 1 }, requestId);
    expect(canonicalAdminAction(direct)).toContain('"include_supplement":true');
    expect(canonicalAdminAction(direct)).toContain('"path":"/api/v1/admin/handoffs/DH:1/direct-send"');
    expect(direct.body).not.toHaveProperty("include_supplement");
    await expect(adminActionBodyDigest(direct)).resolves.toHaveLength(64);
  });

  it("only same-context bound nonpending personal metadata permits explicit replay", async () => {
    const original = rejectAction();
    await expect(canReplayAdminAction(original, identity(), operation())).resolves.toBe(true);
    for (const blocked of [operation({ state: "pending", outcome: null, completed_at: null, result_ref: null }), operation({ operation_context_ref: "f".repeat(64) }), operation({ body_digest: "f".repeat(64) }), operation({ actor_subject: "other.A" }), operation({ request_id: "00000000-0000-4000-8000-000000000002" }), operation({ operation_kind: "approve", result_ref: { kind: "handoff", id: "DH-1", revision: 1 } })]) {
      await expect(canReplayAdminAction(original, identity(), blocked)).resolves.toBe(false);
    }
    await expect(canReplayAdminAction(original, identity({ authorization_context: { ...identity().authorization_context, context_id: "b".repeat(43) } }), operation())).resolves.toBe(false);
    await expect(adminOperationMatchesAction(original, identity({ authorization_context: { ...identity().authorization_context, context_id: "b".repeat(43) } }), operation())).resolves.toBe(true);
  });

  it("metadata matching rejects changed kind/context/body and accepts correct pending only as read facts", async () => {
    const original = rejectAction();
    const pending = operation({ state: "pending", outcome: null, completed_at: null, result_ref: null });
    await expect(adminOperationMatchesAction(original, identity(), pending)).resolves.toBe(true);
    await expect(canReplayAdminAction(original, identity(), pending)).resolves.toBe(false);
    for (const changed of [operation({ operation_kind: "retry", result_ref: { kind: "demand_turn", id: "turn-1", revision: null } }), operation({ operation_context_ref: "f".repeat(64) }), operation({ body_digest: "f".repeat(64) })]) {
      await expect(adminOperationMatchesAction(original, identity(), changed)).resolves.toBe(false);
    }
  });

  it("completed metadata must retain the actual operation's business outcome and reference kind", async () => {
    const original = rejectAction();
    for (const changed of [operation({ outcome: "received" }), operation({ result_ref: { kind: "demand_turn", id: "occurrence-1", revision: 2 } }), operation({ result_ref: { kind: "demand_occurrence", id: "other-occurrence", revision: 2 } })]) {
      await expect(adminOperationMatchesAction(original, identity(), changed)).resolves.toBe(false);
    }
    const direct = createAdminAction(identity(), "handoffs/DH-1/direct-send", { expected_revision: 1 }, requestId);
    const body_digest = await adminActionBodyDigest(direct);
    const actual = operation({ operation_kind: "direct_send", body_digest, outcome: "received", result_ref: { kind: "direct_delivery", id: "DEL-1", revision: 1 } });
    await expect(adminOperationMatchesAction(direct, identity(), actual)).resolves.toBe(true);
    await expect(adminOperationMatchesAction(direct, identity(), { ...actual, result_ref: { ...actual.result_ref!, revision: 2 } })).resolves.toBe(false);
  });

  it("approve created/reused_frozen is distinct from received, and synchronous retry is not queued", async () => {
    const approve = createAdminAction(identity(), "groups/group-1/approve", { note: "人工核对完整", days: 0, expected_occurrence_ids: ["a"], expected_revisions: { a: 1 }, expected_evidence_digest: "a".repeat(64), window_end: "2026-10-10T00:00:00Z" }, requestId);
    const body_digest = await adminActionBodyDigest(approve);
    for (const outcome of ["created", "reused_frozen"] as const) {
      await expect(adminOperationMatchesAction(approve, identity(), operation({ operation_kind: "approve", body_digest, outcome, result_ref: { kind: "handoff", id: "DH-1", revision: 1 } }))).resolves.toBe(true);
    }
    await expect(adminOperationMatchesAction(approve, identity(), operation({ operation_kind: "approve", body_digest, outcome: "received", result_ref: { kind: "handoff", id: "DH-1", revision: 1 } }))).resolves.toBe(false);
    const retry = createAdminAction(identity(), "turns/turn-1/retry", {}, requestId);
    await expect(adminOperationMatchesAction(retry, identity(), operation({ operation_kind: "retry", body_digest: await adminActionBodyDigest(retry), outcome: "queued", result_ref: { kind: "demand_turn", id: "turn-1", revision: null } }))).resolves.toBe(false);
  });

  it("logout and legacy remain read-only even with completed metadata", async () => {
    const logout = createAdminAction(identity(), "logout", {}, requestId);
    await expect(canReplayAdminAction(logout, identity(), operation({ operation_kind: "logout", result_ref: null }))).resolves.toBe(false);
    const direct = createAdminAction(identity(), "handoffs/DH-1/direct-send", { expected_revision: 1 }, requestId);
    await expect(canReplayAdminAction(direct, identity(), operation({ operation_kind: "direct_send", context_binding: "legacy_unbound", operation_context_ref: null, body_digest: null, outcome: "received", result_ref: { kind: "direct_delivery", id: "DEL-1", revision: 1 } }))).resolves.toBe(false);
  });

  it("expiry stops a stored POST locally and never repairs its old context", async () => {
    const original = rejectAction(); const metadata = operation(); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
    await expect(executeAdminAction(original)).rejects.toMatchObject({ status: 401, code: "ADMIN_SESSION_EXPIRED" });
    await expect(canReplayAdminAction(original, identity(), metadata)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "ADMIN_SESSION_REVOKED"], [409, "ADMIN_AUTH_CONTEXT_CHANGED"], [409, "ADMIN_ACTION_IN_PROGRESS"],
    [409, "ADMIN_ACTION_BODY_CONFLICT"], [503, "ADMIN_AUTH_UNAVAILABLE"], [503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE"],
  ])("HTTP%s %s takes precedence and never retries or changes context", async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: { code, message: "password=private <bad>", retryable: true }, status: "received" }, status, { "x-styling-admin-action-contract": ADMIN_ACTION_CONTRACT, "x-styling-admin-request-id": requestId }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeAdminAction(rejectAction())).rejects.toMatchObject({ status, code, retryable: status === 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(responseError(status, { error: { code, message: "password=private <bad>", retryable: true } }).message).not.toMatch(/password|private|<bad>/);
  });

  it("network uncertainty preserves the action and an abort stays an abort", async () => {
    const original = rejectAction(); const aborted = new DOMException("stopped", "AbortError");
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("token=private")).mockRejectedValueOnce(aborted);
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeAdminAction(original)).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    await expect(getAdminIdentity()).rejects.toBe(aborted);
    expect(original.body_json).toBe(rejectAction().body_json); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("new-mode domain GET rejects duplicate keys without weakening its original raw JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ records: [], total: 0 }))
      .mockResolvedValueOnce(new Response('{"records":[],"records":["untrusted"]}', { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readAdminContextResource("turns?page=2")).resolves.toEqual({ records: [], total: 0 });
    await expect(readAdminContextResource("turns?page=2")).rejects.toMatchObject({ code: "INVALID_ADMIN_RESPONSE" });
    await expect(readAdminContextResource("%2e%2e/logout")).rejects.toMatchObject({ code: "INVALID_ADMIN_RESPONSE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
