import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_CONTRACT, PROFILE_AUTH_CONTEXT_CONTRACT, ProfileApiError, createPrivateOutfitSession, fetchConsumerProfile, fetchProfileOperation,
  fetchProfileSnapshot, initializeConsumerProfile, isProfileBinding, isProfileFields, isRequestConditions,
  mutateConsumerProfile, parseConsumerProfile, parseProfileBinding, parseProfileMutationReceipt,
  prepareConsumerProfile, resetConsumerProfileInitialization, validateProfileMutation,
  isProfileAuthorizationContext, type ProfileMutation, type ProfilePrepareRequest,
} from "../app/lib/consumer-profile";
import { session } from "./fixed-outfit-fixtures";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = () => ({ profile_contract: PROFILE_CONTRACT, profile_id: null, profile_version: 0, scope_kind: "device", status: "empty",
  base_profile: { height_cm: null, weight_kg: null, usual_sizes: { top: null, bottom: null, shoes: null } }, default_budget_fen: null,
  updated_at: null, expires_at: null, storage_notice: "隔离测试本设备资料" });
const mutation = (): ProfileMutation => ({ profile_action_id: "save-one", operation: "save", expected_profile_version: 0,
  patch: { base_profile: { usual_sizes: { top: { system: "clothing_alpha", value: "S" } } } }, explicit_save: true });
const receipt = () => ({ profile_contract: PROFILE_CONTRACT, profile_action_id: "save-one", operation: "save", profile_id: "profile-test",
  scope_kind: "device", version_before: 0, profile_version: 1, profile_status: "saved", changed_field_names: ["base_profile.usual_sizes.top"], status: "succeeded", created_at: "2026-10-10T00:00:00Z" });
const binding = () => ({ snapshot_id: "ps-synthetic", profile_id: null, profile_version: 0, snapshot_digest: "a".repeat(64) });
const prepared = () => ({ profile_binding: binding(), duplicate: false, snapshot: { ...binding(), profile_contract: PROFILE_CONTRACT,
  bound_request_id: "request-synthetic", base_profile: { usual_sizes: {} }, conditions: { budget_max_fen: 80000 },
  field_sources: { budget_max_fen: "explicit_selection" }, explicit_overrides: { usual_sizes: {} }, profile_status: "empty", state: "prepared",
  created_at: "2026-10-10T00:00:00Z", expires_at: "2026-10-11T00:00:00Z", effective_profile_snapshot: null } });
const prepareBody = (): ProfilePrepareRequest => ({ operation: "chat", session_id: "session-synthetic", request_id: "request-synthetic",
  request_body: { session_id: "session-synthetic", request_id: "request-synthetic", message: "测试通勤条件", request_conditions: { budget_max_fen: 80000 } } });
beforeEach(() => { resetConsumerProfileInitialization(); });
const authContext = () => ({ context_contract: PROFILE_AUTH_CONTEXT_CONTRACT, context_id: "synthetic-context-a", operation_token: "synthetic-private-operation-token", issued_at: "2026-10-10T00:00:00Z", expires_at: "2026-10-10T00:10:00Z" });

describe("ACTX 兼容边界与私有授权上下文（合成协议测试）", () => {
  it("旧GET无context保持旧body，新GET合法context按三项原值发送且不附时间或owner", async () => {
    const context = authContext();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json(receipt()))
      .mockResolvedValueOnce(json({ ...empty(), authorization_context: context })).mockResolvedValueOnce(json(receipt()));
    vi.stubGlobal("fetch", fetcher);
    await mutateConsumerProfile(mutation());
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).not.toHaveProperty("expected_authorization_context");
    const profile = await fetchConsumerProfile();
    const { context_contract, context_id, operation_token } = profile.authorization_context!;
    const original = { ...mutation(), expected_authorization_context: { context_contract, context_id, operation_token } };
    await mutateConsumerProfile(original);
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toEqual(original);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(new Headers(fetcher.mock.calls[3][1]?.headers).has("authorization")).toBe(false);
  });

  it.each([
    null, {}, { ...authContext(), context_contract: "unsupported" }, { ...authContext(), context_id: "" },
    { ...authContext(), operation_token: "" }, { ...authContext(), operation_token: "contains whitespace" },
    { ...authContext(), issued_at: "not-time" }, { ...authContext(), expires_at: authContext().issued_at },
    { ...authContext(), owner_id: "not-a-client-identity" },
  ])("GET带不合法context时读取失败，不降级为旧schema #%#", async context => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({ ...empty(), authorization_context: context })));
    await expect(fetchConsumerProfile()).rejects.toMatchObject({ code: "INVALID_PROFILE_RESPONSE" });
  });

  it("已过期context仍可解析以便只查询原成功回执；原mutation禁止夹带时间和未知身份字段", () => {
    expect(isProfileAuthorizationContext(authContext())).toBe(true);
    const { context_contract, context_id, operation_token } = authContext();
    const body = { ...mutation(), expected_authorization_context: { context_contract, context_id, operation_token } };
    expect(() => validateProfileMutation(body)).not.toThrow();
    expect(() => validateProfileMutation({ ...body, expected_authorization_context: authContext() })).toThrow();
    expect(() => validateProfileMutation({ ...body, expected_authorization_context: { ...body.expected_authorization_context, operation_token: "" } })).toThrow();
    expect(() => parseProfileMutationReceipt({ ...receipt(), authorization_context: authContext() })).toThrow();
    expect(() => parseProfileMutationReceipt({ ...receipt(), operation_token })).toThrow();
  });

  it.each(["PROFILE_AUTH_CONTEXT_INVALID", "PROFILE_AUTH_CONTEXT_CHANGED", "PROFILE_AUTH_CONTEXT_EXPIRED", "PROFILE_AUTH_CONTEXT_INVALIDATED"])("%s保留独立code而不展示后端正文或令牌", async code => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code, message: authContext().operation_token } }, code.endsWith("INVALID") || code.endsWith("CHANGED") ? 403 : 409));
    vi.stubGlobal("fetch", fetcher);
    let caught: unknown; try { await fetchConsumerProfile(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code });
    expect((caught as Error).message).not.toContain(authContext().operation_token);
    expect((caught as Error).message).toContain("原操作");
  });
});

describe("消费者资料真实接口客户端边界", () => {
  it("初始化GET并发单飞，失败后可明确重读，不发明空资料", async () => {
    let resolve!: (v: Response) => void;
    const deferred = new Promise<Response>(done => { resolve = done; });
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(deferred).mockResolvedValueOnce(json(empty()));
    vi.stubGlobal("fetch", fetcher);
    const one = initializeConsumerProfile(), two = initializeConsumerProfile();
    expect(one).toBe(two); expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(json({ error: { code: "PROFILE_STORAGE_UNAVAILABLE", message: "不可用" } }, 503));
    await expect(one).rejects.toMatchObject({ status: 503, code: "PROFILE_STORAGE_UNAVAILABLE" });
    await expect(initializeConsumerProfile()).resolves.toMatchObject({ status: "empty", profile_version: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("初始化Cookie就绪前mutation不发POST；之后不为每个操作重新读取默认", async () => {
    let resolve!: (v: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }))
      .mockResolvedValueOnce(json(receipt())).mockResolvedValueOnce(json(receipt()));
    vi.stubGlobal("fetch", fetcher);
    const init = initializeConsumerProfile(), saving = mutateConsumerProfile(mutation());
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(json(empty())); await init; await saving;
    await mutateConsumerProfile(mutation());
    expect(fetcher.mock.calls.map(([, args]) => args?.method)).toEqual(["GET", "POST", "POST"]);
    for (const [, args] of fetcher.mock.calls) {
      expect(args?.credentials).toBe("same-origin"); expect(args?.cache).toBe("no-store");
      expect(new Headers(args?.headers).has("cookie")).toBe(false);
    }
  });

  it("显式读取总是GET权威版本；身份重置后旧响应不让新身份绕过初始化", async () => {
    let resolve!: (v: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }))
      .mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json(receipt())).mockResolvedValueOnce(json(empty()));
    vi.stubGlobal("fetch", fetcher);
    const old = initializeConsumerProfile(); resetConsumerProfileInitialization(); resolve(json(empty())); await old;
    await mutateConsumerProfile(mutation()); await fetchConsumerProfile();
    expect(fetcher.mock.calls.map(([, args]) => args?.method)).toEqual(["GET", "GET", "POST", "GET"]);
  });

  it("只提交原patch，省略字段不被变成null，旧回执不在客户端复活已清除资料", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json(receipt()))
      .mockResolvedValueOnce(json({ ...empty(), profile_id: "profile-test", profile_version: 2, status: "cleared", updated_at: "2026-10-10T00:01:00Z" }));
    vi.stubGlobal("fetch", fetcher);
    const original = Object.freeze(mutation());
    const result = await mutateConsumerProfile(original);
    expect(result.profile_version).toBe(1);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(original);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).patch.base_profile).not.toHaveProperty("height_cm");
    expect((await fetchConsumerProfile()).status).toBe("cleared");
  });

  it("HTTP错误从error.code识别，不依赖detail、不暴露原输入或冒充成功", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: "PROFILE_VERSION_CONFLICT", message: "sensitive body value" } }, 409)));
    let error: unknown; try { await fetchConsumerProfile(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProfileApiError);
    expect(error).toMatchObject({ status: 409, code: "PROFILE_VERSION_CONFLICT" });
    expect((error as Error).message).not.toContain("sensitive");
  });

  it("HTTP200无有效完整资料响应仍报错，body解析失败不返回空", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(json({})).mockResolvedValueOnce(new Response("<html>error</html>")));
    await expect(fetchConsumerProfile()).rejects.toMatchObject({ code: "INVALID_PROFILE_RESPONSE" });
    await expect(fetchConsumerProfile()).rejects.toMatchObject({ status: 502 });
  });

  it("查询操作只有约定not-found返回null，跨主体404与其他故障仍显式报错", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty()))
      .mockResolvedValueOnce(json({ error: { code: "PROFILE_OPERATION_NOT_FOUND" } }, 404))
      .mockResolvedValueOnce(json({ error: { code: "PROFILE_SCOPE_FORBIDDEN" } }, 404))
      .mockResolvedValueOnce(json(receipt())));
    expect(await fetchProfileOperation("save-one")).toBeNull();
    await expect(fetchProfileOperation("save-one")).rejects.toMatchObject({ code: "PROFILE_SCOPE_FORBIDDEN" });
    expect((await fetchProfileOperation("save-one"))?.profile_action_id).toBe("save-one");
  });

  it("mutation与操作查询核对原动作编号，不接受另一个成功回执", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty()))
      .mockResolvedValueOnce(json({ ...receipt(), profile_action_id: "other" }))
      .mockResolvedValueOnce(json({ ...receipt(), profile_action_id: "other" })));
    await expect(mutateConsumerProfile(mutation())).rejects.toMatchObject({ code: "INVALID_PROFILE_RESPONSE" });
    await expect(fetchProfileOperation("save-one")).rejects.toMatchObject({ code: "INVALID_PROFILE_RESPONSE" });
  });

  it("prepare保留原body缺省/数字/null及原话，并返回服务端完整绑定", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json(prepared()));
    vi.stubGlobal("fetch", fetcher);
    const original = prepareBody(); original.request_body.request_conditions = { budget_max_fen: null, request_profile_overrides: { usual_sizes: { top: null } } };
    const result = await prepareConsumerProfile(original);
    expect(result.profile_binding).toEqual(binding());
    expect(result.snapshot.bound_request_id).toBe(original.request_id);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(original);
    expect(original.request_body).not.toHaveProperty("profile_binding");
    expect(fetcher.mock.calls[1][0]).toBe("/api/v1/consumer-profile/prepare");
  });

  it("prepare未知结构化场景交后端真实校验，不悄悄映射通勤", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json({ error: { code: "PROFILE_INVALID_SCENE" } }, 422));
    vi.stubGlobal("fetch", fetcher);
    const body = prepareBody(); body.request_body.request_conditions = { scene: "travel" };
    await expect(prepareConsumerProfile(body)).rejects.toMatchObject({ code: "PROFILE_INVALID_SCENE" });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).request_body.request_conditions.scene).toBe("travel");
  });

  it.each(["PROFILE_CLEARED", "PROFILE_SNAPSHOT_EXPIRED", "PROFILE_SESSION_RESTART_REQUIRED"])("prepare %s保留真实409，不自动重建或发送", async code => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json({ error: { code } }, 409));
    vi.stubGlobal("fetch", fetcher);
    const body = prepareBody(), before = JSON.stringify(body);
    await expect(prepareConsumerProfile(body)).rejects.toMatchObject({ status: 409, code });
    expect(JSON.stringify(body)).toBe(before); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("快照四字段/请求ID必须一致；快照不得混入身体值", async () => {
    const wrongDigest = prepared(); wrongDigest.snapshot.snapshot_digest = "b".repeat(64);
    const wrongRequest = prepared(); wrongRequest.snapshot.bound_request_id = "request-other";
    const bodyLeak = prepared(); Object.assign(bodyLeak.snapshot.base_profile, { height_cm: 165 });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json(wrongDigest))
      .mockResolvedValueOnce(json(wrongRequest)).mockResolvedValueOnce(json(bodyLeak)));
    for (let n = 0; n < 3; n++) await expect(prepareConsumerProfile(prepareBody())).rejects.toMatchObject({ code: "INVALID_PROFILE_RESPONSE" });
  });

  it("读取expired快照仍显示历史状态，404不能当准备成功", async () => {
    const old = prepared(); old.snapshot.state = "expired";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json(old))
      .mockResolvedValueOnce(json({ error: { code: "PROFILE_SNAPSHOT_NOT_FOUND" } }, 404)));
    expect((await fetchProfileSnapshot("ps-synthetic")).snapshot.state).toBe("expired");
    await expect(fetchProfileSnapshot("ps-synthetic")).rejects.toMatchObject({ status: 404 });
  });

  it("新私有会话仅传资料契约，返回服务器ID而不使用demo_profile或本地身份", async () => {
    const server = session();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(empty())).mockResolvedValueOnce(json(server));
    vi.stubGlobal("fetch", fetcher);
    expect((await createPrivateOutfitSession()).session_id).toBe(server.session_id);
    expect(fetcher.mock.calls[1][0]).toBe("/api/v1/outfits/sessions");
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ profile_contract: "consumer_profile_v1" });
  });
});

describe("consumer_profile_v1严格字段验证", () => {
  it("接受合法部分资料、空身体值与S/35，合法保存不等同M1有图", () => {
    expect(isProfileFields({ height_cm: null, weight_kg: 55.5, usual_sizes: { top: { system: "clothing_alpha", value: "S" }, shoes: { system: "cn_shoe", value: "35" } } })).toBe(true);
    expect(parseConsumerProfile(empty()).profile_version).toBe(0);
    expect(isRequestConditions({ budget_max_fen: 1 })).toBe(true);
    expect(isProfileBinding(binding())).toBe(true);
    expect(parseProfileBinding(binding())).toEqual(binding());
  });

  it.each([
    { height_cm: 99.5 }, { height_cm: 250.5 }, { height_cm: 165.3 }, { height_cm: "165" }, { height_cm: true },
    { weight_kg: 19.5 }, { weight_kg: 300.5 }, { weight_kg: 55.1 }, { weight_kg: Infinity },
    { usual_sizes: { top: { system: "cn_shoe", value: "38" } } }, { usual_sizes: { shoes: { system: "cn_shoe", value: 38 } } },
    { usual_sizes: { shoes: { system: "cn_shoe", value: "38.5" } } }, { usual_sizes: { bottom: { system: "clothing_alpha", value: "m" } } },
    { user_id: "synthetic-owner" },
  ])("拒绝非契约资料结构%j", fields => { expect(isProfileFields(fields)).toBe(false); });

  it.each([false, "80000", 0, -1, 0.5, 100000001])("预算拒绝非法值%j", value => {
    expect(isRequestConditions({ budget_max_fen: value })).toBe(false);
  });

  it("binding四字段全部必需，摘要严格小写64hex且不接受伪造来源字段", () => {
    expect(isProfileBinding({ ...binding(), snapshot_digest: "A".repeat(64) })).toBe(false);
    expect(isProfileBinding({ ...binding(), profile_version: "0" })).toBe(false);
    const missing: Record<string, unknown> = binding(); delete missing.profile_id;
    expect(isProfileBinding(missing)).toBe(false);
    expect(isRequestConditions({ field_sources: { scene: "saved_profile" } })).toBe(false);
  });

  it("mutation需要明确保存/独立常用预算意图，clear只能空patch", () => {
    expect(() => validateProfileMutation(mutation())).not.toThrow();
    expect(() => validateProfileMutation({ ...mutation(), explicit_save: false })).toThrow();
    expect(() => validateProfileMutation({ ...mutation(), patch: {} })).toThrow();
    expect(() => validateProfileMutation({ ...mutation(), patch: { default_budget_fen: 80000 } })).toThrow();
    expect(() => validateProfileMutation({ ...mutation(), patch: { default_budget_fen: null }, explicit_default_budget: true })).not.toThrow();
    expect(() => validateProfileMutation({ ...mutation(), operation: "clear" })).toThrow();
    expect(() => validateProfileMutation({ ...mutation(), operation: "clear", patch: {}, explicit_save: false })).not.toThrow();
  });

  it("非法prepare/绑定不匹配在网络前拒绝，不生成新请求身份", async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
    const body = prepareBody(); body.request_body.profile_binding = binding();
    await expect(prepareConsumerProfile(body)).rejects.toBeInstanceOf(ProfileApiError);
    const wrong = prepareBody(); wrong.request_body.request_id = "other";
    await expect(prepareConsumerProfile(wrong)).rejects.toBeInstanceOf(ProfileApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("脱敏回执不包含资料正文，版本必须单调", () => {
    expect(() => parseProfileMutationReceipt({ ...receipt(), base_profile: { height_cm: 165 } })).toThrow();
    expect(() => parseProfileMutationReceipt({ ...receipt(), version_before: 1 })).toThrow();
  });
});
