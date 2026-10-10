import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StylingPreview } from "../components/styling-preview";
import { getSavedSessions, getSessionId, peekSessionId } from "../app/lib/api";
import { resetConsumerProfileInitialization } from "../app/lib/consumer-profile";
import { emptyConsumerProfile, legacyConsumerRoute, preparedProfileFixture } from "./consumer-test-routes";
import { nextProfileField, profileRequestConditions } from "../app/lib/profile-request";
import { EMPTY_PROFILE_DRAFT } from "../app/lib/profile-draft";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (code: string, status: number) => json({ error: { code, message: "服务端受控错误" } }, status);
const done = (body: { session_id: string; request_id: string }, extra = {}) => new Response(`event: done\ndata: ${JSON.stringify({ ...body, content: "本次信息已处理", outcome: "clarification", outfit: null, ...extra })}\n\n`);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => { resetConsumerProfileInitialization(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
function ownedSession(session_id: string) {
  return { contract_version: "0.1.0", session_id, state: { session_id, state_revision: 0, current_look_version_id: null, look_version_ids: [] },
    history: [], messages: [], cart: [], cart_items: [], events: [], conversation_revision: 0, is_simulated: true };
}
type Handler = (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function fixture(handler: Handler = () => undefined) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const custom = handler(path, init); if (custom !== undefined) return custom;
    if (path.includes("generation-requests")) return error("NOT_FOUND", 404);
    const standard = legacyConsumerRoute(input, init); if (standard) return standard;
    return json({ messages: [], tryons: [], product_ids: [], products: [], cart: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function ready() {
  await waitFor(() => expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument());
  return screen.getByRole("textbox", { name: "说说你的穿搭需求" });
}
const writes = (calls: ReturnType<typeof fixture>, path: string) => calls.mock.calls.filter(([input, init]) => String(input).endsWith(path) && init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));

describe("资料冻结与正式聊天", () => {
  it("首次身份初始化单飞，在成功前不读会话不发送，编辑不丢失", async () => {
    const initial = deferred<Response>();
    const calls = fixture(path => path === "/api/v1/consumer-profile" ? initial.promise : undefined);
    render(<StylingPreview />); const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "先编辑，暂不发送" } });
    expect(input).toBeEnabled(); expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
    await act(async () => { initial.resolve(json(emptyConsumerProfile)); });
    await ready(); expect(input).toHaveValue("先编辑，暂不发送");
    expect(calls.mock.calls.filter(([url]) => String(url).endsWith("consumer-profile"))).toHaveLength(1);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
  });

  it("读取失败独立显示并阻止发送，不冒充空资料", async () => {
    fixture(path => path === "/api/v1/consumer-profile" ? error("PROFILE_STORAGE_UNAVAILABLE", 503) : undefined);
    render(<StylingPreview />);
    expect(await screen.findByText(/资料读取失败/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "预算800元通勤" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新读取我的资料" })).toBeEnabled();
  });

  it("纯自然语言先准备完全原body，后发完整binding；结构化字段不重复旧budget/scene", async () => {
    const calls = fixture((path, init) => path === "/api/v1/chat" ? done(JSON.parse(String(init?.body))) : undefined);
    render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "我想看看通勤穿搭"); await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("本次信息已处理");
    const preparations = writes(calls, "/consumer-profile/prepare"), chats = writes(calls, "/api/v1/chat");
    expect(preparations).toHaveLength(1); expect(chats).toHaveLength(1);
    const { profile_binding, ...original } = chats[0];
    expect(preparations[0].request_body).toEqual(original);
    expect(original).toEqual({ session_id: getSessionId(), request_id: expect.any(String), message: "我想看看通勤穿搭", request_conditions: {} });
    expect(profile_binding).toEqual(preparedProfileFixture(original.request_id).profile_binding);
  });

  it("429刷新只查询，默认修订增加后显式重发仍是原ID/body/binding，不再次prepare", async () => {
    let profileVersion = 0;
    const calls = fixture((path) => {
      if (path === "/api/v1/consumer-profile") return json({ ...emptyConsumerProfile, profile_version: profileVersion });
      if (path === "/api/v1/chat") return error("RATE_LIMITED", 429);
    });
    const view = render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "通勤，预算800元"); await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "按原编号重试发送" });
    const original = writes(calls, "/api/v1/chat")[0]; expect(original.profile_binding.profile_version).toBe(0);
    profileVersion = 2; view.unmount(); render(<StylingPreview />); await ready();
    await screen.findByRole("button", { name: "按原编号重试发送" });
    expect(writes(calls, "/api/v1/chat")).toHaveLength(1);
    expect(calls.mock.calls.some(([url]) => String(url).includes(`/generation-requests/${original.request_id}`))).toBe(true);
    await user.click(screen.getByRole("button", { name: "按原编号重试发送" }));
    await waitFor(() => expect(writes(calls, "/api/v1/chat")).toHaveLength(2));
    expect(writes(calls, "/api/v1/chat")[1]).toEqual(original);
    expect(writes(calls, "/consumer-profile/prepare")).toHaveLength(1);
  });

  it("prepare丢响应也保留原体；显式重试同一准备编号，不重建选择", async () => {
    let preparations = 0;
    const privateSessionId = "owned-prepare-retry-session";
    const calls = fixture((path, init) => {
      // A lost preparation is retried only after this identity can still read the already-created private session.
      if (path === "/api/v1/outfits/sessions" && init?.method === "POST") return json(ownedSession(privateSessionId));
      if (path === `/api/v1/outfits/sessions/${privateSessionId}` && (!init?.method || init.method === "GET")) return json(ownedSession(privateSessionId));
      if (path === "/api/v1/consumer-profile/prepare") {
        if (++preparations === 1) return Promise.reject(new Error("response lost"));
        return json(preparedProfileFixture(JSON.parse(String(init?.body)).request_id));
      }
      if (path === "/api/v1/chat") return done(JSON.parse(String(init?.body)));
    });
    render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "上衣S通勤"); await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "按原编号重试发送" });
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "按原编号重试发送" }));
    await screen.findByText("本次信息已处理");
    expect(writes(calls, "/consumer-profile/prepare")[1]).toEqual(writes(calls, "/consumer-profile/prepare")[0]);
  });

  it("清除后失效明确要求重确认，保留原体并不自动prepare或发送新ID", async () => {
    const calls = fixture(path => path === "/api/v1/chat" ? error("PROFILE_CLEARED", 409) : undefined);
    render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "按原资料通勤"); await user.click(screen.getByRole("button", { name: "发送" }));
    const edit = await screen.findByRole("button", { name: "保留旧请求，重新编辑" });
    const original = writes(calls, "/api/v1/chat")[0];
    expect(screen.queryByRole("button", { name: "按原编号重试发送" })).not.toBeInTheDocument();
    await user.click(edit);
    expect(JSON.parse(sessionStorage.getItem(`styling.previous-chat.v1:${original.request_id}`)!)).toEqual(original);
    expect(writes(calls, "/consumer-profile/prepare")).toHaveLength(1);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(1);
    expect(input).toHaveValue("按原资料通勤");
  });

  it("旧演示要求显式新私有会话，保留文字且不自动发第二次", async () => {
    const old = getSessionId(); // Existing legacy selection prevents an unrelated initial private-session POST.
    const calls = fixture(path => path === "/api/v1/consumer-profile/prepare" ? error("PROFILE_SESSION_RESTART_REQUIRED", 409) : undefined);
    render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "继续原通勤需求"); await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(await screen.findByRole("button", { name: "开始新对话并使用我的资料" }));
    await waitFor(() => expect(getSessionId()).not.toBe(old));
    expect(writes(calls, "/outfits/sessions")).toEqual([{ profile_contract: "consumer_profile_v1" }]);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
    expect(input).toHaveValue("继续原通勤需求");
  });

  it("只按返回的下一缺项提供单卡，不推断身高或重复追问完整资料", async () => {
    fixture((path, init) => path === "/api/v1/chat" ? done(JSON.parse(String(init?.body)), {
      profile_context: { field_sources: { scene: "explicit_text", "usual_sizes.top": "saved_profile" }, missing_fields: ["usual_sizes.bottom", "usual_sizes.shoes"], clarification: { field: "usual_sizes", next_field: "usual_sizes.bottom", question: "裤子尺码？" } },
    }) : undefined);
    render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "通勤，预算800元"); await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("heading", { name: "补充下装尺码" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "补充上衣尺码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("组件卸载后的迟到prepare不能发送chat或给原未绑定请求补写binding", async () => {
    const waiting = deferred<Response>();
    const calls = fixture(path => path === "/api/v1/consumer-profile/prepare" ? waiting.promise : undefined);
    const view = render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "组件卸载前明确提交的隔离需求"); await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(writes(calls, "/consumer-profile/prepare")).toHaveLength(1));
    const preparedBody = writes(calls, "/consumer-profile/prepare")[0];
    const key = `styling.pending-chat.v1:${preparedBody.session_id}`;
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(preparedBody.request_body);
    view.unmount();
    await act(async () => { waiting.resolve(json(preparedProfileFixture(preparedBody.request_id))); await waiting.promise; });
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(preparedBody.request_body);
    expect(JSON.parse(sessionStorage.getItem(key)!)).not.toHaveProperty("profile_binding");
  });

  it("旧组件迟到的新建会话响应不能记入入口或覆盖新组件当前会话", async () => {
    const waiting = deferred<Response>();
    let creations = 0;
    const calls = fixture((path, init) => path === "/api/v1/outfits/sessions" && init?.method === "POST"
      ? ++creations === 1 ? waiting.promise : json(ownedSession("current-private-session")) : undefined);
    const old = render(<StylingPreview />);
    await waitFor(() => expect(writes(calls, "/outfits/sessions")).toHaveLength(1));
    expect(peekSessionId()).toBeNull();
    old.unmount();
    render(<StylingPreview />); await ready();
    await waitFor(() => expect(peekSessionId()).toBe("current-private-session"));
    await act(async () => { waiting.resolve(json(ownedSession("late-old-private-session"))); await waiting.promise; });
    expect(peekSessionId()).toBe("current-private-session");
    expect(getSavedSessions().map(item => item.id)).toEqual(["current-private-session"]);
    expect(calls.mock.calls.some(([url]) => String(url).includes("/sessions/late-old-private-session"))).toBe(false);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
  });

  it("未知未绑定pending即使messages返回200，fixed404仍不显示原话且不给原重试", async () => {
    const sid = getSessionId();
    const original = { session_id: sid, request_id: "unknown-prepare-owner", message: "仅旧身份可见的隔离草稿", request_conditions: { budget_max_fen: 80000 } };
    const key = `styling.pending-chat.v1:${sid}`;
    sessionStorage.setItem(key, JSON.stringify(original));
    const calls = fixture(path => path.endsWith("/messages") ? json({ messages: [] }) : undefined);
    render(<StylingPreview />); const input = await ready();
    expect(await screen.findByRole("button", { name: "开始新的私有对话" })).toBeEnabled();
    expect(input).toHaveValue("");
    expect(screen.queryByText(original.message)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "按原编号重试发送" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查询原请求结果" })).not.toBeInTheDocument();
    expect(calls.mock.calls.some(([url]) => String(url).includes(`/generation-requests/${original.request_id}`))).toBe(false);
    expect(writes(calls, "/consumer-profile/prepare")).toHaveLength(0);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
    expect(writes(calls, "/outfits/sessions")).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
  });

  it.each(["missing", "foreign"])("旧公共会话GET非空不证明归属，%s owner标记仍隐藏未绑定原话", async marker => {
    const sid = getSessionId();
    const original = { session_id: sid, request_id: "public-session-old-prepare", message: "旧主体尚未绑定的隔离私有草稿", request_conditions: {} };
    const key = `styling.pending-chat.v1:${sid}`;
    sessionStorage.setItem(key, JSON.stringify(original));
    if (marker === "foreign") sessionStorage.setItem(`styling.pending-chat-owner.v1:${sid}`, JSON.stringify({ request_id: original.request_id, profile_id: "other-profile", scope_kind: "device" }));
    const calls = fixture(path => path === `/api/v1/outfits/sessions/${sid}` ? json(ownedSession(sid)) : undefined);
    render(<StylingPreview />); const input = await ready();
    expect(await screen.findByRole("button", { name: "开始新的私有对话" })).toBeEnabled();
    expect(input).toHaveValue("");
    expect(screen.queryByText(original.message)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "按原编号重试发送" })).not.toBeInTheDocument();
    expect(calls.mock.calls.some(([url]) => String(url).includes(`/generation-requests/${original.request_id}`))).toBe(false);
    expect(writes(calls, "/consumer-profile/prepare")).toHaveLength(0);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
  });

  it("已知同一非空profile归属且session可读时，刷新保留未绑定原体，明确重试不改原ID或条件", async () => {
    const sid = getSessionId(), profileId = "known-saved-profile";
    const original = { session_id: sid, request_id: "same-owner-lost-prepare", message: "仅按当时明确的800元通勤条件", request_conditions: { budget_max_fen: 80000 } };
    const key = `styling.pending-chat.v1:${sid}`;
    sessionStorage.setItem(key, JSON.stringify(original));
    sessionStorage.setItem(`styling.pending-chat-owner.v1:${sid}`, JSON.stringify({ request_id: original.request_id, profile_id: profileId, profile_version: 1, scope_kind: "device" }));
    const calls = fixture((path, init) => {
      if (path === "/api/v1/consumer-profile") return json({ ...emptyConsumerProfile, profile_id: profileId, profile_version: 3, status: "saved", default_budget_fen: 150000,
        updated_at: "2026-10-10T00:00:00Z", expires_at: "2027-04-01T00:00:00Z" });
      if (path === `/api/v1/outfits/sessions/${sid}`) return json(ownedSession(sid));
      if (path === "/api/v1/consumer-profile/prepare") {
        const frozen = preparedProfileFixture(original.request_id, 1);
        return json({ ...frozen, duplicate: true, profile_binding: { ...frozen.profile_binding, profile_id: profileId },
          snapshot: { ...frozen.snapshot, profile_id: profileId, profile_status: "saved", conditions: { budget_max_fen: 80000 } } });
      }
      if (path === "/api/v1/chat") return done(JSON.parse(String(init?.body)));
    });
    render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    const retry = await screen.findByRole("button", { name: "按原编号重试发送" });
    expect(input).toHaveValue(original.message);
    expect(writes(calls, "/consumer-profile/prepare")).toHaveLength(0);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
    await user.click(retry);
    await screen.findByText("本次信息已处理");
    expect(writes(calls, "/consumer-profile/prepare")[0]).toEqual({ operation: "chat", session_id: sid, request_id: original.request_id, request_body: original });
    expect(writes(calls, "/api/v1/chat")[0]).toMatchObject({ ...original, profile_binding: { profile_id: profileId, profile_version: 1 } });
    expect(writes(calls, "/api/v1/chat")).toHaveLength(1);
  });

  it("首次prepare未落库后默认v1变v2，重试只保留新binding并要求重新确认，不发送chat", async () => {
    const sid = "prepare-not-accepted-session", profileId = "profile-before-prepare";
    let profileVersion = 1, preparations = 0;
    const calls = fixture((path, init) => {
      if (path === "/api/v1/consumer-profile") return json({ ...emptyConsumerProfile, profile_id: profileId, profile_version: profileVersion, status: "saved",
        default_budget_fen: profileVersion === 1 ? 80000 : 150000, updated_at: "2026-10-10T00:00:00Z", expires_at: "2027-04-01T00:00:00Z" });
      if (path === "/api/v1/outfits/sessions" && init?.method === "POST" || path === `/api/v1/outfits/sessions/${sid}`) return json(ownedSession(sid));
      if (path === "/api/v1/consumer-profile/prepare") {
        if (++preparations === 1) return Promise.reject(new Error("request never reached profile storage"));
        const frozen = preparedProfileFixture(JSON.parse(String(init?.body)).request_id, profileVersion);
        return json({ ...frozen, duplicate: false, profile_binding: { ...frozen.profile_binding, profile_id: profileId },
          snapshot: { ...frozen.snapshot, profile_id: profileId, profile_status: "saved", conditions: { budget_max_fen: 150000 }, field_sources: { budget_max_fen: "saved_profile" } } });
      }
      if (path === "/api/v1/chat") return done(JSON.parse(String(init?.body)));
    });
    const first = render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "通勤，使用我最初确认的常用预算"); await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "按原编号重试发送" });
    const originalPrepare = writes(calls, "/consumer-profile/prepare")[0];
    const ownerKey = `styling.pending-chat-owner.v1:${sid}`;
    expect(JSON.parse(sessionStorage.getItem(ownerKey)!)).toMatchObject({ request_id: originalPrepare.request_id, profile_id: profileId, profile_version: 1 });
    profileVersion = 2; first.unmount(); render(<StylingPreview />); await ready();
    await user.click(await screen.findByRole("button", { name: "按原编号重试发送" }));
    const edit = await screen.findByRole("button", { name: "保留旧请求，重新编辑" });
    expect(writes(calls, "/consumer-profile/prepare")).toEqual([originalPrepare, originalPrepare]);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "按原编号重试发送" })).not.toBeInTheDocument();
    const retained = JSON.parse(sessionStorage.getItem(`styling.pending-chat.v1:${sid}`)!);
    expect(retained).toEqual({ ...originalPrepare.request_body, profile_binding: { ...preparedProfileFixture(originalPrepare.request_id, 2).profile_binding, profile_id: profileId } });
    expect(JSON.parse(sessionStorage.getItem(ownerKey)!)).toMatchObject({ profile_version: 1 });
    expect(JSON.parse(sessionStorage.getItem(`styling.blocked-chat.v1:${sid}`)!)).toMatchObject({ code: "PROFILE_PREPARATION_CHANGED" });
    await user.click(edit);
    expect(JSON.parse(sessionStorage.getItem(`styling.previous-chat.v1:${originalPrepare.request_id}`)!)).toEqual(retained);
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
  });

  it.each(["missing-version", "changed-profile"])("未绑定原准备%s时不得认作条件已保持；原体与返回binding留下供明确重确认", async condition => {
    const sid = getSessionId(), profileId = "known-initial-profile";
    const original = { session_id: sid, request_id: "unproven-initial-version", message: "保持最初资料的隔离需求", request_conditions: {} };
    sessionStorage.setItem(`styling.pending-chat.v1:${sid}`, JSON.stringify(original));
    sessionStorage.setItem(`styling.pending-chat-owner.v1:${sid}`, JSON.stringify({ request_id: original.request_id, profile_id: profileId, scope_kind: "device", ...(condition === "missing-version" ? {} : { profile_version: 1 }) }));
    const returnedProfile = condition === "changed-profile" ? "unexpected-other-profile" : profileId;
    const calls = fixture((path, init) => {
      if (path === "/api/v1/consumer-profile") return json({ ...emptyConsumerProfile, profile_id: profileId, profile_version: 1, status: "saved", updated_at: "2026-10-10T00:00:00Z", expires_at: "2027-04-01T00:00:00Z" });
      if (path === `/api/v1/outfits/sessions/${sid}`) return json(ownedSession(sid));
      if (path === "/api/v1/consumer-profile/prepare") {
        const frozen = preparedProfileFixture(JSON.parse(String(init?.body)).request_id, 1);
        return json({ ...frozen, profile_binding: { ...frozen.profile_binding, profile_id: returnedProfile }, snapshot: { ...frozen.snapshot, profile_id: returnedProfile, profile_status: "saved" } });
      }
      if (path === "/api/v1/chat") return done(JSON.parse(String(init?.body)));
    });
    render(<StylingPreview />); await ready(); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "按原编号重试发送" }));
    expect(await screen.findByRole("button", { name: "保留旧请求，重新编辑" })).toBeEnabled();
    expect(writes(calls, "/api/v1/chat")).toHaveLength(0);
    expect(writes(calls, "/consumer-profile/prepare")).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(`styling.pending-chat.v1:${sid}`)!)).toMatchObject({ ...original, profile_binding: { profile_id: returnedProfile, profile_version: 1 } });
    const owner = JSON.parse(sessionStorage.getItem(`styling.pending-chat-owner.v1:${sid}`)!);
    if (condition === "missing-version") expect(owner).not.toHaveProperty("profile_version");
    else expect(owner).toMatchObject({ profile_id: profileId, profile_version: 1 });
  });

  it("服务端只缺scene时仅显示场景卡，填入通勤只改草稿不自动发下一轮", async () => {
    const calls = fixture((path, init) => path === "/api/v1/chat" ? done(JSON.parse(String(init?.body)), {
      profile_context: { field_sources: { "usual_sizes.top": "saved_profile", "usual_sizes.bottom": "saved_profile", "usual_sizes.shoes": "saved_profile", budget_max_fen: "explicit_text" },
        missing_fields: ["scene"], clarification: { field: "scene", next_field: "scene", question: "这套搭配主要穿在什么场景？" } },
    }) : undefined);
    render(<StylingPreview />); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "预算800元，按我的常穿尺码给些建议"); await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("region", { name: "补充使用场景" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: /补充.*尺码/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writes(calls, "/api/v1/chat")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "填入通勤场景" }));
    expect(input).toHaveValue("日常通勤");
    expect(screen.queryByRole("region", { name: "补充使用场景" })).not.toBeInTheDocument();
    expect(writes(calls, "/api/v1/chat")).toHaveLength(1);
    expect(writes(calls, "/consumer-profile/prepare")).toHaveLength(1);
  });
});

it("本次字段只传明确尺寸预算，不复制保存默认或身体测量，缺项不猜测", () => {
  expect(profileRequestConditions({ ...EMPTY_PROFILE_DRAFT, height_cm: 165, weight_kg: 55, top: "S", budget_fen: 50000 })).toEqual({ request_profile_overrides: { usual_sizes: { top: { system: "clothing_alpha", value: "S" } } }, budget_max_fen: 50000 });
  expect(nextProfileField({ field_sources: {}, missing_fields: [], clarification: { field: "usual_sizes", next_field: "usual_sizes.top", question: "旧追问" } })).toBeNull();
});
