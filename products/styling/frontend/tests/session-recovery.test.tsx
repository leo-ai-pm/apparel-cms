import { legacyConsumerRoute, isBusinessWrite } from "./consumer-test-routes";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeAccountHistory, getSavedSessions, getSessionId, resetSession, selectSavedSession } from "../app/lib/api";
import { StylingPreview } from "../components/styling-preview";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const emptyRecords = { messages: [], tryons: [], product_ids: [], products: [], cart: [] };

describe("关闭后找回后台保存的对话和图片", () => {
  it("新标签页恢复原编号，新对话仍保留旧入口且不保存正文图片", () => {
    const first = getSessionId();
    sessionStorage.clear();
    expect(getSessionId()).toBe(first);
    const second = resetSession();
    expect(second).not.toBe(first);
    expect(getSavedSessions().map(item => item.id)).toEqual([second, first]);
    expect(Object.keys(getSavedSessions()[0]).sort()).toEqual(["createdAt", "id"]);
    expect(selectSavedSession(first)).toBe(true);
    expect(getSessionId()).toBe(first);
    expect(selectSavedSession("unknown-session")).toBe(false);
  });

  it("旧标签页编号自动迁入历史入口，损坏的索引不会阻断使用", () => {
    sessionStorage.setItem("session_id", "existing-session");
    localStorage.setItem("styling.sessions.v1", "invalid-json");
    expect(getSessionId()).toBe("existing-session");
    sessionStorage.clear();
    expect(getSessionId()).toBe("existing-session");
  });

  it("从历史切换后读取旧文字和图片，不重新发起生成", async () => {
    const first = getSessionId();
    resetSession();
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      const old = url.includes(first);
      let data: unknown = {};
      if (url.includes("/messages")) data = { messages: [{ role: "assistant", content: old ? "第一份已保存的方案" : "第二份已保存的方案" }] };
      else if (url.includes("/tryon?")) data = { tryons: old ? [{ task_id: "old-task", status: "succeeded", result_url: "/tryon-results/old.png", scene: "通勤" }] : [] };
      else if (url.includes("/signals")) data = { signals: [] };
      else if (url.includes("/cart")) data = { cart: [] };
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    vi.stubGlobal("fetch", calls);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await screen.findByText("第二份已保存的方案");
    await user.click(screen.getByRole("button", { name: "历史对话" }));
    await user.click(screen.getByRole("button", { name: /对话 1/ }));
    await screen.findByText("第一份已保存的方案");
    await waitFor(() => expect(document.querySelector('img[src="/tryon-results/old.png"]')).not.toBeNull());
    expect(calls.mock.calls.some(([url]) => String(url).includes("/chat"))).toBe(false);
    expect(getSessionId()).toBe(first);
  });

  it("刷新处理中任务后继续查状态，显示结果且不重新上传", async () => {
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      let data: unknown = {};
      if (url.includes("/messages")) data = { messages: [{ role: "user", content: "通勤搭配" }] };
      else if (url.includes("/tryon/saved-task")) data = { task_id: "saved-task", status: "succeeded", result_url: "/tryon-results/saved.png" };
      else if (url.includes("/tryon?")) data = { tryons: [{ task_id: "saved-task", status: "processing", scene: "通勤" }] };
      else if (url.includes("/signals")) data = { signals: [] };
      else if (url.includes("/cart")) data = { cart: [] };
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    vi.stubGlobal("fetch", calls);
    render(<StylingPreview />);
    await waitFor(() => expect(document.querySelector('img[src="/tryon-results/saved.png"]')).not.toBeNull(), { timeout: 4500 });
    expect(calls.mock.calls.some(([url]) => String(url) === "/api/v1/tryon")).toBe(false);
  });

  it("恢复未完成时可编辑但暂停发送，读取完成后展示保存的对话而不重新生成", async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => legacyConsumerRoute(input, init) ?? (String(input).includes("/messages") ? pending : response(emptyRecords)));
    vi.stubGlobal("fetch", calls); render(<StylingPreview />);
    expect(screen.getByText("正在恢复对话、图片和推荐记录…不会重新生成。")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /日常通勤/ })).toBeDisabled();
    await act(async () => { finish(response({ messages: [{ role: "assistant", content: "后台保存的旧方案" }] })); });
    expect(await screen.findByText("后台保存的旧方案")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(calls.mock.calls.some(([url]) => String(url).includes("/chat"))).toBe(false);
  });

  it("图片恢复失败保留已读取的对话和草稿，显式重试读取后恢复图片且不上传", async () => {
    let fail = true;
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isBusinessWrite([input, init])) throw new Error("恢复记录不得写入或重新上传");
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      if (url.includes("/messages")) return response({ messages: [{ role: "assistant", content: "始终保留的旧文字" }] });
      if (url.includes("/tryon?")) return fail ? response({}, 503) : response({ tryons: [{ task_id: "saved-image", status: "succeeded", result_url: "/tryon-results/recovered.png", scene: "通勤" }] });
      return response(emptyRecords);
    });
    vi.stubGlobal("fetch", calls); const user = userEvent.setup(); render(<StylingPreview />);
    await screen.findByText("始终保留的旧文字");
    expect(await screen.findByRole("alert")).toHaveTextContent("图片记录暂时无法读取");
    await user.type(screen.getByRole("textbox"), "重试后也保留的草稿"); fail = false;
    await user.click(screen.getByRole("button", { name: "重试恢复记录" }));
    expect(screen.getByText("始终保留的旧文字")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('img[src="/tryon-results/recovered.png"]')).not.toBeNull());
    expect(screen.getByRole("textbox")).toHaveValue("重试后也保留的草稿");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.mock.calls.some(call => isBusinessWrite(call) && call[1]?.method === "POST")).toBe(false);
  });

  it("已完成但缺图片地址明确提示缺图，不用意向素材代替结果或伪造生成成功", async () => {
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      if (url.includes("/messages")) return response({ messages: [{ role: "assistant", content: "保留的文字建议" }] });
      if (url.includes("/tryon?")) return response({ tryons: [{ task_id: "missing-image", status: "succeeded", scene: "通勤" }] });
      return response(emptyRecords);
    });
    vi.stubGlobal("fetch", calls); render(<StylingPreview />);
    expect(await screen.findByRole("heading", { name: "结果图暂时无法显示" })).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "完整搭配与效果图" })).toHaveTextContent("图片地址缺失");
    expect(screen.getByRole("figure", { name: "完整搭配与效果图" })).toHaveTextContent("此历史任务未返回商品编号");
    expect(document.querySelector('figure img[src*="editorial-styling"]')).toBeNull();
    expect(screen.queryByText(/效果图已生成/)).not.toBeInTheDocument();
    expect(calls.mock.calls.some(([url]) => String(url).includes("/chat"))).toBe(false);
  });

  it("切换历史效果图只改变图片，当前推荐仍独立标注且不声称历史商品价格版本被冻结", async () => {
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      if (url.includes("/messages")) return response({ messages: [{ role: "assistant", content: "当前推荐文字" }] });
      if (url.includes("/tryon?")) return response({ tryons: [
        { task_id: "old", status: "succeeded", result_url: "/tryon-results/old-look.png", scene: "通勤", product_ids: ["P-old"] },
        { task_id: "new", status: "succeeded", result_url: "/tryon-results/new-look.png", scene: "出游", product_ids: ["P-new"] },
      ] });
      if (url.includes("/recommendations?")) return response({ product_ids: ["P-new"] });
      if (url.includes("/products?")) return response({ products: [{ product_id: "P-new", name: "当前新上衣", price: 199, category: "上装" }] });
      return response(emptyRecords);
    });
    vi.stubGlobal("fetch", calls); const user = userEvent.setup(); render(<StylingPreview />);
    await screen.findByText("当前新上衣");
    await user.click(screen.getByRole("button", { name: "查看通勤试穿效果图" }));
    expect(document.querySelector('figure img[src="/tryon-results/old-look.png"]')).not.toBeNull();
    expect(screen.getByText("当前推荐单品 · 模拟加购")).toBeInTheDocument();
    expect(screen.getByText("当前新上衣")).toBeInTheDocument();
    const figure = screen.getByRole("figure", { name: "完整搭配与效果图" });
    expect(within(figure).getByText(/商品价格\/版本未冻结/)).toBeInTheDocument();
    expect(figure).toHaveTextContent("对应商品编号：P-old");
    expect(figure).not.toHaveTextContent("P-new");
    expect(calls.mock.calls.some(([url]) => String(url).includes("/chat"))).toBe(false);
  });

  it("新对话之后旧商品请求迟到不能写回新会话的推荐和上传入口", async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      if (url.endsWith("/chat")) return new Response(`event: done\ndata: ${JSON.stringify({session_id: getSessionId(), content: "旧轮方案", product_ids: ["P-old"]})}\n\n`);
      if (url.includes("/products?")) return pending;
      return response(emptyRecords);
    });
    vi.stubGlobal("fetch", calls); const user = userEvent.setup(); render(<StylingPreview />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    await user.type(screen.getByRole("textbox"), "先生成旧轮方案"); await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("旧轮方案");
    await user.click(screen.getByRole("button", { name: /新对话/ }));
    await act(async () => { finish(response({ products: [{ product_id: "P-old", name: "迟到的旧商品", category: "上装", price: 99 }] })); });
    expect(screen.queryByText("迟到的旧商品")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传照片" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(calls.mock.calls.filter(([url]) => String(url).includes("/chat"))).toHaveLength(1);
  });

  it("方案已保存但商品明细读取失败时保留文字和草稿，重试只读取记录", async () => {
    let submitted = false;
    let failProducts = true;
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      if (url.endsWith("/chat") && init?.method === "POST") {
        submitted = true;
        return new Response(`event: done\ndata: ${JSON.stringify({session_id: getSessionId(), content: "成功保存的搭配文字", product_ids: ["P-new"]})}\n\n`);
      }
      if (url.includes("/messages")) return response({ messages: submitted ? [{ role: "user", content: "预算500元的通勤装" }, { role: "assistant", content: "成功保存的搭配文字" }] : [] });
      if (url.includes("/recommendations?")) return response({ product_ids: submitted ? ["P-new"] : [] });
      if (url.includes("/products?")) return failProducts ? response({}, 503) : response({ products: [{ product_id: "P-new", name: "已恢复的真实推荐", category: "上装", price: 129 }] });
      return response(emptyRecords);
    });
    vi.stubGlobal("fetch", calls); const user = userEvent.setup(); render(<StylingPreview />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    await user.type(screen.getByRole("textbox"), "预算500元的通勤装");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("推荐单品暂时无法读取");
    expect(screen.getByText("成功保存的搭配文字")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "保留的后续草稿");
    failProducts = false;
    await user.click(screen.getByRole("button", { name: "重试恢复记录" }));
    expect(await screen.findByText("已恢复的真实推荐")).toBeInTheDocument();
    expect(screen.getByText("成功保存的搭配文字")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("保留的后续草稿");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.mock.calls.filter(call => isBusinessWrite(call) && call[1]?.method === "POST")).toHaveLength(1);
  });
});


it("新浏览器从服务器找回历史，切换账号不混用编号", async () => {
  let username = "reviewer-a";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/platform/me" ? { username } : { sessions: [{ id: username + "-session", createdAt: 100 }] } })));
  await initializeAccountHistory();
  expect(getSessionId()).toBe("reviewer-a-session");
  username = "reviewer-b";
  await initializeAccountHistory();
  expect(getSessionId()).toBe("reviewer-b-session");
  expect(getSavedSessions().map(x => x.id)).toEqual(["reviewer-b-session"]);
  username = "reviewer-a";
  await initializeAccountHistory();
  expect(getSessionId()).toBe("reviewer-a-session");
});
