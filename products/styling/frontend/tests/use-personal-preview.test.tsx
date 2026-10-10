import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPreviewPointer, writePreviewPointer } from "../app/lib/personal-preview-pointer";
import { usePersonalPreview } from "../app/lib/use-personal-preview";
import { PersonalPreviewError, type PersonalPreviewAvailability, type PersonalPreviewService, type PersonalPreviewTarget, type PersonalPreviewTask } from "../app/lib/personal-preview-model";

// Controlled UI-service fixtures only. None represent an HTTP, backend, provider, or real-page acceptance.
const firstTarget: PersonalPreviewTarget = { sessionId: "private-session", lookVersionId: "look-version-a", versionNo: 1, lookId: "LOOK-A", modelUrl: "/fixture-model-a.webp", items: [{ slot: "top", skuId: "SKU-TOP-A", name: "合成上衣" }, { slot: "bottom", skuId: "SKU-BOTTOM-A", name: "合成裤子" }, { slot: "shoes", skuId: "SKU-SHOES-A", name: "合成鞋" }] };
const nextTarget: PersonalPreviewTarget = { ...firstTarget, lookVersionId: "look-version-b", versionNo: 2, lookId: "LOOK-B", modelUrl: "/fixture-model-b.webp" };
const availability = (): PersonalPreviewAvailability => ({ available: true, reasons: [], mode: "mock", purposeNote: "受控本地流程测试", retentionNote: "非真实存储期限", costNote: "无真实调用", permit: { purpose: "isolated-test-permit" } });
const task = (changes: Partial<PersonalPreviewTask> = {}): PersonalPreviewTask => ({ id: "task-a", requestId: "request-a", status: "succeeded", deletion: "active", target: firstTarget, createdAt: "2026-10-10T01:00:00Z", expiresAt: null, detail: "受控合成记录", hasResult: true, mode: "mock", ...changes });
const photo = () => new File([new Uint8Array([1, 2, 3])], "local-synthetic-photo.png", { type: "image/png" });
const resultBlob = () => new Blob([new Uint8Array([4, 5, 6])], { type: "image/webp" });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixtureService() {
  return {
    availability: vi.fn<PersonalPreviewService["availability"]>().mockResolvedValue(availability()),
    submit: vi.fn<PersonalPreviewService["submit"]>().mockImplementation(async request => task({ requestId: request.requestId, target: request.target, status: "queued", hasResult: false })),
    findRequest: vi.fn<PersonalPreviewService["findRequest"]>().mockResolvedValue(null),
    task: vi.fn<PersonalPreviewService["task"]>().mockResolvedValue(task()),
    history: vi.fn<PersonalPreviewService["history"]>().mockResolvedValue([]),
    image: vi.fn<PersonalPreviewService["image"]>().mockResolvedValue(resultBlob()),
    remove: vi.fn<PersonalPreviewService["remove"]>().mockImplementation(async current => ({ ...current, deletion: "deleted", hasResult: false })),
  };
}
type Props = { currentTarget: PersonalPreviewTarget | null; identityKey: string; identityReady: boolean; sessionKey?: string; persistRecovery?: boolean };
function mount(service?: PersonalPreviewService, props: Partial<Props> = {}) {
  const onIdentityInvalid = vi.fn();
  const initialProps: Props = { currentTarget: firstTarget, identityKey: "owner-a", identityReady: true, ...props };
  return { ...renderHook((input: Props) => usePersonalPreview({ ...input, service, onIdentityInvalid }), { initialProps }), onIdentityInvalid, initialProps };
}
const change = async (operation: () => void) => { await act(async () => { operation(); }); };
const createUrl = vi.fn<(blob: Blob) => string>(), revokeUrl = vi.fn<(url: string) => void>();
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  createUrl.mockReset().mockImplementation(value => `blob:${value instanceof File ? "local-photo" : "private-result"}-${createUrl.mock.calls.length}`); revokeUrl.mockReset();
  URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl; network = vi.fn(); vi.stubGlobal("fetch", network);
});

describe("recovery binding and cancelled-read regression boundaries", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it("rejects a restored request whose known task ID changes even when request and Look still match", async () => {
    const pointer = { version: 1 as const, requestId: "request-a", taskId: "task-a", sessionId: firstTarget.sessionId, lookVersionId: firstTarget.lookVersionId };
    writePreviewPointer("owner-a", pointer);
    const service = fixtureService(); service.findRequest.mockResolvedValue(task({ id: "task-impostor" }));
    const { result } = mount(service, { persistRecovery: true });
    await change(() => result.current.openPanel());
    expect(service.findRequest).toHaveBeenCalledWith("request-a", expect.any(AbortSignal));
    expect(result.current.task).toBeNull(); expect(result.current.uncertain).toBe(true); expect(result.current.canRetry).toBe(false);
    expect(result.current.requestId).toBe("request-a"); expect(result.current.error).toContain("不一致");
    expect(readPreviewPointer("owner-a")).toEqual(pointer); expect(service.submit).not.toHaveBeenCalled();
    service.findRequest.mockResolvedValue(task()); await change(() => result.current.checkRequest());
    expect(result.current.task?.id).toBe("task-a"); expect(result.current.uncertain).toBe(false);
    expect(readPreviewPointer("owner-a")).toEqual(pointer); expect(service.submit).not.toHaveBeenCalled();
  });

  it.each(["original request", "accepted task"] as const)("closing cancels a hanging %s read and its old finally cannot unlock the reopened read", async kind => {
    const service = fixtureService(), oldRead = deferred<PersonalPreviewTask | null>(), currentRead = deferred<PersonalPreviewTask | null>();
    const requestRead = kind === "original request";
    if (requestRead) {
      writePreviewPointer("owner-a", { version: 1, requestId: "request-a", taskId: "task-a", sessionId: firstTarget.sessionId, lookVersionId: firstTarget.lookVersionId });
      service.findRequest.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(currentRead.promise);
    } else {
      service.task.mockReturnValueOnce(oldRead.promise as Promise<PersonalPreviewTask>).mockReturnValueOnce(currentRead.promise as Promise<PersonalPreviewTask>);
    }
    const { result } = mount(service, { persistRecovery: true });
    await change(() => result.current.openPanel());
    if (!requestRead) { await change(() => result.current.viewTask(task())); await change(() => result.current.refreshTask()); }
    const reader = requestRead ? service.findRequest : service.task;
    expect(reader).toHaveBeenCalledTimes(1); const oldSignal = reader.mock.calls[0][1];
    expect(oldSignal.aborted).toBe(false); await change(() => result.current.closePanel()); expect(oldSignal.aborted).toBe(true);
    await change(() => result.current.openPanel());
    await change(() => requestRead ? result.current.checkRequest() : result.current.refreshTask());
    expect(reader).toHaveBeenCalledTimes(2); const currentSignal = reader.mock.calls[1][1]; expect(currentSignal.aborted).toBe(false);
    if (requestRead) await change(() => oldRead.resolve(task({ detail: "stale original response" })));
    else await change(() => oldRead.reject(new Error("stale aborted read failure")));
    expect(result.current.task?.detail).not.toBe("stale original response"); expect(result.current.error).not.toContain("stale aborted read failure");
    await change(() => requestRead ? result.current.checkRequest() : result.current.refreshTask());
    expect(reader).toHaveBeenCalledTimes(2); expect(currentSignal.aborted).toBe(false);
    await change(() => currentRead.resolve(task({ detail: "fresh reopened response" })));
    expect(result.current.task?.detail).toBe("fresh reopened response"); expect(result.current.requestId).toBe("request-a");
    expect(result.current.uncertain).toBe(false); expect(service.submit).not.toHaveBeenCalled();
    if (requestRead) service.findRequest.mockResolvedValue(task({ detail: "next explicit read" })); else service.task.mockResolvedValue(task({ detail: "next explicit read" }));
    await change(() => requestRead ? result.current.checkRequest() : result.current.refreshTask());
    expect(reader).toHaveBeenCalledTimes(3); expect(result.current.task?.detail).toBe("next explicit read");
  });

  it("clears an explicitly rejected unaccepted submission pointer so remount does not enter a false 404 recovery", async () => {
    const base = fixtureService(); const service = { ...base, releaseSensitive: vi.fn() };
    service.submit.mockRejectedValueOnce(new PersonalPreviewError("生成选择已变化，尚未受理", false, true, "PREVIEW_SELECTION_CHANGED", 409));
    const first = mount(service, { persistRecovery: true });
    await change(() => first.result.current.openPanel()); await change(() => first.result.current.selectPhoto(photo())); await change(() => first.result.current.confirm());
    const rejectedId = service.submit.mock.calls[0][0].requestId;
    expect(first.result.current.uncertain).toBe(false); expect(first.result.current.requestId).toBeNull(); expect(first.result.current.task).toBeNull();
    expect(readPreviewPointer("owner-a")).toBeNull(); expect(first.result.current.error).toContain("尚未受理"); expect(first.result.current.recoveryNotice).toContain("明确被拒绝");
    expect(service.releaseSensitive).toHaveBeenCalled(); first.unmount();
    const restored = mount(service, { persistRecovery: true, currentTarget: nextTarget }); await change(() => restored.result.current.openPanel());
    expect(service.findRequest).not.toHaveBeenCalled(); expect(service.submit).toHaveBeenCalledTimes(1); expect(restored.result.current.uncertain).toBe(false);
    expect(restored.result.current.requestId).toBeNull(); expect(restored.result.current.target).toEqual(nextTarget); expect(restored.result.current.availability?.available).toBe(true);
    await change(() => restored.result.current.selectPhoto(photo())); expect(service.submit).toHaveBeenCalledTimes(1);
    await change(() => restored.result.current.confirm()); expect(service.submit).toHaveBeenCalledTimes(2);
    expect(service.submit.mock.calls[1][0].requestId).not.toBe(rejectedId); expect(service.submit.mock.calls[1][0].target).toEqual(nextTarget);
  });

  it("also clears the pointer when an explicit original-body retry is definitively rejected before acceptance", async () => {
    const base = fixtureService(); const service = { ...base, canRetry: vi.fn(() => true), retry: vi.fn<NonNullable<PersonalPreviewService["retry"]>>(), releaseSensitive: vi.fn() };
    service.submit.mockRejectedValue(new Error("controlled lost submission response"));
    service.retry.mockRejectedValue(new PersonalPreviewError("原确认已过期，任务未受理", false, true, "PREVIEW_CONFIRMATION_EXPIRED", 409));
    const first = mount(service, { persistRecovery: true });
    await change(() => first.result.current.openPanel()); await change(() => first.result.current.selectPhoto(photo())); await change(() => first.result.current.confirm());
    const requestId = first.result.current.requestId; expect(readPreviewPointer("owner-a")?.requestId).toBe(requestId);
    await change(() => first.result.current.checkRequest()); expect(first.result.current.canRetry).toBe(true); expect(service.retry).not.toHaveBeenCalled();
    await change(() => first.result.current.retryRequest?.()); expect(service.retry).toHaveBeenCalledWith(requestId, expect.any(AbortSignal));
    expect(first.result.current.requestId).toBeNull(); expect(first.result.current.uncertain).toBe(false); expect(first.result.current.canRetry).toBe(false); expect(readPreviewPointer("owner-a")).toBeNull();
    first.unmount(); const restored = mount(service, { persistRecovery: true }); await change(() => restored.result.current.openPanel());
    expect(service.findRequest).toHaveBeenCalledTimes(1); expect(restored.result.current.uncertain).toBe(false); expect(service.retry).toHaveBeenCalledTimes(1); expect(service.submit).toHaveBeenCalledTimes(1);
  });

  it("a late availability A cannot replace explicitly selected historical B or restore A's generation permit", async () => {
    const service = fixtureService(), pendingAvailability = deferred<PersonalPreviewAvailability>(); service.availability.mockReturnValue(pendingAvailability.promise);
    const { result } = mount(service, { persistRecovery: true }); await change(() => result.current.openPanel());
    expect(result.current.target).toEqual(firstTarget); expect(result.current.availabilityLoading).toBe(true);
    const historyB = task({ id: "task-b", requestId: "request-b", target: nextTarget }); await change(() => result.current.viewTask(historyB));
    expect(result.current.target).toEqual(nextTarget); expect(result.current.availability).toBeNull(); expect(result.current.availabilityLoading).toBe(false);
    await change(() => pendingAvailability.resolve({ ...availability(), selection: { ...firstTarget, selectionDigest: "old-selection-a" }, permit: { purpose: "late-permit-a" } }));
    expect(result.current.task).toEqual(historyB); expect(result.current.target).toEqual(nextTarget); expect(result.current.requestId).toBe("request-b");
    expect(result.current.availability).toBeNull(); expect(result.current.availabilityLoading).toBe(false);
    expect(readPreviewPointer("owner-a")).toEqual({ version: 1, requestId: "request-b", taskId: "task-b", sessionId: nextTarget.sessionId, lookVersionId: nextTarget.lookVersionId });
    await change(() => result.current.selectPhoto(photo())); await change(() => result.current.confirm()); expect(service.submit).not.toHaveBeenCalled();
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("local selection and explicit personal preview confirmation", () => {
  it("opens, reads capability, and selects a local photo with zero upload, storage, or event writes", async () => {
    const service = fixtureService(); const { result } = mount(service); const storage = vi.spyOn(Storage.prototype, "setItem"), events = vi.spyOn(window, "dispatchEvent");
    try {
      expect(service.availability).not.toHaveBeenCalled(); await change(() => result.current.openPanel()); const input = photo(); await change(() => result.current.selectPhoto(input));
      expect(result.current.photo?.file).toBe(input); expect(result.current.target).toEqual(firstTarget); expect(service.submit).not.toHaveBeenCalled(); expect(service.remove).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
      const url = result.current.photo!.url; await change(() => result.current.closePanel()); expect(result.current.photo).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith(url); expect(service.submit).not.toHaveBeenCalled();
    } finally { storage.mockRestore(); events.mockRestore(); }
  });
  it("retains the originally selected Look when current Look changes and requires explicit retargeting", async () => {
    const service = fixtureService(); const { result, rerender, initialProps } = mount(service);
    await change(() => result.current.openPanel()); await change(() => result.current.selectPhoto(photo())); rerender({ ...initialProps, currentTarget: nextTarget });
    expect(result.current.target).toEqual(firstTarget); expect(result.current.targetChanged).toBe(true); await change(() => result.current.confirm()); expect(service.submit).not.toHaveBeenCalled();
    await change(() => result.current.useCurrentTarget()); expect(result.current.target).toEqual(nextTarget); expect(result.current.targetChanged).toBe(false); expect(service.submit).not.toHaveBeenCalled();
    await change(() => result.current.confirm()); expect(service.submit).toHaveBeenCalledTimes(1); expect(service.submit.mock.calls[0][0].target).toEqual(nextTarget);
  });
  it("binds one original request and File when confirm is clicked twice before settlement", async () => {
    const service = fixtureService(), pending = deferred<PersonalPreviewTask>(); service.submit.mockReturnValue(pending.promise); const { result } = mount(service);
    await change(() => result.current.openPanel()); const input = photo(); await change(() => result.current.selectPhoto(input)); const localUrl = result.current.photo!.url;
    await change(() => { result.current.confirm(); result.current.confirm(); }); expect(service.submit).toHaveBeenCalledTimes(1); expect(result.current.photo).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith(localUrl);
    const original = service.submit.mock.calls[0][0]; expect(original.photo).toBe(input); expect(original.target).toEqual(firstTarget); expect(original.permit).toEqual(availability().permit); expect(result.current.requestId).toBe(original.requestId);
    await change(() => pending.resolve(task({ requestId: original.requestId, status: "queued", hasResult: false }))); expect(result.current.task?.requestId).toBe(original.requestId); expect(result.current.submitting).toBe(false); expect(result.current.waiting).toBe(true);
  });
  it("does not submit without a photo, with no target, or while identity is not ready", async () => {
    const service = fixtureService(); const mounted = mount(service); await change(() => mounted.result.current.openPanel()); await change(() => mounted.result.current.confirm()); expect(service.submit).not.toHaveBeenCalled(); mounted.unmount();
    const noTarget = mount(service, { currentTarget: null }); await change(() => noTarget.result.current.openPanel()); await change(() => noTarget.result.current.selectPhoto(photo())); await change(() => noTarget.result.current.confirm()); expect(service.submit).not.toHaveBeenCalled(); noTarget.unmount();
    const noIdentity = mount(service, { identityReady: false }); await change(() => noIdentity.result.current.openPanel()); await change(() => noIdentity.result.current.selectPhoto(photo())); await change(() => noIdentity.result.current.confirm()); expect(noIdentity.result.current.photo).toBeNull(); expect(service.submit).not.toHaveBeenCalled();
  });
  it("keeps the local preview but disables generation when no service adapter is connected", async () => {
    const { result } = mount(); await change(() => result.current.openPanel()); await change(() => result.current.selectPhoto(photo())); await change(() => result.current.confirm());
    expect(result.current.photo).not.toBeNull(); expect(result.current.availability?.available).toBe(false); expect(result.current.requestId).toBeNull(); expect(result.current.task).toBeNull(); expect(network).not.toHaveBeenCalled();
  });
});

describe("uncertain submission and original request lookup", () => {
  async function uncertain() {
    const service = fixtureService(); service.submit.mockRejectedValue(new Error("controlled response loss")); const mounted = mount(service); await change(() => mounted.result.current.openPanel()); await change(() => mounted.result.current.selectPhoto(photo())); await change(() => mounted.result.current.confirm()); return { service, ...mounted };
  }
  it("recovers a lost submit response by the original request ID without reuploading", async () => {
    const { result, service } = await uncertain(); const original = service.submit.mock.calls[0][0]; expect(result.current.uncertain).toBe(true); service.findRequest.mockResolvedValue(task({ requestId: original.requestId }));
    await change(() => result.current.checkRequest()); expect(service.findRequest.mock.calls[0][0]).toBe(original.requestId); expect(result.current.task?.requestId).toBe(original.requestId); expect(result.current.uncertain).toBe(false); expect(service.submit).toHaveBeenCalledTimes(1);
  });
  it("treats a not-found original request as unknown, with no second POST or new ID", async () => {
    const { result, service } = await uncertain(); const requestId = result.current.requestId; await change(() => result.current.checkRequest()); await change(() => result.current.confirm());
    expect(result.current.requestId).toBe(requestId); expect(result.current.uncertain).toBe(true); expect(result.current.error).toContain("不能据此认定未调用"); expect(service.submit).toHaveBeenCalledTimes(1);
  });
  it("rejects a mismatched request lookup without accepting another record", async () => {
    const { result, service } = await uncertain(); service.findRequest.mockResolvedValue(task({ requestId: "another-request" })); await change(() => result.current.checkRequest()); expect(result.current.task).toBeNull(); expect(result.current.uncertain).toBe(true); expect(result.current.error).toContain("请求编号不一致");
  });
  it("rejects a matching request ID whose returned Look differs from the frozen target", async () => {
    const { result, service } = await uncertain(); service.findRequest.mockResolvedValue(task({ requestId: result.current.requestId!, target: nextTarget })); await change(() => result.current.checkRequest());
    expect(result.current.task).toBeNull(); expect(result.current.target).toEqual(firstTarget); expect(result.current.uncertain).toBe(true); expect(service.submit).toHaveBeenCalledTimes(1);
  });
  it("preserves the original request lookup after close and reopen without another submit", async () => {
    const { result, service } = await uncertain(); const original = result.current.requestId; await change(() => result.current.closePanel()); await change(() => result.current.openPanel()); await change(() => result.current.checkRequest()); expect(result.current.requestId).toBe(original); expect(service.findRequest.mock.calls[0][0]).toBe(original); expect(service.submit).toHaveBeenCalledTimes(1);
  });
});

describe("task reads, polling, and private result blobs", () => {
  it("keeps an accepted record on task read failure and does not regenerate", async () => {
    const service = fixtureService(); service.task.mockRejectedValue(new Error("controlled read failure")); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task({ status: "running", hasResult: false })));
    await change(() => result.current.refreshTask()); expect(result.current.task?.id).toBe("task-a"); expect(result.current.error).toContain("read failure"); expect(result.current.waiting).toBe(false); expect(service.submit).not.toHaveBeenCalled();
  });
  it("stops background task polling on stopWaiting and close while retaining accepted facts", async () => {
    vi.useFakeTimers(); const service = fixtureService(); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.selectPhoto(photo())); await change(() => result.current.confirm());
    const accepted = result.current.task!; service.task.mockResolvedValue({ ...accepted, status: "running" }); await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(service.task).toHaveBeenCalledTimes(1);
    await change(() => result.current.stopWaiting()); await act(async () => { await vi.advanceTimersByTimeAsync(12000); }); expect(service.task).toHaveBeenCalledTimes(1); expect(result.current.task?.id).toBe(accepted.id);
    await change(() => result.current.refreshTask()); expect(result.current.waiting).toBe(true); const reads = service.task.mock.calls.length; await change(() => result.current.closePanel()); await act(async () => { await vi.advanceTimersByTimeAsync(12000); }); expect(service.task).toHaveBeenCalledTimes(reads); expect(result.current.task?.id).toBe(accepted.id); expect(service.remove).not.toHaveBeenCalled(); expect(service.submit).toHaveBeenCalledTimes(1);
  });
  it.each([new Blob([], { type: "image/png" }), new Blob(["not an image"], { type: "text/html" })])("does not display an invalid private result Blob and only rereads its original image", async blob => {
    const service = fixtureService(); service.image.mockResolvedValueOnce(blob).mockResolvedValue(resultBlob()); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.setImageMode("personal"));
    expect(result.current.imageUrl).toBeNull(); expect(result.current.imageError).toContain("图片格式无效"); expect(result.current.task?.status).toBe("succeeded"); expect(createUrl).not.toHaveBeenCalled();
    await change(() => result.current.reloadImage()); expect(result.current.imageUrl).toContain("blob:private-result"); expect(result.current.imageError).toBe(""); expect(service.image.mock.calls.map(call => call[0].id)).toEqual(["task-a", "task-a"]); expect(service.submit).not.toHaveBeenCalled();
  });
  it("revokes the previous authorized result Blob on reread, close, and unmount", async () => {
    const service = fixtureService(); const { result, unmount } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.reloadImage()); const first = result.current.imageUrl!; await change(() => result.current.reloadImage()); const second = result.current.imageUrl!;
    expect(revokeUrl).toHaveBeenCalledWith(first); expect(second).not.toBe(first); await change(() => result.current.closePanel()); expect(result.current.imageUrl).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith(second); const count = revokeUrl.mock.calls.length; unmount(); expect(revokeUrl.mock.calls.length).toBe(count);
  });
  it("ignores a private image response that arrives after the panel closes", async () => {
    const service = fixtureService(), pending = deferred<Blob>(); service.image.mockReturnValue(pending.promise); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.reloadImage()); await change(() => result.current.closePanel()); await change(() => pending.resolve(resultBlob()));
    expect(result.current.imageUrl).toBeNull(); expect(result.current.open).toBe(false); expect(createUrl).not.toHaveBeenCalled(); expect(service.submit).not.toHaveBeenCalled();
  });
  it("prevents an older task read from replacing a subsequently selected task", async () => {
    const service = fixtureService(), pending = deferred<PersonalPreviewTask>(); service.task.mockReturnValue(pending.promise); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.refreshTask()); const second = task({ id: "task-b", requestId: "request-b", target: nextTarget }); await change(() => result.current.viewTask(second)); await change(() => pending.resolve(task())); expect(result.current.task).toEqual(second); expect(result.current.target).toEqual(nextTarget);
  });
  it("prevents task A's late image from replacing task B's private result", async () => {
    const service = fixtureService(), pending = deferred<Blob>(); service.image.mockReturnValueOnce(pending.promise).mockResolvedValue(resultBlob()); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.reloadImage()); await change(() => result.current.viewTask(task({ id: "task-b", requestId: "request-b", target: nextTarget }))); await change(() => result.current.reloadImage()); const current = result.current.imageUrl; await change(() => pending.resolve(resultBlob())); expect(result.current.task?.id).toBe("task-b"); expect(result.current.imageUrl).toBe(current); expect(createUrl).toHaveBeenCalledTimes(1);
  });
});

describe("deletion tombstones and identity cleanup", () => {
  it("revokes the displayed private image as soon as history first reports the selected task deleted", async () => {
    const service = fixtureService(); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.setImageMode("personal")); const displayed = result.current.imageUrl!;
    expect(displayed).toContain("blob:private-result"); expect(result.current.imageMode).toBe("personal"); service.history.mockResolvedValue([task({ deletion: "deleted", hasResult: false })]); await change(() => result.current.refreshHistory());
    expect(result.current.task?.deletion).toBe("deleted"); expect(result.current.task?.hasResult).toBe(false); expect(result.current.imageUrl).toBeNull(); expect(result.current.imageMode).toBe("model"); expect(result.current.waiting).toBe(false); expect(revokeUrl).toHaveBeenCalledWith(displayed);
    await change(() => result.current.reloadImage()); expect(service.image).toHaveBeenCalledTimes(1); expect(service.remove).not.toHaveBeenCalled(); expect(service.submit).not.toHaveBeenCalled();
  });
  it("learns a deleted history fact before selection and keeps stale active or deleting rows inaccessible", async () => {
    const service = fixtureService(); service.history.mockResolvedValue([task({ deletion: "deleted", hasResult: false })]); const { result } = mount(service); await change(() => result.current.openPanel()); expect(result.current.task).toBeNull(); expect(result.current.tasks[0].deletion).toBe("deleted");
    for (const deletion of ["active", "deleting"] as const) {
      const stale = task({ deletion }); service.history.mockResolvedValue([stale]); await change(() => result.current.refreshHistory()); expect(result.current.tasks[0].deletion).toBe("deleted"); expect(result.current.tasks[0].hasResult).toBe(false);
      await change(() => result.current.viewTask(stale)); expect(result.current.task?.deletion).toBe("deleted"); expect(result.current.task?.hasResult).toBe(false); await change(() => result.current.reloadImage()); await change(() => result.current.deleteTask());
    }
    expect(result.current.imageUrl).toBeNull(); expect(service.image).not.toHaveBeenCalled(); expect(service.remove).not.toHaveBeenCalled(); expect(service.submit).not.toHaveBeenCalled();
  });
  it("uses the same delete action ID after uncertain deletion and never revives a stale history row", async () => {
    const service = fixtureService(); service.remove.mockRejectedValueOnce(new Error("controlled delete response loss")); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.reloadImage()); const url = result.current.imageUrl!; await change(() => result.current.deleteTask());
    expect(result.current.task?.deletion).toBe("deleting"); expect(result.current.imageUrl).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith(url); const original = service.remove.mock.calls[0][1];
    service.history.mockResolvedValue([task()]); await change(() => result.current.refreshHistory()); expect(result.current.tasks[0].deletion).toBe("deleting"); expect(result.current.tasks[0].hasResult).toBe(false); await change(() => result.current.viewTask(task())); expect(result.current.task?.deletion).toBe("deleting");
    await change(() => result.current.deleteTask()); expect(service.remove).toHaveBeenCalledTimes(2); expect(service.remove.mock.calls[1][1]).toBe(original); expect(result.current.task?.deletion).toBe("deleted"); expect(service.submit).not.toHaveBeenCalled();
  });
  it("discards a late private Blob and task response after deletion begins", async () => {
    const service = fixtureService(), image = deferred<Blob>(), read = deferred<PersonalPreviewTask>(), remove = deferred<PersonalPreviewTask>(); service.image.mockReturnValue(image.promise); service.task.mockReturnValue(read.promise); service.remove.mockReturnValue(remove.promise);
    const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.reloadImage()); await change(() => result.current.refreshTask()); await change(() => result.current.deleteTask()); await change(() => { image.resolve(resultBlob()); read.resolve(task()); });
    expect(result.current.task?.deletion).toBe("deleting"); expect(result.current.imageUrl).toBeNull(); expect(createUrl).not.toHaveBeenCalled(); await change(() => remove.resolve(task({ deletion: "deleted", hasResult: false }))); expect(result.current.task?.deletion).toBe("deleted");
  });
  it("does not let task A's late deletion response replace the newly selected task B", async () => {
    const service = fixtureService(), remove = deferred<PersonalPreviewTask>(); service.remove.mockReturnValue(remove.promise); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.deleteTask()); const second = task({ id: "task-b", requestId: "request-b", target: nextTarget }); await change(() => result.current.viewTask(second)); await change(() => remove.resolve(task({ deletion: "deleted", hasResult: false })));
    expect(result.current.task).toEqual(second); expect(result.current.target).toEqual(nextTarget); expect(result.current.deletionPending).toBe(false);
  });
  it("hides and clears old private photos/results immediately when the owner changes", async () => {
    const service = fixtureService(); const { result, rerender, initialProps } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.reloadImage()); const image = result.current.imageUrl!; await change(() => result.current.selectPhoto(photo())); const local = result.current.photo!.url;
    rerender({ ...initialProps, identityKey: "owner-b" }); expect(result.current.photo).toBeNull(); expect(result.current.imageUrl).toBeNull(); expect(result.current.task).toBeNull(); expect(result.current.tasks).toEqual([]); expect(result.current.requestId).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith(local); expect(revokeUrl).toHaveBeenCalledWith(image);
  });
  it("clears photos and private results and invokes identity invalidation on an adapter 401/expired signal", async () => {
    const service = fixtureService(); const { result, onIdentityInvalid } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.reloadImage()); const image = result.current.imageUrl!; await change(() => result.current.selectPhoto(photo())); const local = result.current.photo!.url;
    service.history.mockRejectedValue(new PersonalPreviewError("controlled expired owner", true)); await change(() => result.current.refreshHistory()); expect(onIdentityInvalid).toHaveBeenCalledTimes(1); expect(result.current.identityReady).toBe(false); expect(result.current.photo).toBeNull(); expect(result.current.task).toBeNull(); expect(result.current.imageUrl).toBeNull(); expect(result.current.tasks).toEqual([]); expect(revokeUrl).toHaveBeenCalledWith(local); expect(revokeUrl).toHaveBeenCalledWith(image); expect(service.submit).not.toHaveBeenCalled();
  });
  it("ignores late submit and image results after identity changes or unmount", async () => {
    const service = fixtureService(), submit = deferred<PersonalPreviewTask>(); service.submit.mockReturnValue(submit.promise); const { result, rerender, initialProps, unmount } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.selectPhoto(photo())); await change(() => result.current.confirm()); const request = service.submit.mock.calls[0][0], signal = service.submit.mock.calls[0][1]; rerender({ ...initialProps, identityKey: "owner-b" }); expect(signal.aborted).toBe(true); await change(() => submit.resolve(task({ requestId: request.requestId }))); expect(result.current.task).toBeNull(); expect(result.current.requestId).toBeNull();
    const image = deferred<Blob>(); service.image.mockReturnValue(image.promise); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task({ id: "task-b", requestId: "request-b", target: nextTarget }))); await change(() => result.current.reloadImage()); const created = createUrl.mock.calls.length; unmount(); await change(() => image.resolve(resultBlob())); expect(createUrl.mock.calls.length).toBe(created);
  });
});

describe("in-flight user intent and session boundaries", () => {
  it("keeps submit A's frozen target through close, current Look B, and reopen", async () => {
    const service = fixtureService(), submit = deferred<PersonalPreviewTask>(); service.submit.mockReturnValue(submit.promise); const { result, rerender, initialProps } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.selectPhoto(photo())); await change(() => result.current.confirm()); const original = service.submit.mock.calls[0][0];
    await change(() => result.current.closePanel()); rerender({ ...initialProps, currentTarget: nextTarget }); await change(() => result.current.openPanel()); expect(result.current.target).toEqual(firstTarget); expect(result.current.requestId).toBe(original.requestId); expect(result.current.submitting).toBe(true); expect(service.availability).toHaveBeenCalledTimes(1);
    await change(() => submit.resolve(task({ requestId: original.requestId, status: "queued", hasResult: false }))); expect(result.current.task?.target).toEqual(firstTarget); expect(result.current.targetChanged).toBe(true); expect(service.submit).toHaveBeenCalledTimes(1);
  });
  it("stopWaiting persists when an already-running poll resolves late", async () => {
    vi.useFakeTimers(); const service = fixtureService(), read = deferred<PersonalPreviewTask>(); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.selectPhoto(photo())); await change(() => result.current.confirm()); const accepted = result.current.task!; service.task.mockReturnValue(read.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(service.task).toHaveBeenCalledTimes(1); await change(() => result.current.stopWaiting()); await change(() => read.resolve({ ...accepted, status: "running" }));
    expect(result.current.waiting).toBe(false); expect(result.current.task?.status).toBe("running"); await act(async () => { await vi.advanceTimersByTimeAsync(12000); }); expect(service.task).toHaveBeenCalledTimes(1);
    service.task.mockResolvedValue({ ...accepted, status: "running" }); await change(() => result.current.refreshTask()); expect(result.current.waiting).toBe(true); expect(service.task).toHaveBeenCalledTimes(2);
  });
  it("new conversation clears an unsubmitted File without erasing accepted task history", async () => {
    const service = fixtureService(); const { result, rerender, initialProps } = mount(service, { sessionKey: "conversation-a" }); await change(() => result.current.openPanel()); await change(() => result.current.selectPhoto(photo())); const first = result.current.photo!.url;
    rerender({ ...initialProps, sessionKey: "conversation-b" }); expect(result.current.photo).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith(first); expect(service.submit).not.toHaveBeenCalled();
    await change(() => result.current.viewTask(task())); await change(() => result.current.refreshTask()); await change(() => result.current.selectPhoto(photo())); const second = result.current.photo!.url; rerender({ ...initialProps, sessionKey: "conversation-c" });
    expect(result.current.photo).toBeNull(); expect(revokeUrl).toHaveBeenCalledWith(second); expect(result.current.task?.id).toBe("task-a"); expect(result.current.tasks.map(value => value.id)).toContain("task-a"); expect(service.submit).not.toHaveBeenCalled();
  });
  it("deletion invalidates an in-flight history read and clears its loading state", async () => {
    const service = fixtureService(), history = deferred<PersonalPreviewTask[]>(), remove = deferred<PersonalPreviewTask>(); service.remove.mockReturnValue(remove.promise); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); service.history.mockReturnValue(history.promise); await change(() => result.current.refreshHistory()); expect(result.current.historyLoading).toBe(true);
    await change(() => result.current.deleteTask()); expect(result.current.historyLoading).toBe(false); await change(() => history.resolve([task()])); expect(result.current.tasks.every(value => value.id !== "task-a" || value.deletion !== "active")).toBe(true); expect(result.current.task?.deletion).toBe("deleting"); await change(() => remove.resolve(task({ deletion: "deleted", hasResult: false }))); expect(result.current.task?.deletion).toBe("deleted");
  });
  it.each(["active", "deleting"] as const)("does not downgrade confirmed deletion when an older %s history/task row appears", async deletion => {
    const service = fixtureService(); const { result } = mount(service); await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task())); await change(() => result.current.deleteTask()); expect(result.current.task?.deletion).toBe("deleted");
    const stale = task({ deletion }); service.history.mockResolvedValue([stale]); await change(() => result.current.refreshHistory()); expect(result.current.tasks[0].deletion).toBe("deleted"); expect(result.current.tasks[0].hasResult).toBe(false);
    await change(() => result.current.viewTask(stale)); expect(result.current.task?.deletion).toBe("deleted"); await change(() => result.current.reloadImage()); expect(service.image).not.toHaveBeenCalled(); await change(() => result.current.deleteTask()); expect(service.remove).toHaveBeenCalledTimes(1);
  });
  it("revokes a cached private image when the original task is reported expired", async () => {
    const service = fixtureService(); const { result } = mount(service);
    await change(() => result.current.openPanel()); await change(() => result.current.viewTask(task()));
    await change(() => result.current.setImageMode("personal")); const url = result.current.imageUrl;
    expect(url).not.toBeNull(); service.task.mockResolvedValue(task({ status: "expired", hasResult: false }));
    await change(() => result.current.refreshTask());
    expect(result.current.imageUrl).toBeNull(); expect(result.current.imageMode).toBe("model");
    expect(revokeUrl).toHaveBeenCalledWith(url); expect(service.submit).not.toHaveBeenCalled();
  });

  it("persists only safe identifiers and after remount queries the original request without a photo or POST", async () => {
    sessionStorage.clear(); const service = fixtureService();
    service.submit.mockRejectedValue(new Error("controlled lost response"));
    const first = mount(service, { persistRecovery: true });
    await change(() => first.result.current.openPanel()); await change(() => first.result.current.selectPhoto(photo()));
    await change(() => first.result.current.confirm()); const id = first.result.current.requestId!;
    const pointer = readPreviewPointer("owner-a");
    expect(pointer).toEqual({ version: 1, requestId: id, taskId: null, sessionId: firstTarget.sessionId, lookVersionId: firstTarget.lookVersionId });
    expect(Object.keys(pointer!)).toHaveLength(5); first.unmount();
    service.findRequest.mockResolvedValue(task({ requestId: id }));
    const restored = mount(service, { persistRecovery: true, currentTarget: nextTarget });
    await change(() => restored.result.current.openPanel());
    expect(service.findRequest).toHaveBeenCalledWith(id, expect.any(AbortSignal));
    expect(restored.result.current.task?.requestId).toBe(id); expect(restored.result.current.target).toEqual(firstTarget);
    expect(restored.result.current.photo).toBeNull(); expect(service.submit).toHaveBeenCalledTimes(1);
    restored.unmount(); sessionStorage.clear();
  });
  it("restored 404 stays uncertain and cannot manufacture an original-photo retry", async () => {
    sessionStorage.clear(); writePreviewPointer("owner-a", { version: 1, requestId: "old-request", taskId: null, sessionId: firstTarget.sessionId, lookVersionId: firstTarget.lookVersionId });
    const service = fixtureService(); const { result, unmount } = mount(service, { persistRecovery: true });
    await change(() => result.current.openPanel());
    expect(result.current.uncertain).toBe(true); expect(result.current.canRetry).toBe(false);
    expect(result.current.recoveryNotice).toContain("确认令牌未保存"); expect(service.submit).not.toHaveBeenCalled();
    await change(() => result.current.confirm()); expect(service.submit).not.toHaveBeenCalled();
    unmount(); sessionStorage.clear();
  });
  it("only explicit retry calls the service original-body replay after lookup grants eligibility", async () => {
    const base = fixtureService(); const retry = vi.fn<NonNullable<PersonalPreviewService["retry"]>>();
    const service = { ...base, retry, canRetry: vi.fn(() => true), releaseSensitive: vi.fn() };
    service.submit.mockRejectedValue(new Error("controlled response loss"));
    const { result } = mount(service); await change(() => result.current.openPanel());
    await change(() => result.current.selectPhoto(photo())); await change(() => result.current.confirm());
    const id = result.current.requestId!; expect(result.current.canRetry).toBe(false);
    await change(() => result.current.checkRequest()); expect(result.current.canRetry).toBe(true); expect(retry).not.toHaveBeenCalled();
    retry.mockResolvedValue(task({ requestId: id })); await change(() => result.current.retryRequest?.());
    expect(retry).toHaveBeenCalledWith(id, expect.any(AbortSignal)); expect(service.submit).toHaveBeenCalledTimes(1);
    expect(result.current.task?.requestId).toBe(id);
  });
  it("different identity never reads another identity pointer and unauthorized lookup clears its own pointer", async () => {
    sessionStorage.clear(); writePreviewPointer("owner-a", { version: 1, requestId: "old-request", taskId: null, sessionId: firstTarget.sessionId, lookVersionId: firstTarget.lookVersionId });
    const service = fixtureService(); const other = mount(service, { identityKey: "owner-b", persistRecovery: true });
    await change(() => other.result.current.openPanel()); expect(service.findRequest).not.toHaveBeenCalled(); expect(readPreviewPointer("owner-a")).toBeNull(); other.unmount();
    writePreviewPointer("owner-a", { version: 1, requestId: "old-request", taskId: null, sessionId: firstTarget.sessionId, lookVersionId: firstTarget.lookVersionId });
    service.findRequest.mockRejectedValue(new PersonalPreviewError("identity revoked", true));
    const original = mount(service, { persistRecovery: true }); await change(() => original.result.current.openPanel());
    expect(readPreviewPointer("owner-a")).toBeNull(); expect(original.result.current.identityReady).toBe(false); original.unmount(); sessionStorage.clear();
  });

});

describe("protected model image lifetime", () => {
  const frozen = () => task({ selectionStatus: "available", modelImagePath: "/api/v1/personal-preview/tasks/task-a/model-image" });
  it("revokes the original model Blob when switching to the personal image, with no submit", async () => {
    const service = { ...fixtureService(), modelImage: vi.fn().mockResolvedValue(new Blob(["synthetic-model"], { type: "image/png" })) };
    const { result } = mount(service); await change(() => result.current.viewTask(frozen())); await change(() => result.current.reloadModelImage!());
    const originalUrl = result.current.modelImageUrl; expect(originalUrl).toBeTruthy();
    await change(() => result.current.setImageMode("personal")); expect(revokeUrl).toHaveBeenCalledWith(originalUrl); expect(result.current.modelImageUrl).toBeNull(); expect(result.current.imageUrl).toBeTruthy();
    expect(service.submit).not.toHaveBeenCalled();
  });
  it("does not revive a late model image after deletion", async () => {
    const read = deferred<Blob>(); const service = { ...fixtureService(), modelImage: vi.fn().mockReturnValue(read.promise) };
    const { result } = mount(service); await change(() => result.current.viewTask(frozen())); await change(() => result.current.reloadModelImage!());
    await change(() => result.current.deleteTask()); await change(() => read.resolve(new Blob(["synthetic-model"], { type: "image/png" })));
    expect(result.current.modelImageUrl).toBeNull(); expect(result.current.task?.deletion).toBe("deleted"); expect(createUrl).not.toHaveBeenCalled(); expect(service.submit).not.toHaveBeenCalled();
  });
});
