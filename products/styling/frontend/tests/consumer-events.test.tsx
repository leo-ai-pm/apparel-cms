import { StrictMode, useRef, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsumerEventRecorder, validateConsumerEventInput, type ConsumerEventBody, type ConsumerEventInput, type ConsumerPage } from "../app/lib/consumer-events";
import { ConsumerCollection } from "../components/consumer-collection";
import { ConsumerEventNotice, ConsumerEventsProvider, ConsumerObservedImage, useConsumerEventSession, useConsumerEvents, useConsumerExposure } from "../components/consumer-events";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function eventTransport() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return response({ event_id: body.event_id, duplicate: false, source: "client", data_origin: "runtime_demo", is_simulated: true });
  });
}
const eventsOf = (fetcher: ReturnType<typeof eventTransport>, name?: string) => fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as ConsumerEventBody).filter(body => !name || body.event_name === name);
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };

class Observer {
  static all: Observer[] = [];
  elements = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) { Observer.all.push(this); }
  observe = (element: Element) => { this.elements.add(element); };
  unobserve = (element: Element) => { this.elements.delete(element); };
  disconnect = () => this.elements.clear();
  static show(ratio: number) {
    for (const observer of Observer.all.filter(item => item.elements.size > 0)) observer.callback([...observer.elements].map(target => ({ target, isIntersecting: ratio > 0, intersectionRatio: ratio }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver);
  }
}
function Provider({ children, page = "home", active = true, sessionId = "events-unit-session" }: { children: ReactNode; page?: ConsumerPage; active?: boolean; sessionId?: string }) {
  const value = useConsumerEventSession(sessionId, page, active);
  return <ConsumerEventsProvider value={value}>{children}<ConsumerEventNotice controller={value} /></ConsumerEventsProvider>;
}
function Exposure({ loaded = true, active = true, hidden = false }: { loaded?: boolean; active?: boolean; hidden?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useConsumerExposure(ref, { imageLoaded: loaded, active, event: { event_name: "product_impression", product_id: "P001", source_slot: "home_hero" } });
  return <div ref={ref} hidden={hidden}>商品</div>;
}
function EmitButton() {
  const events = useConsumerEvents();
  return <button onClick={() => events?.emit({ event_name: "draft_prefill", source_slot: "scene_commute" })}>预填</button>;
}

beforeEach(() => { sessionStorage.clear(); Observer.all = []; vi.stubGlobal("IntersectionObserver", Observer); });
afterEach(() => { vi.useRealTimers(); });

describe("消费者白名单事件与同体重试", () => {
  it("拒绝业务成功、正文、PII、无效来源和缺少必要事实，不向网络发出", () => {
    const fetcher = eventTransport();
    const recorder = new ConsumerEventRecorder("allowlist-unit", fetcher);
    const invalid: unknown[] = [
      { event_name: "generation_succeeded", source_slot: "workspace" },
      { event_name: "draft_prefill", source_slot: "home", draft: "private draft" },
      { event_name: "draft_prefill", source_slot: "home", email: "private@example.test" },
      { event_name: "draft_prefill", source_slot: "用户的私人正文" },
      { event_name: "message_submit", source_slot: "composer" },
      { event_name: "product_impression", source_slot: "catalog", product_id: "P001", image_loaded: true, visible_fraction: .49, dwell_ms: 1000 },
      { event_name: "outfit_displayed", source_slot: "workspace", look_version_id: "lv-1", sku_ids: ["a", "b", "b"], image_loaded: true, canvas_visible: true },
    ];
    for (const input of invalid) expect(() => recorder.emit(input as ConsumerEventInput)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("失败与刷新后的人工重试保持同 event_id、时间和逐字 body，且回执才移除失败", async () => {
    const calls: string[] = [];
    let succeeds = false;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(init?.body));
      if (!succeeds) return response({}, 503);
      const body = JSON.parse(String(init?.body));
      return response({ event_id: body.event_id, duplicate: true, source: "client", data_origin: "runtime_demo", is_simulated: true });
    });
    const recorder = new ConsumerEventRecorder("retry-unit", fetcher);
    recorder.enterPage("home");
    await flush();
    expect(recorder.getSnapshot().records[0].status).toBe("failed");
    const original = recorder.getSnapshot().records[0];
    const recovered = new ConsumerEventRecorder("retry-unit", fetcher);
    expect(recovered.getSnapshot().records[0].serialized).toBe(original.serialized);
    succeeds = true;
    recovered.retry(original.body.event_id);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
    expect(recovered.getSnapshot().records).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem("styling.consumer-events.v1:retry-unit")!)).toEqual([]);
  });

  it("HTTP200的缺失或错误回执仍保留失败，409不改身份自动重报", async () => {
    const fetcher = vi.fn(async () => response({ event_id: "wrong", duplicate: false, source: "client", data_origin: "runtime_demo", is_simulated: true }));
    const recorder = new ConsumerEventRecorder("receipt-unit", fetcher);
    recorder.enterPage("home");
    await flush();
    expect(recorder.getSnapshot().records[0].error).toContain("编号不一致");
    fetcher.mockImplementation(async () => response({}, 409));
    recorder.retryAll();
    await flush();
    expect(recorder.getSnapshot().records[0].error).toContain("编号冲突");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("page_view每次实际进入一次，StrictMode和重渲染不重复，返回首页生成新范围", async () => {
    const fetcher = eventTransport(); vi.stubGlobal("fetch", fetcher);
    const view = render(<StrictMode><Provider><EmitButton /></Provider></StrictMode>);
    await flush();
    view.rerender(<StrictMode><Provider><EmitButton /></Provider></StrictMode>);
    await flush();
    expect(eventsOf(fetcher, "page_view")).toHaveLength(1);
    view.rerender(<StrictMode><Provider page="discover"><EmitButton /></Provider></StrictMode>);
    await flush();
    view.rerender(<StrictMode><Provider><EmitButton /></Provider></StrictMode>);
    await flush();
    const pages = eventsOf(fetcher, "page_view");
    expect(pages.map(row => row.page)).toEqual(["home", "discover", "home"]);
    expect(new Set(pages.map(row => row.page_view_id)).size).toBe(3);
  });

  it("目录详情实际打开才上报，每次重新打开一次，商品预填只发元数据", async () => {
    const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute("open"); } });
    const observed: ConsumerEventBody[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return response({ products: [{ product_id: "P001", name: "示例衬衫", category: "上装", price: 100, color: "白色" }] });
      const body = JSON.parse(String(init.body)); observed.push(body);
      return response({ event_id: body.event_id, duplicate: false, source: "client", data_origin: "runtime_demo", is_simulated: true });
    }));
    const onPrefill = vi.fn();
    try {
      const contents = <ConsumerCollection mode="discover" sessionId="events-unit-session" cartIds={[]} onPrefill={onPrefill} onCartChange={vi.fn()} />;
      const view = render(<Provider page="discover">{contents}</Provider>);
      await flush();
      expect(observed.filter(body => body.event_name === "product_detail_open")).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "查看示例衬衫详情" })); await flush();
      expect(screen.getByRole("dialog")).toBeVisible();
      view.rerender(<Provider page="discover">{contents}</Provider>); await flush();
      expect(observed.filter(body => body.event_name === "product_detail_open")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "关闭商品详情" }));
      fireEvent.click(screen.getByRole("button", { name: "查看示例衬衫详情" })); await flush();
      expect(observed.filter(body => body.event_name === "product_detail_open")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "和顾问聊这件" })); await flush();
      expect(onPrefill).toHaveBeenCalledTimes(1);
      const prefill = observed.filter(body => body.event_name === "draft_prefill");
      expect(prefill).toHaveLength(1);
      expect(prefill[0]).toMatchObject({ product_id: "P001", source_slot: "discover_detail" });
      expect(JSON.stringify(observed)).not.toContain("示例衬衫");
    } finally {
      if (show) Object.defineProperty(HTMLDialogElement.prototype, "showModal", show); else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      if (close) Object.defineProperty(HTMLDialogElement.prototype, "close", close); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });

  it("预填只记录白名单动作元数据，失败可见且不阻塞随后动作", async () => {
    const fetcher = eventTransport(); vi.stubGlobal("fetch", fetcher);
    fetcher.mockImplementation(async () => response({}, 503));
    render(<Provider><EmitButton /></Provider>);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("不影响继续搭配");
    fireEvent.click(screen.getByText("预填")); await flush();
    const prefill = eventsOf(fetcher, "draft_prefill")[0];
    expect(Object.keys(prefill).sort()).toEqual(["event_name", "source_slot", "schema_version", "event_id", "session_id", "page_view_id", "page", "occurred_at"].sort());
    expect(screen.getByRole("button", { name: "重试保存浏览记录" })).toBeEnabled();
  });
});

describe("真实图片曝光门禁", () => {
  it("图片未加载不计时，低于50%不计时，连续一秒才发且同页同位置去重", async () => {
    vi.useFakeTimers(); const fetcher = eventTransport(); vi.stubGlobal("fetch", fetcher);
    const view = render(<Provider><Exposure loaded={false} /></Provider>);
    await flush(); act(() => Observer.show(1)); await tick(2000);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
    view.rerender(<Provider><Exposure /></Provider>); await flush();
    act(() => Observer.show(.49)); await tick(1500);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
    act(() => Observer.show(.75)); await tick(999);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
    await tick(1);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(1);
    const body = eventsOf(fetcher, "product_impression")[0];
    expect(body).toMatchObject({ image_loaded: true, visible_fraction: .75, dwell_ms: 1000, product_id: "P001" });
    view.rerender(<Provider><Exposure key="remounted" /></Provider>); await flush();
    act(() => Observer.show(1)); await tick(1200);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(1);
  });

  it("中途离开视口和切入后台重置整秒，切页重新核对并取消旧计时", async () => {
    vi.useFakeTimers(); const fetcher = eventTransport(); vi.stubGlobal("fetch", fetcher);
    const view = render(<Provider><Exposure /></Provider>); await flush();
    act(() => Observer.show(1)); await tick(700);
    act(() => Observer.show(0)); await tick(700);
    act(() => Observer.show(1)); await tick(700);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange")); await tick(500);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange")); await tick(900);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
    view.rerender(<Provider page="discover"><Exposure /></Provider>); await flush(); await tick(200);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
    act(() => Observer.show(1)); await tick(1000);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(1);
    expect(eventsOf(fetcher, "product_impression")[0].page).toBe("discover");
  });

  it("hidden、inactive、卸载和pagehide取消曝光，未加载图片不能借另一张图片曝光", async () => {
    vi.useFakeTimers(); const fetcher = eventTransport(); vi.stubGlobal("fetch", fetcher);
    const view = render(<Provider><Exposure hidden /></Provider>); await flush(); act(() => Observer.show(1)); await tick(1200);
    expect(eventsOf(fetcher, "product_impression"), "hidden").toHaveLength(0);
    view.rerender(<Provider><Exposure active={false} /></Provider>); await flush(); act(() => Observer.show(1)); await tick(1200);
    expect(eventsOf(fetcher, "product_impression"), "inactive").toHaveLength(0);
    view.rerender(<Provider><Exposure /></Provider>); await flush(); act(() => Observer.show(1)); await tick(500);
    expect(eventsOf(fetcher, "product_impression"), "beforehide").toHaveLength(0);
    fireEvent(window, new Event("pagehide")); await tick(700);
    expect(eventsOf(fetcher, "product_impression"), "afterhide").toHaveLength(0);
    view.unmount(); await tick(2000);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
  });

  it("实际图片load且naturalWidth有效后才能曝光，error取消未完成曝光", async () => {
    vi.useFakeTimers(); const fetcher = eventTransport(); vi.stubGlobal("fetch", fetcher);
    render(<Provider><ConsumerObservedImage src="/showcase-products/P001.png" alt="衬衫" width={100} height={100} observation={{ event_name: "product_impression", source_slot: "grid", product_id: "P001" }} /></Provider>);
    await flush();
    const image = screen.getByRole("img", { name: "衬衫" });
    act(() => Observer.show(1)); await tick(1200);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
    fireEvent.load(image); await flush(); act(() => Observer.show(1)); await tick(500);
    fireEvent.error(image); await tick(1000);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(0);
  });

  it("完成加载的真实图片达到停留阈值后发送曝光，不把未解码图片当成功", async () => {
    vi.useFakeTimers(); const fetcher = eventTransport(); vi.stubGlobal("fetch", fetcher);
    render(<Provider><ConsumerObservedImage src="/showcase-products/P002.png" alt="夹克" width={100} height={100} observation={{ event_name: "product_impression", source_slot: "grid", product_id: "P002" }} /></Provider>);
    await flush();
    const image = screen.getByRole("img", { name: "夹克" });
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
    fireEvent.load(image); await flush();
    act(() => Observer.show(.6)); await tick(1000);
    expect(eventsOf(fetcher, "product_impression")).toHaveLength(1);
    expect(eventsOf(fetcher, "product_impression")[0]).toMatchObject({ product_id: "P002", image_loaded: true, visible_fraction: .6 });
  });

  it("独立示例只报example_exposure；无provider不发请求", async () => {
    vi.useFakeTimers(); const fetcher = eventTransport(); vi.stubGlobal("fetch", fetcher);
    function Example() { const ref = useRef<HTMLDivElement>(null); useConsumerExposure(ref, { imageLoaded: true, event: { event_name: "example_exposure", source_slot: "lookbook_M1V2-LOOK-101" } }); return <div ref={ref}>示例</div>; }
    const view = render(<Example />); act(() => Observer.show(1)); await tick(1500); expect(fetcher).not.toHaveBeenCalled();
    view.rerender(<Provider><Example /></Provider>); await flush(); act(() => Observer.show(1)); await tick(1000);
    expect(eventsOf(fetcher, "example_exposure")).toHaveLength(1);
    expect(eventsOf(fetcher, "outfit_displayed")).toHaveLength(0);
    expect(() => validateConsumerEventInput(eventsOf(fetcher, "example_exposure")[0] as ConsumerEventInput)).toThrow(); // Full body cannot be re-used as an input to bypass the whitelist.
  });
});
