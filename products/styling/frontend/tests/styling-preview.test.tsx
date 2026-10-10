import { legacyConsumerRoute, isBusinessWrite } from "./consumer-test-routes";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { getSessionId } from "../app/lib/api";
import { StylingPreview } from "../components/styling-preview";

type SseEvent = [string, unknown];

function sseResponse(events: SseEvent[]): Response {
  const body = events.map(([ev, raw]) => { const data = ev === "done" && raw && typeof raw === "object" ? { ...raw, session_id: getSessionId() } : raw; return `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; }).join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream as unknown as ReadableStream<Uint8Array>,
    json: async () => ({}),
  } as unknown as Response;
}

function stubFetch(chatEvents: SseEvent[] = [], history: unknown[] = []) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const extra = legacyConsumerRoute(input, init); if (extra) return extra;
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/v1/chat") && init?.method === "POST") return sseResponse(chatEvents);
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: history }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function readyInput() {
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument());
  await waitFor(() => expect(input).toBeEnabled());
  return input;
}

describe("穿搭对话页", () => {
  it("侧栏切换独立页面与浏览器返回保留唯一对话草稿，不把首页当新对话", async () => {
    const calls = stubFetch(); const user = userEvent.setup(); render(<StylingPreview />);
    const input = await readyInput(); await user.type(input, "明天通勤，预算500元");
    await user.click(screen.getByRole("button", { name: "我的搭配" }));
    expect(window.location.hash).toBe("#outfit");
    expect(screen.getByRole("region", { name: "我的搭配示例" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "模拟购物袋" }));
    expect(window.location.hash).toBe("#bag");
    expect(screen.getByRole("region", { name: "当前会话模拟购物袋" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "首页" }));
    expect(screen.getByRole("textbox")).toHaveValue("明天通勤，预算500元");
    expect(document.querySelector("main")?.getAttribute("data-mobile-view")).toBe("chat");
    act(() => { window.history.replaceState(null, "", "#history"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByRole("heading", { name: "继续你的穿搭故事" })).toBeInTheDocument();
    act(() => { window.history.replaceState(null, "", "#home"); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByRole("textbox")).toHaveValue("明天通勤，预算500元");
    expect(calls.mock.calls.some(isBusinessWrite)).toBe(false);
  });

  it("无固定look接口时展示未提供状态，不用意向图或M1示例冒充当前推荐", async () => {
    stubFetch([], [{ role: "assistant", content: "已有搭配方案" }]); render(<StylingPreview />);
    await screen.findByText("已有搭配方案");
    expect(screen.getByText("完整搭配图尚未提供")).toBeInTheDocument();
    const canvas = document.querySelector("#outfit-visual");
    expect(canvas?.querySelector('img[src*="editorial-styling"]')).toBeNull();
    expect(screen.getByText(/当前服务未返回固定模特搭配图/)).toBeInTheDocument();
  });

  it("消费者页面不展示内部需求上传，即使服务端返回旧信号编号", async () => {
    const fetchFn = stubFetch([["done", { session_id: "s1", content: "方案", signal_id: "SIG-legacy" }]]);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套通勤装");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("方案")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传需求信号" })).not.toBeInTheDocument();
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/api/v1/signals"))).toBe(false);
  });
  it("展示统一顶栏，当前应用为穿搭", () => {
    stubFetch();
    render(<StylingPreview />);
    expect(screen.getByText("鞋服 AI 协作平台")).toBeInTheDocument();
    const outfit = screen.getByRole("link", { name: "穿搭" });
    expect(outfit).toHaveAttribute("href", "/");
    expect(outfit).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "产品" })).toHaveAttribute("href", process.env.NEXT_PUBLIC_LINK_PRODUCT || "http://localhost:3000");
    expect(screen.getByRole("link", { name: "设计" })).toHaveAttribute("href", process.env.NEXT_PUBLIC_LINK_DESIGN || "http://localhost:5180");
    expect(screen.queryByRole("link", { name: "CMS" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").some(link => /\/admin(?:\/|$|\?)/.test(link.getAttribute("href") || ""))).toBe(false);
    expect(screen.getByRole("link", { name: "产品" })).not.toHaveAttribute("aria-current");
  });

  it("结果页商品提示面板支持Escape返回导航，选择提示后关闭并聚焦唯一草稿", async () => {
    const calls = stubFetch([], [{ role: "assistant", content: "已有搭配方案" }]);
    const user = userEvent.setup(); render(<StylingPreview />);
    await screen.findByText("已有搭配方案");
    await readyInput();
    const browse = screen.getByRole("button", { name: "浏览场景与商品提示" });
    await user.click(browse);
    expect(screen.getByRole("region", { name: "浏览场景与商品提示" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭商品提示" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "浏览场景与商品提示" })).not.toBeInTheDocument();
    expect(browse).toHaveFocus();
    await user.click(browse);
    await user.click(screen.getByRole("button", { name: "日常通勤" }));
    expect(screen.queryByRole("region", { name: "浏览场景与商品提示" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("帮我搭一套日常通勤装，简单利落，走路舒服。");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(calls.mock.calls.some(isBusinessWrite)).toBe(false);
  });

  it("场景只预填草稿并聚焦，修改预算后显式发送才发出一条真实请求", async () => {
    const fetchFn = stubFetch([["done", { session_id: "s1", content: "方案" }]]);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await readyInput();
    await user.click(screen.getByRole("button", { name: /日常通勤/ }));
    const textbox = screen.getByRole("textbox");
    expect(textbox).toHaveValue("帮我搭一套日常通勤装，简单利落，走路舒服。");
    expect(textbox).toHaveFocus();
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/api/v1/chat"))).toBe(false);
    await user.type(textbox, "预算500元，不要紧身。");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("方案")).toBeInTheDocument();
    const chatCalls = fetchFn.mock.calls.filter(([url]) => String(url).includes("/api/v1/chat"));
    expect(chatCalls).toHaveLength(1);
    expect(JSON.parse(String(chatCalls[0][1]?.body)).message).toBe("帮我搭一套日常通勤装，简单利落，走路舒服。预算500元，不要紧身。");
  });

  it("提交后流式显示真实答案", async () => {
    stubFetch([
      ["chunk", { type: "status", message: "正在为你搭配…" }],
      ["chunk", { type: "text", content: "## 推荐方案\n" }],
      ["chunk", { type: "text", content: "「白色基础衬衫」｜上装｜¥159" }],
      ["done", { session_id: "s1", content: "## 推荐方案\n「白色基础衬衫」｜上装｜¥159" }],
    ]);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "通勤，梨形身材，预算500");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText(/白色基础衬衫/)).toBeInTheDocument();
  });

  it("模型出错时展示可读错误信息", async () => {
    stubFetch([["error", { error: { code: "NO_API_KEY", message: "未配置模型 API Key" } }]]);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText(/当前搭配服务暂未就绪，无法生成方案/)).toBeInTheDocument();
    expect(screen.queryByText(/API Key/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("帮我搭一套");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("按 Enter 发送", async () => {
    const fetchFn = stubFetch([["done", { session_id: "s1", content: "方案" }]]);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套{Enter}");
    expect(await screen.findByText("方案")).toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalled();
  });

  it("切换完整搭配和对话保留草稿且不会请求生成，返回输入可继续编辑", async () => {
    const calls = stubFetch(); const user = userEvent.setup(); render(<StylingPreview />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    await user.type(await readyInput(), "保留鞋子，只换浅色上衣");
    await user.click(screen.getByRole("button", { name: "完整搭配" }));
    expect(screen.getByRole("button", { name: "完整搭配" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("figure", { name: "完整搭配与效果图" })).toHaveTextContent("完整搭配图尚未提供");
    await user.click(screen.getByRole("button", { name: "对话" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
    expect(screen.getByRole("textbox")).toHaveValue("保留鞋子，只换浅色上衣");
    expect(calls.mock.calls.some(([url]) => String(url).includes("/chat") || String(url).endsWith("/tryon"))).toBe(false);
  });

  it("中文组合态和Shift+Enter不发送，结束组合后Enter只发送一次", async () => {
    const calls = stubFetch([["done", { session_id: "s1", content: "输入法验证方案" }]]);
    const user = userEvent.setup(); render(<StylingPreview />);
    const input = screen.getByRole("textbox");
    await waitFor(() => expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument());
  await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "通勤，预算500元");
    fireEvent.compositionStart(input);
    await user.keyboard("{Enter}");
    fireEvent.compositionEnd(input);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(calls.mock.calls.some(([url]) => String(url).includes("/chat"))).toBe(false);
    await user.keyboard("{Enter}");
    expect(await screen.findByText("输入法验证方案")).toBeInTheDocument();
    expect(calls.mock.calls.filter(([url]) => String(url).includes("/chat"))).toHaveLength(1);
  });

  it("加载时恢复历史对话", async () => {
    stubFetch([], [
      { role: "user", content: "帮我下单" },
      { role: "assistant", content: "该操作未被授权：本助手仅提供穿搭建议" },
    ]);
    render(<StylingPreview />);
    expect(await screen.findByText(/该操作未被授权/)).toBeInTheDocument();
  });

  it("回答渲染为格式而非原始 Markdown", async () => {
    stubFetch([["done", { session_id: "s1", content: "## 推荐方案\n**白衬衫** 适合通勤。" }]]);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const heading = await screen.findByRole("heading", { name: "推荐方案" });
    expect(heading.tagName).toBe("H2");
    expect(screen.queryByText(/##/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it("方案含商品时展示试穿入口", async () => {
    stubFetch([["done", { session_id: "s1", content: "方案", product_ids: ["P001", "P008"] }]]);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("方案");
    expect(screen.getByRole("button", { name: "上传照片" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "试穿场景" })).toBeInTheDocument();
  });

  it("场景首次确定后不被后续消息覆盖", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      if (url.includes("/api/v1/chat")) {
        return sseResponse([["done", { session_id: "s1", content: "方案", product_ids: ["P001"] }]]);
      }
      if (url.includes("/api/v1/products")) {
        return { ok: true, status: 200, json: async () => ({ products: [{ product_id: "P001", name: "白色基础衬衫", category: "上装", price: 159 }] }) } as unknown as Response;
      }
      if (url.includes("/api/v1/cart")) {
        return { ok: true, status: 200, json: async () => ({ cart: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ messages: [], signals: [], tryons: [] }) } as unknown as Response;
    }));
    const user = userEvent.setup();
    render(<StylingPreview />);
    await readyInput();
    // 第一轮：点“周末出游”场景按钮
    await user.click(screen.getByRole("button", { name: /周末出游/ }));
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("方案");
    expect(screen.getByRole("combobox", { name: "试穿场景" })).toHaveValue("出游");
    // 第二轮：发一条含“通勤”的消息，不应覆盖场景
    await user.type(await readyInput(), "帮我换成通勤装");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findAllByText("方案");
    expect(screen.getByRole("combobox", { name: "试穿场景" })).toHaveValue("出游");
  });

  it("无商品时不展示试穿入口", async () => {
    stubFetch([["done", { session_id: "s1", content: "方案" }]]);
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("方案");
    expect(screen.queryByRole("button", { name: "上传照片" })).not.toBeInTheDocument();
  });

  it("上传照片后调用试穿接口", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/v1/chat")) {
        return sseResponse([["done", { session_id: "s1", content: "方案", product_ids: ["P001"] }]]);
      }
      if (url.includes("/api/v1/tryon/")) {
        return { ok: true, status: 200, json: async () => ({ task_id: "t1", status: "processing" }) } as unknown as Response;
      }
      if (url.includes("/api/v1/tryon")) {
        return { ok: true, status: 200, json: async () => ({ task_id: "t1" }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ messages: [] }) } as unknown as Response;
    }));
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("方案");

    const file = new File(["fakeimage"], "photo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("上传照片"), file);
    // 上传后先预览，点“确认生成”才真正提交
    await user.click(screen.getByRole("button", { name: "确认生成" }));
    await vi.waitFor(() => {
      expect(calls.some((u) => u.endsWith("/api/v1/tryon"))).toBe(true);
    });
  });

  it("上传后先预览，取消则不调用接口", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/v1/chat")) {
        return sseResponse([["done", { session_id: "s1", content: "方案", product_ids: ["P001"] }]]);
      }
      return { ok: true, status: 200, json: async () => ({ messages: [], tryons: [] }) } as unknown as Response;
    }));
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("方案");

    const file = new File(["fakeimage"], "photo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("上传照片"), file);
    expect(screen.getByRole("button", { name: "确认生成" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(calls.some((u) => u.endsWith("/api/v1/tryon"))).toBe(false);
  });

  it("推荐单品可模拟加购，加购后调用加购接口", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/api/v1/chat")) {
        return sseResponse([["done", { session_id: "s1", content: "方案", product_ids: ["P001"], signal_id: "SIG-1" }]]);
      }
      if (url.includes("/api/v1/products")) {
        return { ok: true, status: 200, json: async () => ({ products: [{ product_id: "P001", name: "白色基础衬衫", category: "上装", price: 159 }] }) } as unknown as Response;
      }
      if (url.includes("/api/v1/cart")) {
        return { ok: true, status: 200, json: async () => ({ cart: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ messages: [], signals: [], tryons: [] }) } as unknown as Response;
    }));
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.type(await readyInput(), "帮我搭一套");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("方案");

    const cartBtn = await screen.findByRole("button", { name: "＋ 加购" });
    fireEvent.error(screen.getByRole("img", { name: "白色基础衬衫" }));
    expect(screen.getByRole("img", { name: "白色基础衬衫：商品图片暂缺" })).toHaveTextContent("商品图片暂缺");
    expect(screen.getByText("白色基础衬衫")).toBeInTheDocument();
    expect(screen.getByText("¥159")).toBeInTheDocument();
    await user.click(cartBtn);
    expect(await screen.findByRole("button", { name: "已加购 ✓" })).toBeInTheDocument();
    const cartCall = calls.find((c) => c.url.endsWith("/api/v1/cart") && c.init?.method === "POST");
    expect(cartCall).toBeTruthy();
    expect(String(cartCall?.init?.body)).toContain("\"product_id\":\"P001\"");
  });

  it("模拟加购等待真实结果时防重复点击，成功后仍可继续使用", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const extra = legacyConsumerRoute(input, init); if (extra) return extra;
      const url = String(input);
      if (url.endsWith("/chat")) return sseResponse([["done", { session_id: "s1", content: "模拟加购方案", product_ids: ["P001"] }]]);
      if (url.endsWith("/cart") && init?.method === "POST") return pending;
      const data = url.includes("/products?") ? { products: [{ product_id: "P001", name: "白色基础衬衫", price: 159, category: "上装" }] } : { messages: [], tryons: [], product_ids: [], cart: [] };
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    vi.stubGlobal("fetch", calls); const user = userEvent.setup(); render(<StylingPreview />);
    await user.type(await readyInput(), "一套通勤装"); await user.click(screen.getByRole("button", { name: "发送" }));
    await user.dblClick(await screen.findByRole("button", { name: "＋ 加购" }));
    expect(screen.getByRole("button", { name: "提交中…" })).toBeDisabled();
    expect(calls.mock.calls.filter(([url, init]) => String(url).endsWith("/cart") && init?.method === "POST")).toHaveLength(1);
    await act(async () => { finish({ ok: true, status: 200, json: async () => ({ cart: ["P001"] }) } as Response); });
    expect(await screen.findByRole("button", { name: "已加购 ✓" })).toBeEnabled();
  });
});
