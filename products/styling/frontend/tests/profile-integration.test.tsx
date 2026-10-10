import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { StylingPreview } from "../components/styling-preview";
import { emptyConsumerProfile, legacyConsumerRoute, isBusinessWrite } from "./consumer-test-routes";
import { createChatRequest, getSessionId } from "../app/lib/api";
import { PROFILE_AUTH_CONTEXT_CONTRACT } from "../app/lib/consumer-profile";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
function boot(history: unknown[] = [], terminal?: () => unknown) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const extra = legacyConsumerRoute(input, init); if (extra) return extra;
    if (String(input).includes("generation-requests/")) {
      const result = terminal?.();
      return new Response(JSON.stringify(result ?? { error: { code: "NOT_FOUND" } }), { status: result ? 200 : 404 });
    }
    return new Response(JSON.stringify({ messages: history, products: [], items: [], product_ids: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<StylingPreview />);
  return fetcher;
}
async function ready() {
  const input = screen.getByRole("textbox", { name: "说说你的穿搭需求" });
  await waitFor(() => expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument());
  await waitFor(() => expect(input).toBeEnabled());
  return input;
}
describe("资料服务与消费者临时控件边界", () => {
  it("到期旧资料操作查询保留明确错误，关闭与成功刷新后仍显示仅查询而非初始化", async () => {
    const key = "styling.pending-profile.v1:/";
    const body = { profile_action_id: "synthetic-expired-banner", operation: "save", expected_profile_version: 0,
      patch: { default_budget_fen: 80000 }, explicit_save: true, explicit_default_budget: true,
      expected_authorization_context: { context_contract: PROFILE_AUTH_CONTEXT_CONTRACT, context_id: "synthetic-banner-context", operation_token: "synthetic-old-token" } };
    sessionStorage.setItem(key, JSON.stringify({ body, owner: { profile_id: null, scope_kind: "device", authorization_expires_at: new Date(Date.now() - 600000).toISOString() } }));
    const profile = { ...emptyConsumerProfile, authorization_context: { ...body.expected_authorization_context,
      operation_token: "synthetic-fresh-token", issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() } };
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/v1/consumer-profile") return new Response(JSON.stringify(profile), { status: 200 });
      if (path.includes("/consumer-profile/operations/")) return new Response(JSON.stringify({ error: { code: "PROFILE_OPERATION_NOT_FOUND", message: "未找到原操作" } }), { status: 404 });
      return legacyConsumerRoute(input, init) ?? new Response(JSON.stringify({ messages: [], products: [], items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", calls); const user = userEvent.setup(); const view = render(<StylingPreview />);
    try {
      await screen.findByText("旧资料操作仅可查询，原保存授权不能继续写入。");
      const beforeOpen = calls.mock.calls.length;
      await user.click(screen.getByRole("button", { name: "查看待确认资料操作" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(calls.mock.calls.slice(beforeOpen).some(([url]) => String(url).includes("/consumer-profile/operations/") || String(url).endsWith("/consumer-profile/mutations"))).toBe(false);
      await user.click(screen.getByRole("button", { name: "仅查询原资料操作" }));
      const error = "当前范围没有找到旧操作，原保存授权已失效、到期或无法核对。编辑与原操作已保留，请结束旧查询后重新确认保存。";
      await screen.findAllByText(error);
      await user.click(screen.getByRole("button", { name: "关闭我的穿搭资料" }));
      expect(screen.getByRole("alert")).toHaveTextContent(error);
      const profileReads = () => calls.mock.calls.filter(([url]) => String(url).endsWith("/consumer-profile")).length;
      const beforeRefresh = profileReads();
      act(() => { window.dispatchEvent(new Event("focus")); });
      await waitFor(() => expect(profileReads()).toBeGreaterThan(beforeRefresh));
      await waitFor(() => expect(screen.queryByText(error)).not.toBeInTheDocument());
      expect(screen.getByText("旧资料操作仅可查询，原保存授权不能继续写入。")).toBeInTheDocument();
      expect(screen.queryByText(/正在(?:初始化|重新读取)本浏览器的穿搭资料/)).not.toBeInTheDocument();
      expect(JSON.parse(sessionStorage.getItem(key)!).body).toEqual(body);
      expect(calls.mock.calls.filter(([url]) => String(url).includes("/consumer-profile/operations/"))).toHaveLength(1);
      expect(calls.mock.calls.some(isBusinessWrite)).toBe(false);
    } finally { view.unmount(); sessionStorage.removeItem(key); }
  });

  it("只有无旧操作的真实读取才显示初始化，恢复可核对旧操作后展示待确认入口且不自动重试", async () => {
    const key = "styling.pending-profile.v1:/";
    const body = { profile_action_id: "synthetic-pending-banner", operation: "save", expected_profile_version: 0,
      patch: { default_budget_fen: 80000 }, explicit_save: true, explicit_default_budget: true,
      expected_authorization_context: { context_contract: PROFILE_AUTH_CONTEXT_CONTRACT, context_id: "synthetic-pending-context", operation_token: "synthetic-original-token" } };
    sessionStorage.setItem(key, JSON.stringify({ body, owner: { profile_id: null, scope_kind: "device", authorization_expires_at: new Date(Date.now() + 600000).toISOString() } }));
    const profile = { ...emptyConsumerProfile, authorization_context: { ...body.expected_authorization_context,
      operation_token: "synthetic-current-token", issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() } };
    let finishRead!: (response: Response) => void;
    const initialRead = new Promise<Response>(resolve => { finishRead = resolve; });
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/consumer-profile")) return initialRead;
      return legacyConsumerRoute(input, init) ?? new Response(JSON.stringify({ messages: [], products: [], items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", calls); const user = userEvent.setup(); const view = render(<StylingPreview />);
    try {
      expect(screen.getByText("正在初始化本浏览器的穿搭资料…")).toBeInTheDocument();
      await act(async () => { finishRead(new Response(JSON.stringify(profile), { status: 200 })); });
      await screen.findByText("有一条资料操作待确认，原编号与编辑已保留。");
      expect(screen.queryByText(/正在初始化本浏览器的穿搭资料/)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "查看待确认资料操作" }));
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: "查询并按原编号重试资料操作" })).toBeEnabled();
      expect(JSON.parse(sessionStorage.getItem(key)!).body).toEqual(body);
      expect(calls.mock.calls.some(([url]) => String(url).includes("/consumer-profile/operations/") || String(url).endsWith("/consumer-profile/mutations"))).toBe(false);
      expect(calls.mock.calls.some(isBusinessWrite)).toBe(false);
    } finally { view.unmount(); sessionStorage.removeItem(key); }
  });

  it("编辑本次选择不改已有待确认请求原体或编号", async () => {
    const sid = getSessionId();
    const request = createChatRequest(sid, "原需求：通勤，预算800", "800", "通勤");
    const key = `styling.pending-chat.v1:${sid}`;
    sessionStorage.setItem(key, JSON.stringify(request));
    let terminal: unknown = null;
    const calls = boot([], () => terminal); const user = userEvent.setup(); const input = await ready();
    await screen.findByText("有一条请求待确认，原需求和编号已保留。");
    await user.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    await user.click(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" }));
    await user.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(request);
    const newDraft = (input as HTMLTextAreaElement).value;
    terminal = { session_id: sid, request_id: request.request_id, recorded: true, status: "failed", result: null, effective_outfit: false, outcome: null, error_code: "MODEL_NOT_CONFIGURED" };
    await user.click(screen.getByRole("button", { name: "查询原请求结果" }));
    await waitFor(() => expect(screen.queryByText("有一条请求待确认，原需求和编号已保留。")).not.toBeInTheDocument());
    expect(input).toHaveValue(newDraft);
    expect(calls.mock.calls.some(isBusinessWrite)).toBe(false);
    sessionStorage.removeItem(key);
  });
  it("改写预填行后再补预算不删用户文字、不恢复旧尺码；清空从卡片打开的面板回到输入", async () => {
    boot([{ role: "assistant", content: "已有文字" }]); const user = userEvent.setup(); const input = await ready();
    await user.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    await user.click(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" }));
    await user.click(screen.getByRole("button", { name: "填入本次草稿" }));
    fireEvent.change(input, { target: { value: "明天通勤\n【本次选择（未保存）】上衣M，别要紧身" } });
    await user.selectOptions(screen.getByRole("combobox", { name: "选择一项补充" }), "budget_fen");
    await user.click(screen.getByRole("button", { name: "¥500" }));
    await user.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(input).toHaveValue("明天通勤\n【本次选择（未保存）】上衣M，别要紧身\n【本次选择（未保存）】预算500元");
    await user.click(screen.getAllByRole("button", { name: "我的穿搭资料" })[1]);
    await user.click(screen.getByRole("button", { name: "清空本次选择" }));
    await user.click(screen.getByRole("button", { name: "确认清空本次选择" }));
    expect(input).toHaveValue("明天通勤\n【本次选择（未保存）】上衣M，别要紧身");
    await waitFor(() => expect(input).toHaveFocus());
  });
  it("自然语言独立使用；抽屉取消/确认不保存不发送，选择不补默认身体值", async () => {
    const calls = boot(); const user = userEvent.setup(); const input = await ready();
    await user.type(input, "明天通勤");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const entry = screen.getByRole("button", { name: "我的穿搭资料" });
    await user.click(entry);
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "保存我的资料" })).toBeDisabled();
    await user.click(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" }));
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(input).toHaveValue("明天通勤");
    await waitFor(() => expect(entry).toHaveFocus());
    await user.click(entry); dialog = screen.getByRole("dialog");
    expect(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "false");
    await user.click(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" }));
    await user.click(within(dialog).getByRole("button", { name: "填入本次草稿" }));
    expect(input).toHaveValue("明天通勤\n【本次选择（未保存）】上衣S");
    await waitFor(() => expect(input).toHaveFocus());
    expect(calls.mock.calls.some(isBusinessWrite)).toBe(false);
    expect(calls.mock.calls.some(([url]) => String(url).endsWith("consumer-profile/mutations"))).toBe(false);
    const events = calls.mock.calls.filter(([url]) => String(url).endsWith("consumer-events"));
    expect(events.every(([,init]) => !/height|weight|profile|上衣S/.test(String(init?.body)))).toBe(true);
  });
  it("清本次选择保留原话，新对话不复用未保存资料", async () => {
    const calls = boot(); const user = userEvent.setup(); const input = await ready();
    await user.type(input, "周末出游");
    await user.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    await user.click(within(screen.getByRole("group", { name: "下装常穿尺码" })).getByRole("button", { name: "L" }));
    await user.click(screen.getByRole("button", { name: "填入本次草稿" }));
    await user.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    await user.click(screen.getByRole("button", { name: "清空本次选择" }));
    await user.click(screen.getByRole("button", { name: "确认清空本次选择" }));
    expect(input).toHaveValue("周末出游");
    await user.click(screen.getByRole("button", { name: "新对话" }));
    await user.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    expect(within(screen.getByRole("group", { name: "下装常穿尺码" })).getByRole("button", { name: "L" })).toHaveAttribute("aria-pressed", "false");
    expect(calls.mock.calls.some(isBusinessWrite)).toBe(false);
  });
  it("只由用户选择单项卡片；切换字段不串值，确认只填草稿", async () => {
    const calls = boot([{ role: "assistant", content: "请告诉我本次条件" }]);
    const user = userEvent.setup(); await ready();
    act(() => { window.history.replaceState(null, "", "#outfit"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.queryByRole("heading", { name: "补充上衣尺码" })).not.toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "选择一项补充" });
    await user.selectOptions(select, "top");
    await user.click(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" }));
    await user.selectOptions(select, "bottom");
    expect(within(screen.getByRole("group", { name: "下装常穿尺码" })).getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "false");
    await user.click(within(screen.getByRole("group", { name: "下装常穿尺码" })).getByRole("button", { name: "L" }));
    await user.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(screen.getByRole("textbox", { name: "说说你的穿搭需求" })).toHaveValue("【本次选择（未保存）】裤子L");
    expect(calls.mock.calls.some(isBusinessWrite)).toBe(false);
    await user.click(screen.getAllByRole("button", { name: "我的穿搭资料" })[0]);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  });
});
