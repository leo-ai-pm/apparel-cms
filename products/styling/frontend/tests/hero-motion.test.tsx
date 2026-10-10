import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHeroMotion } from "../components/use-hero-motion";

const desktopQuery = "(min-width: 901px) and (prefers-reduced-motion: no-preference)";
const pointerQuery = "(hover: hover) and (pointer: fine)";

function media(initial: boolean, query: string) {
  let matches = initial;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const result = {
    get matches() { return matches; },
    media: query,
    onchange: null,
    addEventListener: vi.fn((_name: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener)),
    removeEventListener: vi.fn((_name: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener)),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  return {
    result,
    listeners,
    set(value: boolean) {
      matches = value;
      const event = { matches, media: query } as MediaQueryListEvent;
      for (const listener of [...listeners]) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    },
  };
}

const observers: MockIntersectionObserver[] = [];
class MockIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  readonly takeRecords = vi.fn(() => []);
  constructor(private readonly callback: IntersectionObserverCallback) { observers.push(this); }
  show(target: Element, visible: boolean) {
    this.callback([{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function Harness({ active = true, paused = false, compact = false }: { active?: boolean; paused?: boolean; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useHeroMotion(ref, active && !compact, paused);
  return <div ref={ref} data-testid="hero"><div data-hero-sku="P001"><button>已有商品</button></div></div>;
}

let desktop: ReturnType<typeof media>;
let finePointer: ReturnType<typeof media>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let frameTime: number;
let hidden: boolean;
let cancelFrame: ReturnType<typeof vi.fn>;

function hero() { return screen.getByTestId("hero"); }
function pointerMove(target = hero()) {
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 1000, height: 300, right: 1000, bottom: 300, toJSON() {} });
  const event = new MouseEvent("pointermove", { bubbles: true, clientX: 900, clientY: 240 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  fireEvent(target, event);
}
function frame() {
  const pending = [...frames];
  frames.clear();
  frameTime += 16;
  act(() => { for (const [, callback] of pending) callback(frameTime); });
}
function setHidden(value: boolean) {
  hidden = value;
  fireEvent(document, new Event("visibilitychange"));
}

beforeEach(() => {
  desktop = media(true, desktopQuery);
  finePointer = media(true, pointerQuery);
  frames = new Map();
  nextFrame = 1;
  frameTime = 0;
  hidden = false;
  observers.length = 0;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
  vi.stubGlobal("matchMedia", vi.fn((query: string) => query === desktopQuery ? desktop.result : query === pointerQuery ? finePointer.result : media(false, query).result));
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; }));
  cancelFrame = vi.fn((id: number) => { frames.delete(id); });
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("桌面首页商品动效生命周期", () => {
  it("缺少媒体查询能力时保持静态，不开始监听视口或调度动画", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Harness />);
    expect(hero()).toHaveAttribute("data-motion-mode", "static");
    pointerMove();
    expect(frames.size).toBe(0);
    expect(observers).toHaveLength(0);
  });

  it.each([{ active: false, compact: false }, { active: true, compact: true }])("非首页或紧凑模式不启动动效：%j", props => {
    render(<Harness {...props} />);
    expect(hero()).toHaveAttribute("data-motion-mode", "static");
    pointerMove();
    expect(frames.size).toBe(0);
    expect(observers).toHaveLength(0);
  });

  it("用户暂停、恢复以及动态偏好变化立即切换状态，非桌面也保持静态", () => {
    const view = render(<Harness />);
    expect(hero()).toHaveAttribute("data-motion-mode", "running");
    view.rerender(<Harness paused />);
    expect(hero()).toHaveAttribute("data-motion-mode", "paused");
    pointerMove();
    expect(frames.size).toBe(0);
    view.rerender(<Harness />);
    expect(hero()).toHaveAttribute("data-motion-mode", "running");
    act(() => desktop.set(false));
    expect(hero()).toHaveAttribute("data-motion-mode", "static");
    pointerMove();
    expect(frames.size).toBe(0);
    act(() => desktop.set(true));
    expect(hero()).toHaveAttribute("data-motion-mode", "running");
  });

  it("滚出视口或切到后台暂停，须同时回到可见视口与前台才继续", () => {
    render(<Harness />);
    const observer = observers.at(-1)!;
    expect(observer.observe).toHaveBeenCalledWith(hero());
    act(() => observer.show(hero(), false));
    expect(hero()).toHaveAttribute("data-motion-mode", "paused");
    setHidden(true);
    act(() => observer.show(hero(), true));
    expect(hero()).toHaveAttribute("data-motion-mode", "paused");
    setHidden(false);
    expect(hero()).toHaveAttribute("data-motion-mode", "running");
    setHidden(true);
    expect(hero()).toHaveAttribute("data-motion-mode", "paused");
  });

  it("只有细指针且正在运行时鼠标移动才调度视差，暂停或离开首页取消在途帧", () => {
    finePointer.set(false);
    const view = render(<Harness />);
    expect(hero()).toHaveAttribute("data-motion-mode", "running");
    pointerMove();
    expect(frames.size).toBe(0);
    act(() => finePointer.set(true));
    pointerMove();
    expect(frames.size).toBeGreaterThan(0);
    frame();
    expect(Number.parseFloat(hero().style.getPropertyValue("--pointer-x"))).toBeGreaterThan(0);
    expect(Number.parseFloat(hero().style.getPropertyValue("--pointer-y"))).toBeGreaterThan(0);
    view.rerender(<Harness paused />);
    expect(cancelFrame).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    pointerMove();
    expect(frames.size).toBe(0);
    view.rerender(<Harness />);
    pointerMove();
    expect(frames.size).toBeGreaterThan(0);
    view.rerender(<Harness active={false} />);
    expect(hero()).toHaveAttribute("data-motion-mode", "static");
    expect(frames.size).toBe(0);
    pointerMove();
    expect(frames.size).toBe(0);
  });

  it("运行中减少动态或失去细指针立即取消视差帧", () => {
    render(<Harness />);
    pointerMove();
    expect(frames.size).toBeGreaterThan(0);
    act(() => finePointer.set(false));
    expect(frames.size).toBe(0);
    act(() => finePointer.set(true));
    pointerMove();
    expect(frames.size).toBeGreaterThan(0);
    act(() => desktop.set(false));
    expect(hero()).toHaveAttribute("data-motion-mode", "static");
    expect(frames.size).toBe(0);
  });

  it("指针离开后回到原位并自行停止帧调度，不留下常驻循环", () => {
    render(<Harness />);
    pointerMove();
    frame();
    expect(Number.parseFloat(hero().style.getPropertyValue("--pointer-x"))).toBeGreaterThan(0);
    fireEvent(hero(), new Event("pointerleave"));
    for (let index = 0; index < 200 && frames.size > 0; index++) frame();
    expect(Number.parseFloat(hero().style.getPropertyValue("--pointer-x"))).toBe(0);
    expect(Number.parseFloat(hero().style.getPropertyValue("--pointer-y"))).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("键盘商品焦点会停止视差，暂停再恢复也不能越过仍然存在的焦点", () => {
    const view = render(<Harness />);
    act(() => screen.getByRole("button", { name: "已有商品" }).focus());
    expect(hero().querySelector("[data-hero-sku] button:focus-visible")).not.toBeNull();
    pointerMove();
    expect(frames.size).toBe(0);
    view.rerender(<Harness paused />);
    view.rerender(<Harness />);
    pointerMove();
    expect(frames.size).toBe(0);
    act(() => screen.getByRole("button", { name: "已有商品" }).blur());
    pointerMove();
    expect(frames.size).toBeGreaterThan(0);
  });

  it("卸载回收媒体查询、视口、可见性与指针监听及剩余动画帧", () => {
    const addListener = vi.spyOn(EventTarget.prototype, "addEventListener");
    const removeListener = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const view = render(<Harness />);
    const target = hero();
    pointerMove(target);
    expect(frames.size).toBeGreaterThan(0);
    const ownedListeners = addListener.mock.calls.flatMap((args, index) => {
      const owner = addListener.mock.instances[index];
      return (owner === target && ["pointermove", "pointerleave", "focusin", "focusout"].includes(args[0])) || (owner === document && args[0] === "visibilitychange") ? [{ owner, args }] : [];
    });
    expect(ownedListeners.map(item => item.args[0])).toEqual(expect.arrayContaining(["pointermove", "pointerleave", "visibilitychange"]));
    view.unmount();
    expect(frames.size).toBe(0);
    expect(cancelFrame).toHaveBeenCalled();
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true);
    expect(desktop.listeners.size).toBe(0);
    expect(finePointer.listeners.size).toBe(0);
    for (const { owner, args } of ownedListeners) {
      expect(removeListener.mock.calls.some((removed, index) => removeListener.mock.instances[index] === owner && removed[0] === args[0] && removed[1] === args[1])).toBe(true);
    }
    pointerMove(target);
    expect(frames.size).toBe(0);
  });
});
