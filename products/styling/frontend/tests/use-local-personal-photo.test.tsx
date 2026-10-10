import { StrictMode, useLayoutEffect, type PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalPersonalPhoto } from "../app/lib/use-local-personal-photo";

const file = (type = "image/jpeg", bytes = 8) => new File([new Uint8Array(bytes)], "local-photo", { type });
const createUrl = vi.fn<(blob: Blob) => string>();
const revokeUrl = vi.fn<(url: string) => void>();
let network: ReturnType<typeof vi.fn>;
let storageRead: ReturnType<typeof vi.spyOn>;
let storageWrite: ReturnType<typeof vi.spyOn>;
let storageDelete: ReturnType<typeof vi.spyOn>;
let eventDispatch: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  createUrl.mockReset().mockImplementation(() => `blob:local-${createUrl.mock.calls.length}`); revokeUrl.mockReset();
  URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
  network = vi.fn(); vi.stubGlobal("fetch", network);
  storageRead = vi.spyOn(Storage.prototype, "getItem"); storageWrite = vi.spyOn(Storage.prototype, "setItem"); storageDelete = vi.spyOn(Storage.prototype, "removeItem");
  eventDispatch = vi.spyOn(window, "dispatchEvent");
});
afterEach(() => { storageRead.mockRestore(); storageWrite.mockRestore(); storageDelete.mockRestore(); eventDispatch.mockRestore(); });

describe("local personal photo selection", () => {
  it.each(["image/jpeg", "image/png", "image/webp"])("previews a single %s file only in memory", type => {
    const { result } = renderHook(() => useLocalPersonalPhoto("owner-a", true)); const photo = file(type);
    expect(result.current.photo).toBeNull(); act(() => result.current.select(photo));
    expect(result.current.photo).toEqual({ file: photo, url: "blob:local-1" }); expect(result.current.error).toBe(""); expect(createUrl).toHaveBeenCalledWith(photo);
    expect(network).not.toHaveBeenCalled(); expect(storageRead).not.toHaveBeenCalled(); expect(storageWrite).not.toHaveBeenCalled(); expect(storageDelete).not.toHaveBeenCalled(); expect(eventDispatch).not.toHaveBeenCalled();
  });
  it("releases the old URL on replacement and the current URL on removal exactly once", () => {
    const { result, unmount } = renderHook(() => useLocalPersonalPhoto("owner-a", true));
    act(() => result.current.select(file())); act(() => result.current.select(file("image/png")));
    expect(revokeUrl.mock.calls).toEqual([["blob:local-1"]]); expect(result.current.photo?.url).toBe("blob:local-2");
    act(() => result.current.clear()); expect(result.current.photo).toBeNull(); expect(result.current.error).toBe("");
    unmount(); expect(revokeUrl.mock.calls).toEqual([["blob:local-1"], ["blob:local-2"]]);
  });
  it("revokes the current preview on unmount and ignores delayed old callbacks", async () => {
    const { result, unmount } = renderHook(() => useLocalPersonalPhoto("owner-a", true));
    act(() => result.current.select(file())); const select = result.current.select, clear = result.current.clear;
    unmount(); await act(async () => { await Promise.resolve(); select(file()); clear(); });
    expect(revokeUrl.mock.calls).toEqual([["blob:local-1"]]); expect(createUrl).toHaveBeenCalledTimes(1);
  });
  it("accepts exactly 5 MiB and rejects one byte more without creating a URL", () => {
    const { result } = renderHook(() => useLocalPersonalPhoto("owner-a", true));
    act(() => result.current.select(file("image/jpeg", 5 * 1024 * 1024))); expect(result.current.photo).not.toBeNull();
    act(() => result.current.select(file("image/jpeg", 5 * 1024 * 1024 + 1)));
    expect(result.current.photo).toBeNull(); expect(result.current.error).toContain("本地选择上限 5 MiB"); expect(createUrl).toHaveBeenCalledTimes(1); expect(revokeUrl).toHaveBeenCalledWith("blob:local-1");
  });
  it.each(["image/heic", "image/gif", "image/svg+xml", "application/octet-stream", ""])("rejects unsupported MIME %s without an upload", type => {
    const { result } = renderHook(() => useLocalPersonalPhoto("owner-a", true)); act(() => result.current.select(file(type)));
    expect(result.current.photo).toBeNull(); expect(result.current.error).toContain("JPEG、PNG 或 WebP"); expect(createUrl).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it("removes a previous preview when the replacement has an invalid format, and clear removes the error", () => {
    const { result } = renderHook(() => useLocalPersonalPhoto("owner-a", true)); act(() => result.current.select(file())); act(() => result.current.select(file("image/heic")));
    expect(result.current.photo).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith("blob:local-1"); expect(result.current.error).not.toBe("");
    act(() => result.current.clear()); expect(result.current.error).toBe("");
  });
  it("rejects an empty supported file", () => {
    const { result } = renderHook(() => useLocalPersonalPhoto("owner-a", true)); act(() => result.current.select(file("image/png", 0)));
    expect(result.current.photo).toBeNull(); expect(result.current.error).toContain("文件为空"); expect(createUrl).not.toHaveBeenCalled();
  });
  it("handles a failed local ObjectURL allocation without retaining the previous photo", () => {
    const { result } = renderHook(() => useLocalPersonalPhoto("owner-a", true)); act(() => result.current.select(file())); createUrl.mockImplementationOnce(() => { throw new Error("unavailable"); }); act(() => result.current.select(file()));
    expect(result.current.photo).toBeNull(); expect(result.current.error).toContain("预览暂时无法创建"); expect(revokeUrl).toHaveBeenCalledWith("blob:local-1");
  });
});

describe("photo lifetime and identity isolation", () => {
  it("hides a mismatched identity in the first render before effects can clean up", () => {
    const rendered: Array<string | null> = [], layout: Array<string | null> = [];
    const { result, rerender } = renderHook(({ resetKey }) => {
      const photo = useLocalPersonalPhoto(resetKey, true); rendered.push(photo.photo?.url ?? null);
      useLayoutEffect(() => { layout.push(photo.photo?.url ?? null); }); return photo;
    }, { initialProps: { resetKey: "owner-a" } });
    act(() => result.current.select(file())); const first = rendered.length; rerender({ resetKey: "owner-b" });
    expect(rendered.slice(first).length).toBeGreaterThan(0); expect(rendered.slice(first).every(value => value === null)).toBe(true); expect(layout.at(-1)).toBeNull(); expect(result.current.photo).toBeNull(); expect(revokeUrl.mock.calls).toEqual([["blob:local-1"]]);
  });
  it("does not revive an old owner's photo when the same key returns or an old async callback runs", async () => {
    const { result, rerender } = renderHook(({ resetKey }) => useLocalPersonalPhoto(resetKey, true), { initialProps: { resetKey: "owner-a" } });
    act(() => result.current.select(file())); const oldSelect = result.current.select, oldClear = result.current.clear;
    rerender({ resetKey: "owner-b" }); rerender({ resetKey: "owner-a" });
    await act(async () => { await Promise.resolve(); oldSelect(file()); }); expect(result.current.photo).toBeNull(); expect(createUrl).toHaveBeenCalledTimes(1);
    act(() => result.current.select(file("image/png"))); act(() => oldClear()); expect(result.current.photo?.url).toBe("blob:local-2");
  });
  it("disabling hides and revokes the photo immediately; re-enabling requires a fresh selection", () => {
    const rendered: Array<string | null> = [];
    const { result, rerender } = renderHook(({ enabled }) => { const state = useLocalPersonalPhoto("owner-a", enabled); rendered.push(state.photo?.url ?? null); return state; }, { initialProps: { enabled: true } });
    act(() => result.current.select(file())); const oldSelect = result.current.select, first = rendered.length;
    rerender({ enabled: false }); expect(rendered.slice(first).length).toBeGreaterThan(0); expect(rendered.slice(first).every(value => value === null)).toBe(true); expect(revokeUrl).toHaveBeenCalledWith("blob:local-1");
    act(() => { oldSelect(file()); result.current.select(file()); }); expect(createUrl).toHaveBeenCalledTimes(1);
    rerender({ enabled: true }); expect(result.current.photo).toBeNull(); act(() => oldSelect(file())); expect(result.current.photo).toBeNull();
    act(() => result.current.select(file())); expect(result.current.photo?.url).toBe("blob:local-2");
  });
  it("disabled from mount cannot select or create an ObjectURL", () => {
    const { result } = renderHook(() => useLocalPersonalPhoto("owner-a", false)); act(() => { result.current.select(file()); result.current.clear(); }); expect(result.current.photo).toBeNull(); expect(createUrl).not.toHaveBeenCalled();
  });
  it("late selection callbacks cannot resurrect a removed or replaced photo", async () => {
    const { result } = renderHook(() => useLocalPersonalPhoto("owner-a", true)); const beforeSelection = result.current.select;
    act(() => result.current.select(file())); const beforeClear = result.current.select;
    act(() => result.current.clear()); await act(async () => { await Promise.resolve(); beforeSelection(file()); beforeClear(file()); });
    expect(result.current.photo).toBeNull(); expect(createUrl).toHaveBeenCalledTimes(1);
    act(() => result.current.select(file())); const replacedSelect = result.current.select;
    act(() => result.current.select(file())); await act(async () => { await Promise.resolve(); replacedSelect(file()); });
    expect(result.current.photo?.url).toBe("blob:local-3"); expect(createUrl).toHaveBeenCalledTimes(3);
  });
  it("clears local errors at an identity boundary and does not restore them later", () => {
    const { result, rerender } = renderHook(({ resetKey }) => useLocalPersonalPhoto(resetKey, true), { initialProps: { resetKey: "owner-a" } });
    act(() => result.current.select(file("image/heic"))); expect(result.current.error).not.toBe(""); rerender({ resetKey: "owner-b" }); expect(result.current.error).toBe(""); rerender({ resetKey: "owner-a" }); expect(result.current.error).toBe("");
  });
  it("keeps one active preview through StrictMode and releases it on cleanup", () => {
    const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
    const { result, unmount } = renderHook(() => useLocalPersonalPhoto("owner-a", true), { wrapper }); act(() => result.current.select(file())); expect(result.current.photo?.url).toBe("blob:local-1");
    unmount(); expect(createUrl).toHaveBeenCalledTimes(1); expect(revokeUrl.mock.calls).toEqual([["blob:local-1"]]);
  });
});
