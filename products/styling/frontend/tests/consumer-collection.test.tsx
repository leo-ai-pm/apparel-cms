import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConsumerCollection, type ConsumerCollectionProps } from "../components/consumer-collection";
import type { Product } from "../app/lib/api";
import { SHOWCASE_PRODUCT_IDS } from "../app/lib/showcase-catalog";

const products: Product[] = SHOWCASE_PRODUCT_IDS.map((product_id, index) => ({ product_id,
  name: index === 0 ? "白色通勤衬衫" : index === 1 ? "蓝色休闲长裤" : `真实商品${product_id}`,
  category: index === 0 ? "上装" : index === 1 ? "下装" : "鞋履", color: "白色", price: 100 + index,
  image_url: "https://unapproved.example/product.png",
}));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function props(overrides: Partial<ConsumerCollectionProps> = {}): ConsumerCollectionProps {
  return { mode: "discover", sessionId: "session-one", cartIds: [], onPrefill: vi.fn(), onCartChange: vi.fn(), ...overrides };
}
function stubRequests(handler: (url: URL, method: string) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/api/v1/products") && method === "GET" || url.pathname.includes("/api/v1/cart/") && method === "DELETE") return handler(url, method);
    throw new Error("Unexpected component-test business request");
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const openName = (product: Product) => `查看${product.name}详情`;
const removeName = (product: Product) => `移除${product.name}`;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute("open", ""); this.querySelector<HTMLButtonElement>("button")?.focus(); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterAll(() => {
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("独立商品目录与模拟购物袋", () => {
  it("发现页等待真实21个SKU明细响应，不提前展示固定名称或价格", async () => {
    let finish!: (result: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    const fetcher = stubRequests(() => deferred);
    render(<ConsumerCollection {...props()} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取商品");
    expect(screen.queryByRole("button", { name: openName(products[0]) })).not.toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const url = new URL(String(fetcher.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.get("ids")?.split(",")).toEqual([...SHOWCASE_PRODUCT_IDS]);
    await act(async () => { finish(response({ products })); });
    expect(await screen.findByRole("button", { name: openName(products[0]) })).toHaveTextContent("¥100.00");
    expect(screen.getAllByRole("article")).toHaveLength(21);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("类别和名称搜索组合筛选真实商品，空结果可恢复全部目录且不请求聊天", async () => {
    const fetcher = stubRequests(() => response({ products }));
    const user = userEvent.setup();
    render(<ConsumerCollection {...props()} />);
    await screen.findByRole("button", { name: openName(products[0]) });
    await user.click(screen.getByRole("button", { name: "上装" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "上装" })).toHaveAttribute("aria-pressed", "true");
    await user.type(screen.getByRole("searchbox", { name: "搜索商品名称" }), "休闲");
    expect(screen.getByRole("heading", { name: "没有找到匹配单品" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: openName(products[1]) })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看全部单品" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getAllByRole("article")).toHaveLength(21);
    await user.type(screen.getByRole("searchbox"), "休闲");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("button", { name: openName(products[1]) })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("商品详情可键盘打开/Escape返回原按钮，和顾问聊这件只预填，不发POST或加购", async () => {
    const fetcher = stubRequests(() => response({ products }));
    const input = props();
    const user = userEvent.setup();
    render(<ConsumerCollection {...input} />);
    const button = await screen.findByRole("button", { name: openName(products[0]) });
    button.focus();
    await user.keyboard("{Enter}");
    const detail = await screen.findByRole("dialog", { name: products[0].name });
    expect(within(detail).getByText("P001")).toBeInTheDocument();
    expect(within(detail).getByText("¥100.00")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "和顾问聊这件" }));
    expect(input.onPrefill).toHaveBeenCalledTimes(1);
    expect(input.onPrefill).toHaveBeenCalledWith(expect.stringContaining("白色通勤衬衫"));
    expect(input.onPrefill).toHaveBeenCalledWith(expect.stringContaining("P001"));
    expect(input.onCartChange).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("读取失败是错误，显式重试才恢复真实购物袋完整合计，不显示为空", async () => {
    let reads = 0;
    const fetcher = stubRequests(() => ++reads === 1 ? response({ error: "private backend body" }, 503) : response({ products: products.slice(0, 2) }));
    const user = userEvent.setup();
    render(<ConsumerCollection {...props({ mode: "bag", cartIds: ["P001", "P002"] })} />);
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("不能确认完整合计");
    expect(error).not.toHaveTextContent("private backend body");
    expect(screen.queryByText("购物袋还是空的")).not.toBeInTheDocument();
    expect(screen.queryByText("当前价合计")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "重新读取购物袋" }));
    await screen.findByRole("button", { name: openName(products[0]) });
    const summary = screen.getByRole("complementary", { name: "购物袋价格汇总" });
    expect(summary).toHaveTextContent("当前价合计");
    expect(summary).toHaveTextContent("¥201.00");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("缺失或价格无效SKU保持在购物袋，已知小计不能冒充完整合计", async () => {
    const broken = { ...products[1], price: -5 };
    const fetcher = stubRequests(() => response({ products: [products[0], broken] }));
    render(<ConsumerCollection {...props({ mode: "bag", cartIds: ["P001", "P002", "P999"] })} />);
    await screen.findByRole("button", { name: openName(products[0]) });
    const url = new URL(String(fetcher.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.get("ids")).toBe("P001,P002,P999");
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "P999：商品明细暂缺" })).toBeDisabled();
    const summary = screen.getByRole("complementary", { name: "购物袋价格汇总" });
    expect(summary).toHaveTextContent("已知单品小计");
    expect(summary).toHaveTextContent("¥100.00");
    expect(summary).toHaveTextContent("合计暂无法确认");
    expect(summary).toHaveTextContent("缺少 2 件商品明细（P002、P999）");
    expect(summary).not.toHaveTextContent("当前价合计");
  });

  it("删除失败保留商品，重试等待服务端并阻止重复，成功才回传服务端实际购物袋", async () => {
    let finish!: (result: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    let deletes = 0;
    const fetcher = stubRequests((_, method) => method === "GET" ? response({ products: products.slice(0, 2) })
      : ++deletes === 1 ? response({ error: "private deletion body" }, 500) : deferred);
    const input = props({ mode: "bag", cartIds: ["P001", "P002"] });
    const user = userEvent.setup();
    render(<ConsumerCollection {...input} />);
    const button = await screen.findByRole("button", { name: removeName(products[0]) });
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("商品仍保留");
    expect(screen.getByRole("button", { name: openName(products[0]) })).toBeInTheDocument();
    expect(input.onCartChange).not.toHaveBeenCalled();
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(deletes).toBe(2);
    expect(input.onCartChange).not.toHaveBeenCalled();
    await act(async () => { finish(response({ cart: ["P002", "P005"] })); });
    await waitFor(() => expect(input.onCartChange).toHaveBeenCalledWith(["P002", "P005"]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const deletion = fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletion).toHaveLength(2);
    const url = new URL(String(deletion[0][0]), "http://localhost");
    expect(url.pathname).toMatch(/\/cart\/P001$/);
    expect(url.searchParams.get("session_id")).toBe("session-one");
  });

  it("生成或恢复锁定时仍可查看详情，但不能预填或删除", async () => {
    const fetcher = stubRequests(() => response({ products: [products[0]] }));
    const input = props({ mode: "bag", cartIds: ["P001"], disabled: true });
    const user = userEvent.setup();
    render(<ConsumerCollection {...input} />);
    await user.click(await screen.findByRole("button", { name: openName(products[0]) }));
    const prefill = screen.getByRole("button", { name: "和顾问聊这件" });
    expect(prefill).toBeDisabled();
    await user.click(prefill);
    await user.click(screen.getByRole("button", { name: "关闭商品详情" }));
    const remove = screen.getByRole("button", { name: removeName(products[0]) });
    expect(remove).toBeDisabled();
    await user.click(remove);
    expect(input.onPrefill).not.toHaveBeenCalled();
    expect(input.onCartChange).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("旧会话迟来的商品读取不能覆盖新会话的购物袋或合计", async () => {
    let finish!: (result: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    stubRequests(url => url.searchParams.get("ids") === "P001" ? deferred : response({ products: [products[1]] }));
    const view = render(<ConsumerCollection {...props({ mode: "bag", cartIds: ["P001"] })} />);
    view.rerender(<ConsumerCollection {...props({ mode: "bag", sessionId: "session-two", cartIds: ["P002"] })} />);
    await screen.findByRole("button", { name: openName(products[1]) });
    await act(async () => { finish(response({ products: [products[0]] })); });
    expect(screen.queryByRole("button", { name: openName(products[0]) })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "购物袋价格汇总" })).toHaveTextContent("¥101.00");
  });

  it("只展示授权静态图片，图片失败保留真实商品信息；目录外SKU不读取未授权URL", async () => {
    const unknown = { ...products[1], product_id: "P999", name: "旧目录商品" };
    stubRequests(() => response({ products: [products[0], unknown] }));
    render(<ConsumerCollection {...props({ mode: "bag", cartIds: ["P001", "P999"] })} />);
    const known = await screen.findByRole("button", { name: openName(products[0]) });
    const image = within(known).getByRole("img", { name: products[0].name });
    expect(image.getAttribute("src")).toContain(encodeURIComponent("/showcase-products/P001.png"));
    expect(image.getAttribute("src")).not.toContain("unapproved");
    fireEvent.error(image);
    expect(within(known).getByText("商品图片暂缺")).toBeInTheDocument();
    expect(known).toHaveTextContent("白色通勤衬衫");
    expect(known).toHaveTextContent("¥100.00");
    const old = screen.getByRole("button", { name: openName(unknown) });
    expect(within(old).queryByRole("img")).not.toBeInTheDocument();
    expect(within(old).getByText("商品图片暂缺")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "购物袋价格汇总" })).toHaveTextContent("¥201.00");
  });

  it("真实空购物袋不请求商品接口，明确模拟状态且没有订单或付款按钮", async () => {
    const fetcher = stubRequests(() => { throw new Error("An empty bag must not request products"); });
    render(<ConsumerCollection {...props({ mode: "bag" })} />);
    expect(await screen.findByRole("heading", { name: "购物袋还是空的" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "购物袋价格汇总" })).toHaveTextContent("¥0.00");
    expect(screen.getByText(/不创建订单/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /支付|下单|结算/ })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("旧会话迟来的删除确认不会更改已切换的新会话购物袋", async () => {
    let finish!: (result: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    stubRequests((url, method) => method === "DELETE" ? deferred : response({ products: products.filter(product => url.searchParams.get("ids")?.split(",").includes(product.product_id)) }));
    const input = props({ mode: "bag", cartIds: ["P001"] });
    const user = userEvent.setup();
    const view = render(<ConsumerCollection {...input} />);
    await user.click(await screen.findByRole("button", { name: removeName(products[0]) }));
    view.rerender(<ConsumerCollection {...input} sessionId="session-two" cartIds={["P002"]} />);
    await screen.findByRole("button", { name: openName(products[1]) });
    await act(async () => { finish(response({ cart: [] })); });
    expect(input.onCartChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: removeName(products[1]) })).toBeEnabled();
    expect(screen.getByRole("complementary", { name: "购物袋价格汇总" })).toHaveTextContent("¥101.00");
  });
});
