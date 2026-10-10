import { createElement, type Ref } from "react";
import type { ImageProps } from "next/image";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixedOutfitPanel } from "../components/fixed-outfit-panel";
import { parseFixedOutfit, type FixedOutfit, type FixedSlot } from "../app/lib/fixed-outfits";
import { PRODUCT_IMAGE_DISCLAIMER, type ProductImageUseRef } from "../app/lib/product-images";
import { outfit } from "./fixed-outfit-fixtures";

// Controlled React component tests. Image transport/decode and real browser checks are separate.
const transport = vi.hoisted(() => ({ fetch: vi.fn<(ref: ProductImageUseRef, options?: { signal?: AbortSignal }) => Promise<Blob>>() }));
vi.mock("../app/lib/product-images", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/product-images")>(),
  fetchVerifiedProductImage: transport.fetch,
}));
vi.mock("next/image", () => ({
  default: ({ src, alt, onError, onLoad, ref }: ImageProps & { ref?: Ref<HTMLImageElement> }) => createElement("img", {
    src: typeof src === "string" ? src : "default" in src ? src.default.src : src.src,
    alt, onError, onLoad, ref,
  }),
}));

const slots = ["top", "bottom", "shoes"] as const;
function imageRef(slot: FixedSlot): ProductImageUseRef {
  const item = outfit().items[slot];
  return {
    asset_id: `PIMG-UI-${slot}-v1`, asset_version: 1, tenant_id: "tenant-demo", catalog_version: "test-catalog",
    product_id: item.product_id, sku_id: item.sku_id, sku_ids: [item.sku_id], kind: "product_single_image", representation: "style_color_reference",
    image_url: `/api/v1/outfits/product-assets/PIMG-UI-${slot}-v1`, image_sha256: "c".repeat(64), mime_type: "image/jpeg",
    width: 1024, height: 1024, byte_size: 108972, state: "agent_checked_preview", user_review: "pending",
    origin: { origin_type: "ai_generated", source_name: "Controlled UI fixture", source_ref: "component-test-only", is_simulated: true, rights_confirmed: true },
    registration: { registered_at: "2026-10-10T01:00:00+08:00" }, is_simulated: true, disclaimer: PRODUCT_IMAGE_DISCLAIMER,
  };
}
function frozen(sessionId = "controlled-image-session-a"): FixedOutfit {
  const value = outfit();
  const refs = { top: imageRef("top"), bottom: imageRef("bottom"), shoes: imageRef("shoes") };
  return parseFixedOutfit({ ...value, tenant_id: "tenant-demo", session_id: sessionId,
    items: Object.fromEntries(slots.map(slot => [slot, { ...value.items[slot], image_use_ref: structuredClone(refs[slot]), image_url: refs[slot].image_url }])),
    product_image_display: { recorded: true, status: "recorded", look_version_id: value.look_version_id, image_refs: refs, is_simulated: true },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const blob = () => new Blob(["controlled-component-image"], { type: "image/jpeg" });
const props = { current: true, disabled: false, onAction: vi.fn(), onReturnCurrent: vi.fn() };
const singleImages = () => screen.queryAllByRole("img", { name: /生成当时的单品参考图/ });
const completeImage = () => screen.getByRole("img", { name: /固定模特完整搭配/ });
const card = (slot: FixedSlot) => within(screen.getByRole("heading", { name: `模拟${slot}` }).closest("article")!);

beforeEach(() => {
  transport.fetch.mockReset().mockImplementation(async () => blob());
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected catalog or alternate-image request")));
  let sequence = 0;
  vi.mocked(URL.createObjectURL).mockReset().mockImplementation(() => `blob:component-${++sequence}`);
  vi.mocked(URL.revokeObjectURL).mockReset();
  props.onAction.mockClear(); props.onReturnCurrent.mockClear();
});

describe("固定搭配单品图组件（受控传输，非真实页面验收）", () => {
  it("三件仅展示各自冻结参考图和待用户确认标注，完整搭配画布保持", async () => {
    const value = frozen();
    render(<FixedOutfitPanel {...props} outfit={value} />);
    await waitFor(() => expect(singleImages()).toHaveLength(3));
    expect(screen.getAllByText(PRODUCT_IMAGE_DISCLAIMER)).toHaveLength(3);
    for (const slot of slots) {
      expect(card(slot).getByRole("img", { name: `模拟${slot}，生成当时的单品参考图` })).toHaveAttribute("src", expect.stringMatching(/^blob:component-/));
      expect(card(slot).getByText(value.items[slot].sku_id)).toBeVisible();
      expect(transport.fetch).toHaveBeenCalledWith(value.product_image_display!.image_refs[slot], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }
    expect(transport.fetch).toHaveBeenCalledTimes(3);
    expect(completeImage()).toHaveAttribute("src", value.image_url);
    expect(screen.getByText("三件合计").nextElementSibling).toHaveTextContent("¥797.00");
    expect(fetch).not.toHaveBeenCalled();
    expect(props.onAction).not.toHaveBeenCalled();
  });

  it("旧history_unrecorded不抓图、不借当前引用或catalog补历史，完整图仍可查看", async () => {
    const value = frozen();
    value.product_image_display = { recorded: false, status: "history_unrecorded", look_version_id: "lv-1", image_refs: { top: null, bottom: null, shoes: null }, is_simulated: true };
    // Deliberately leave current-looking item refs present: the real frozen-source selector must ignore them.
    render(<FixedOutfitPanel {...props} current={false} outfit={value} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getAllByRole("img", { name: "生成当时未记录单品图" })).toHaveLength(3);
    expect(singleImages()).toHaveLength(0);
    expect(screen.queryByText(PRODUCT_IMAGE_DISCLAIMER)).not.toBeInTheDocument();
    expect(completeImage()).toHaveAttribute("src", value.image_url);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("一槽抓取失败只占位该槽，另两张、完整图、价格与加购入口保留", async () => {
    transport.fetch.mockImplementation(async ref => {
      if (ref.sku_id === "M1-T-M") throw new Error("Controlled single-slot unavailable");
      return blob();
    });
    const value = frozen();
    render(<FixedOutfitPanel {...props} outfit={value} />);
    await waitFor(() => expect(singleImages()).toHaveLength(2));
    expect(card("top").getByRole("img", { name: "单品参考图暂不可用" })).toBeVisible();
    for (const slot of ["bottom", "shoes"] as const) expect(card(slot).getByRole("img", { name: /生成当时的单品参考图/ })).toBeVisible();
    expect(completeImage()).toHaveAttribute("src", value.image_url);
    expect(screen.queryByText("搭配图片暂时无法读取，版本和单品资料已保留。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "整套模拟加购" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "模拟加购这件" })).toHaveLength(3);
    expect(transport.fetch).toHaveBeenCalledTimes(3); expect(fetch).not.toHaveBeenCalled();
  });

  it("浏览器图片错误仍只降级对应单品，并在卸载回收已创建的objectURL", async () => {
    const view = render(<FixedOutfitPanel {...props} outfit={frozen()} />);
    await waitFor(() => expect(singleImages()).toHaveLength(3));
    const allocated = vi.mocked(URL.createObjectURL).mock.results.map(result => result.value as string);
    fireEvent.error(card("bottom").getByRole("img", { name: /生成当时的单品参考图/ }));
    expect(card("bottom").getByRole("img", { name: "单品参考图暂不可用" })).toBeVisible();
    expect(singleImages()).toHaveLength(2); expect(completeImage()).toBeVisible();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
    for (const url of allocated) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("两个session同为lv-1时旧异步图不落新会话，旧URL及卸载URL均回收", async () => {
    const requests = Array.from({ length: 6 }, () => deferred<Blob>());
    let requestIndex = 0;
    transport.fetch.mockImplementation(() => requests[requestIndex++].promise);
    const a = frozen("controlled-session-a"), b = frozen("controlled-session-b");
    expect(a.look_version_id).toBe(b.look_version_id);
    const view = render(<FixedOutfitPanel {...props} outfit={a} />);
    await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(3));
    await act(async () => { requests[1].resolve(blob()); requests[2].resolve(blob()); });
    await waitFor(() => expect(singleImages()).toHaveLength(2));
    const oldUrls = singleImages().map(image => image.getAttribute("src")!);
    view.rerender(<FixedOutfitPanel {...props} outfit={b} />);
    expect(singleImages()).toHaveLength(0);
    await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(6));
    for (const [, options] of transport.fetch.mock.calls.slice(0, 3)) expect(options?.signal?.aborted).toBe(true);
    for (const url of oldUrls) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    await act(async () => { requests[0].resolve(blob()); });
    expect(singleImages()).toHaveLength(0);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    await act(async () => { requests[3].resolve(blob()); requests[4].resolve(blob()); requests[5].resolve(blob()); });
    await waitFor(() => expect(singleImages()).toHaveLength(3));
    for (const url of oldUrls) expect(singleImages().map(image => image.getAttribute("src"))).not.toContain(url);
    expect(completeImage()).toHaveAttribute("src", b.image_url);
    const allAllocated = vi.mocked(URL.createObjectURL).mock.results.map(result => result.value as string);
    view.unmount();
    for (const [, options] of transport.fetch.mock.calls) expect(options?.signal?.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(5);
    for (const url of allAllocated) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    expect(fetch).not.toHaveBeenCalled();
  });
});
