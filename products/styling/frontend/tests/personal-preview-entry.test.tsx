import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { StylingPreview } from "../components/styling-preview";
import { isPersonalPreviewIntent } from "../app/lib/personal-preview-model";
import { legacyConsumerRoute, isBusinessWrite } from "./consumer-test-routes";

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
});
afterAll(() => {
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function stubReadOnly() {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const fixture = legacyConsumerRoute(input, init); if (fixture) return fixture;
    return { ok: true, status: 200, json: async () => ({ messages: [] }) } as Response;
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
}

describe("本人效果入口与正式对话隔离", () => {
  it.each(["看看我穿这套的效果", "我想看看我穿当前这套的效果", "请用我的照片看这套穿搭效果。", "上传本人照片看穿搭效果"])("明确意图只打开本地面板：%s", text => expect(isPersonalPreviewIntent(text)).toBe(true));
  it.each(["不要上传我的照片", "我想搭一套通勤，预算800", "看看我穿这套的效果，顺便把鞋换白色", "我想了解怎么上传照片", ""])("其它需求保留给正常对话：%s", text => expect(isPersonalPreviewIntent(text)).toBe(false));
  it("自然语言打开面板保留原草稿，零正式需求/上传，不生成完整方案", async () => {
    const fetcher = stubReadOnly(); render(<StylingPreview />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeDisabled());
    await waitFor(() => expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument());
    const input = screen.getByRole("textbox", { name: "说说你的穿搭需求" });
    fireEvent.change(input, { target: { value: "看看我穿这套的效果" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fetcher.mockClear(); fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(input).toHaveValue("看看我穿这套的效果");
    expect(fetcher.mock.calls.some(isBusinessWrite)).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("tryon"))).toBe(false);
  });
  it("无当前方案时我的搭配页仍有可解释的照片入口，管理入口没有增加", async () => {
    const fetcher = stubReadOnly(); render(<StylingPreview />);
    await waitFor(() => expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "我的搭配" }));
    const entry = screen.getByRole("button", { name: "看看我穿的效果" });
    fetcher.mockClear(); fireEvent.click(entry);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(fetcher.mock.calls.some(isBusinessWrite)).toBe(false);
    expect(screen.queryAllByRole("link").some(link => /\/admin(?:\/|$|\?)/.test(link.getAttribute("href") || ""))).toBe(false);
  });
});
