import { legacyConsumerRoute, isBusinessWrite } from "./consumer-test-routes";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionId, type Product } from "../app/lib/api";
import { StylingPreview } from "../components/styling-preview";

const products: Product[] = [
  { product_id: "P001", name: "回归白衬衫", category: "上装", color: "白色", price: 159 },
  { product_id: "P002", name: "回归通勤长裤", category: "下装", color: "蓝色", price: 199 },
];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (event: string, data: unknown) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
function deferredResponse() {
  let resolve!: (result: Response) => void;
  const promise = new Promise<Response>(finish => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixture(options: {
  cart?: string[];
  cartRead?: () => Response | Promise<Response>;
  savedImage?: boolean;
  write?: (url: URL, init: RequestInit) => Response | Promise<Response>;
} = {}) {
  const sessionId = getSessionId();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const extra = legacyConsumerRoute(input, init); if (extra) return extra;
    const url = new URL(String(input), "http://localhost");
    if (init?.method && init.method !== "GET") {
      if (options.write) return options.write(url, init);
      throw new Error("Unexpected journey-regression write request");
    }
    if (url.pathname === `/api/v1/sessions/${sessionId}/messages`) return response({ messages: [{ role: "assistant", content: "独立保存的原搭配建议" }] });
    if (url.pathname === "/api/v1/tryon") return response({ tryons: options.savedImage ? [{
      task_id: "saved-regression-image", status: "succeeded", result_url: "/tryon-results/regression-saved.png", product_ids: ["P001"], scene: "通勤",
    }] : [] });
    if (url.pathname === "/api/v1/recommendations") return response({ product_ids: products.map(product => product.product_id) });
    if (url.pathname === "/api/v1/products") {
      const ids = url.searchParams.get("ids")?.split(",") ?? [];
      return response({ products: products.filter(product => ids.includes(product.product_id)) });
    }
    if (url.pathname === "/api/v1/cart") return options.cartRead ? options.cartRead() : response({ cart: options.cart ?? [] });
    throw new Error(`Unexpected journey-regression read: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, sessionId };
}

async function recoveredInput() {
  await screen.findByText("独立保存的原搭配建议");
  const input = screen.getByRole("textbox", { name: "说说你的穿搭需求" });
  await waitFor(() => expect(input).toBeEnabled());
  return input;
}

function changeHash(hash: string) {
  act(() => {
    window.history.replaceState(null, "", hash || "/");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

describe("消费者跨页面与并发操作回归", () => {
  it("商品详情Escape与native cancel只关闭弹窗，发现页保留，外层Escape才返回工作区", async () => {
    const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) {
      this.setAttribute("open", "");
      this.querySelector<HTMLButtonElement>("button")?.focus();
    } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute("open"); } });
    try {
      const { fetcher } = fixture();
      const user = userEvent.setup();
      render(<StylingPreview />);
      const input = await recoveredInput();
      const draft = "详情关闭后保留：通勤预算500元，裤子不换。";
      await user.type(input, draft);
      const browse = screen.getByRole("button", { name: "浏览场景与商品提示" });
      await user.click(browse);
      const discovery = screen.getByRole("region", { name: "浏览场景与商品提示" });
      const card = await within(discovery).findByRole("button", { name: "查看回归白衬衫详情" });
      await user.click(card);
      const dialog = screen.getByRole("dialog", { name: "回归白衬衫" });
      expect(dialog).toHaveAttribute("open");
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "浏览场景与商品提示" })).toBe(discovery);
      expect(window.location.hash).toBe("#discover");
      expect(browse).toHaveAttribute("aria-expanded", "true");
      expect(card).toHaveFocus();

      await user.click(card);
      const reopened = screen.getByRole("dialog", { name: "回归白衬衫" });
      fireEvent(reopened, new Event("cancel", { bubbles: true, cancelable: true }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "浏览场景与商品提示" })).toBe(discovery);
      expect(window.location.hash).toBe("#discover");
      expect(card).toHaveFocus();

      fireEvent.keyDown(discovery, { key: "Escape" });
      expect(window.location.hash).toBe("#outfit");
      expect(screen.queryByRole("region", { name: "浏览场景与商品提示" })).not.toBeInTheDocument();
      expect(browse).toHaveAttribute("aria-expanded", "false");
      expect(browse).toHaveFocus();
      expect(screen.getByRole("textbox")).toHaveValue(draft);
      expect(screen.getByText("独立保存的原搭配建议")).toBeInTheDocument();
      expect(fetcher.mock.calls.some(isBusinessWrite)).toBe(false);
    } finally {
      cleanup();
      if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });

  it("穿搭品牌普通点击阻止整页导航，通过首页hash保留草稿与会话编号", async () => {
    const { fetcher, sessionId } = fixture();
    const user = userEvent.setup();
    render(<StylingPreview />);
    const input = await recoveredInput();
    const draft = "品牌返回也保留：预算600元，鞋子不换。";
    await user.type(input, draft);
    await user.click(screen.getByRole("button", { name: "我的搭配" }));
    const readsBefore = fetcher.mock.calls.filter(([value]) => String(value).includes("/messages")).length;
    expect(fireEvent.click(screen.getByRole("link", { name: "穿搭" }), { button: 0 })).toBe(false);
    expect(window.location.hash).toBe("#home");
    expect(screen.getByRole("textbox")).toHaveValue(draft);
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(getSessionId()).toBe(sessionId);
    expect(fetcher.mock.calls.filter(([value]) => String(value).includes("/messages"))).toHaveLength(readsBefore);
    expect(fetcher.mock.calls.some(isBusinessWrite)).toBe(false);
  });

  it("初始购物袋读取503后进入购物袋显示未知错误，重试真实空响应才显示空与零合计", async () => {
    let reads = 0;
    const { fetcher } = fixture({ cartRead: () => ++reads === 1 ? response({ error: "private cart trace" }, 503) : response({ cart: [] }) });
    const user = userEvent.setup();
    render(<StylingPreview />);
    const input = await recoveredInput();
    await user.type(input, "购物袋读失败也保留的草稿");
    await user.click(screen.getByRole("button", { name: "模拟购物袋" }));
    const bag = screen.getByRole("region", { name: "当前会话模拟购物袋" });
    expect(within(bag).getByRole("alert")).toHaveTextContent("模拟加购记录暂时无法读取");
    expect(within(bag).getByRole("alert")).toHaveTextContent("不能确认购物袋内容与合计");
    expect(within(bag).queryByText("购物袋还是空的")).not.toBeInTheDocument();
    expect(within(bag).queryByText("¥0.00")).not.toBeInTheDocument();
    expect(within(bag).queryByRole("complementary", { name: "购物袋价格汇总" })).not.toBeInTheDocument();
    expect(within(bag).queryByText("private cart trace")).not.toBeInTheDocument();
    expect(reads).toBe(1);
    await user.click(within(bag).getByRole("button", { name: "重新读取购物袋记录" }));
    expect(await within(bag).findByRole("heading", { name: "购物袋还是空的" })).toBeInTheDocument();
    expect(within(bag).getByRole("complementary", { name: "购物袋价格汇总" })).toHaveTextContent("当前价合计");
    expect(within(bag).getByRole("complementary", { name: "购物袋价格汇总" })).toHaveTextContent("¥0.00");
    expect(within(bag).queryByRole("alert")).not.toBeInTheDocument();
    expect(reads).toBe(2);
    await user.click(screen.getByRole("button", { name: "首页" }));
    expect(screen.getByRole("textbox")).toHaveValue("购物袋读失败也保留的草稿");
    expect(fetcher.mock.calls.some(isBusinessWrite)).toBe(false);
  });

  it("重复点击当前我的搭配后，完整输入草稿不会被页面标题偷走焦点", async () => {
    const { fetcher } = fixture();
    const user = userEvent.setup();
    render(<StylingPreview />);
    const input = await recoveredInput();
    const current = screen.getByRole("button", { name: "我的搭配" });
    await user.click(current);
    await user.click(current);
    const draft = "明天通勤，预算500元。保留这双鞋，想换浅色上衣和宽松裤子。";
    await user.type(input, draft);
    expect(input).toHaveValue(draft);
    expect(input).toHaveFocus();
    expect(screen.getByRole("heading", { name: "我的搭配", level: 1 })).not.toHaveFocus();
    expect(fetcher.mock.calls.some(isBusinessWrite)).toBe(false);
  });

  it("手机完整搭配返回首页切回对话并保留草稿，无hash返回清除发现/历史展开状态", async () => {
    vi.stubGlobal("innerWidth", 390);
    const { fetcher } = fixture();
    const user = userEvent.setup();
    render(<StylingPreview />);
    const input = await recoveredInput();
    const draft = "手机草稿：保留白衬衫，只换鞋子，预算300元。";
    await user.type(input, draft);
    await user.click(screen.getByRole("button", { name: "完整搭配" }));
    expect(document.querySelector("main#top")).toHaveAttribute("data-mobile-view", "outfit");
    await user.click(screen.getByRole("button", { name: "首页" }));
    expect(document.querySelector("main#top")).toHaveAttribute("data-mobile-view", "chat");
    expect(screen.getByRole("textbox")).toHaveValue(draft);
    expect(screen.getByRole("textbox")).toHaveFocus();

    const browse = screen.getByRole("button", { name: "浏览场景与商品提示" });
    const history = screen.getByRole("button", { name: "历史对话" });
    await user.click(browse);
    expect(browse).toHaveAttribute("aria-expanded", "true");
    changeHash("");
    expect(window.location.hash).toBe("");
    expect(browse).toHaveAttribute("aria-expanded", "false");
    expect(history).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "浏览场景与商品提示" })).not.toBeInTheDocument();
    await user.click(history);
    expect(history).toHaveAttribute("aria-expanded", "true");
    changeHash("");
    expect(browse).toHaveAttribute("aria-expanded", "false");
    expect(history).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "历史对话" })).not.toBeInTheDocument();
    expect(document.querySelector("main#top")).toHaveAttribute("data-mobile-view", "chat");
    expect(screen.getByRole("textbox")).toHaveValue(draft);
    expect(fetcher.mock.calls.some(isBusinessWrite)).toBe(false);
  });

  it("两个SKU并发取消且DELETE逆序返回，后完成的旧响应不会复活另一件", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const { fetcher } = fixture({ cart: ["P001", "P002"], write: (url, init) => {
      if (init.method === "DELETE" && url.pathname === "/api/v1/cart/P001") return first.promise;
      if (init.method === "DELETE" && url.pathname === "/api/v1/cart/P002") return second.promise;
      throw new Error("Unexpected concurrent-cart write");
    } });
    const user = userEvent.setup();
    render(<StylingPreview />);
    await recoveredInput();
    const items = screen.getByRole("complementary", { name: "当前推荐单品" });
    const added = within(items).getAllByRole("button", { name: "已加购 ✓" });
    expect(added).toHaveLength(2);
    await user.click(added[0]);
    await user.click(added[1]);
    const pending = within(items).getAllByRole("button", { name: "提交中…" });
    expect(pending).toHaveLength(2);
    for (const button of pending) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-pressed", "true");
    }
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    await act(async () => { second.resolve(response({ cart: ["P001"] })); });
    expect(within(items).getByRole("button", { name: "＋ 加购" })).toHaveAttribute("aria-pressed", "false");
    expect(within(items).getByRole("button", { name: "提交中…" })).toHaveAttribute("aria-pressed", "true");
    await act(async () => { first.resolve(response({ cart: ["P002"] })); });
    await waitFor(() => expect(within(items).getAllByRole("button", { name: "＋ 加购" })).toHaveLength(2));
    for (const button of within(items).getAllByRole("button", { name: "＋ 加购" })) expect(button).toHaveAttribute("aria-pressed", "false");
    expect(within(items).queryByRole("button", { name: "已加购 ✓" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("旧图缺失后新SSE仍在生成时不能重读记录，done继续生效且输入可继续", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const { fetcher, sessionId } = fixture({ savedImage: true, write: (url, init) => {
      if (init.method !== "POST" || url.pathname !== "/api/v1/chat") throw new Error("Unexpected image-recovery write");
      controller.enqueue(sse("chunk", { type: "status", message: "新请求正在真实等待单元桩结果" }));
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    } });
    const user = userEvent.setup();
    render(<StylingPreview />);
    const input = await recoveredInput();
    const image = screen.getByRole("img", { name: "已保存的AI合成效果图，非真实试穿或尺码效果" });
    fireEvent.error(image);
    const reread = await screen.findByRole("button", { name: "重新读取图片记录" });
    expect(reread).toBeEnabled();
    await user.type(input, "保留旧建议，换一套适合周末散步的搭配");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("新请求正在真实等待单元桩结果");
    expect(input).toBeDisabled();
    expect(reread).toBeDisabled();
    const before = fetcher.mock.calls.filter(([, init]) => !init?.method || init.method === "GET").length;
    await user.click(reread);
    expect(fetcher.mock.calls.filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(before);
    expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument();

    await act(async () => {
      controller.enqueue(sse("done", { session_id: sessionId, content: "新SSE最终建议没有被恢复epoch丢弃", product_ids: [] }));
      controller.close();
    });
    expect(await screen.findByText("新SSE最终建议没有被恢复epoch丢弃")).toBeInTheDocument();
    expect(screen.getByText("独立保存的原搭配建议")).toBeInTheDocument();
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "下一条草稿仍可完整编辑");
    expect(input).toHaveValue("下一条草稿仍可完整编辑");
    expect(input).toHaveFocus();
    expect(reread).toBeEnabled();
    expect(fetcher.mock.calls.filter(call => isBusinessWrite(call) && call[1]?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(before);
  });
});
