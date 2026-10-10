import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalPreviewPanel } from "../components/personal-preview-panel";
import { unavailablePreview, type PersonalPreviewController, type PersonalPreviewStatus, type PersonalPreviewTarget, type PersonalPreviewTask } from "../app/lib/personal-preview-model";

const target: PersonalPreviewTarget = {
  sessionId: "session-current", lookVersionId: "lv-2", versionNo: 2, lookId: "look-2", modelUrl: "/model-current.png",
  items: [{ slot: "top", skuId: "SKU-TOP-2", name: "白色上衣" }, { slot: "bottom", skuId: "SKU-BOTTOM-2", name: "蓝色长裤" }, { slot: "shoes", skuId: "SKU-SHOES-2", name: "白色运动鞋" }],
};
const oldTarget: PersonalPreviewTarget = {
  sessionId: "session-old", lookVersionId: "lv-1", versionNo: 1, lookId: "look-1", modelUrl: "/model-original.png",
  items: [{ slot: "top", skuId: "SKU-TOP-1", name: "原版上衣" }, { slot: "bottom", skuId: "SKU-BOTTOM-1", name: "原版长裤" }, { slot: "shoes", skuId: "SKU-SHOES-1", name: "原版鞋" }],
};
const photoFile = new File(["synthetic-test-only"], "synthetic.png", { type: "image/png" });
function task(overrides: Partial<PersonalPreviewTask> = {}): PersonalPreviewTask {
  return { id: "task-original", requestId: "request-original", status: "succeeded", deletion: "active", target: oldTarget, createdAt: "2026-10-10T10:00:00Z", expiresAt: "2026-10-20T10:00:00Z", detail: "服务端给出的实际状态说明", hasResult: true, mode: "real", ...overrides };
}
function controller(overrides: Partial<PersonalPreviewController> = {}): PersonalPreviewController {
  return {
    open: true, target, targetChanged: false, identityReady: true, photo: { file: photoFile, url: "blob:local-photo" }, photoError: "",
    availability: { available: true, reasons: [], mode: "real", purposeNote: "仅用于本次搭配效果", retentionNote: "按实际能力返回的期限保留", costNote: "按已确认额度处理，费用以真实账单为准", permit: {} }, availabilityLoading: false,
    submitting: false, error: "", uncertain: false, requestId: null, task: null, tasks: [], historyLoading: false, historyError: "", waiting: false,
    imageUrl: null, imageLoading: false, imageError: "", imageMode: "model", deletionPending: false,
    openPanel: vi.fn(), closePanel: vi.fn(), selectPhoto: vi.fn(), removePhoto: vi.fn(), useCurrentTarget: vi.fn(), refreshAvailability: vi.fn(), confirm: vi.fn(),
    checkRequest: vi.fn(), refreshTask: vi.fn(), stopWaiting: vi.fn(), refreshHistory: vi.fn(), viewTask: vi.fn(), setImageMode: vi.fn(), reloadImage: vi.fn(), deleteTask: vi.fn(),
    ...overrides,
  };
}
function agree() { fireEvent.click(screen.getByRole("checkbox", { name: /我确认有权使用这张照片/ })); }
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("本人效果本地选择与明确确认", () => {
  it("关闭时不渲染，不读取或提交任何资料", () => {
    const c = controller({ open: false }); render(<PersonalPreviewPanel controller={c} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(c.refreshAvailability).not.toHaveBeenCalled(); expect(c.refreshHistory).not.toHaveBeenCalled(); expect(c.confirm).not.toHaveBeenCalled();
  });
  it("读取实际不可用原因、用途、期限和成本，勾选仍不能提交", () => {
    const c = controller({ availability: unavailablePreview }); render(<PersonalPreviewPanel controller={c} />); agree();
    expect(screen.getByText(unavailablePreview.reasons[0])).toBeVisible();
    expect(screen.getByText(unavailablePreview.purposeNote)).toBeVisible(); expect(screen.getByText(unavailablePreview.retentionNote)).toBeVisible(); expect(screen.getByText(unavailablePreview.costNote)).toBeVisible();
    expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "确认生成" })); expect(c.confirm).not.toHaveBeenCalled();
  });
  it("选择文件只交本地预览，重选与移除不触发上传、存储、确认或埋点", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); const storage = vi.spyOn(Storage.prototype, "setItem"); const dispatch = vi.spyOn(window, "dispatchEvent");
    const c = controller({ photo: null }); const view = render(<PersonalPreviewPanel controller={c} />);
    const input = screen.getByLabelText("选择本人照片"); expect(input).not.toHaveAttribute("multiple");
    fireEvent.change(input, { target: { files: [photoFile] } }); expect(c.selectPhoto).toHaveBeenCalledWith(photoFile);
    view.rerender(<PersonalPreviewPanel controller={{ ...c, photo: { file: photoFile, url: "blob:local-photo" } }} />);
    expect(screen.getByAltText("本地所选本人照片，尚未确认上传")).toHaveAttribute("src", "blob:local-photo");
    const second = new File(["second synthetic"], "second.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [second] } }); expect(c.selectPhoto).toHaveBeenLastCalledWith(second);
    fireEvent.click(screen.getByRole("button", { name: "移除照片" })); expect(c.removePhoto).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(c.confirm).not.toHaveBeenCalled();
  });
  it("必须先明确勾选，本次提交后取消同意，不能连续重复确认", () => {
    const c = controller(); render(<PersonalPreviewPanel controller={c} />);
    const confirm = screen.getByRole("button", { name: "确认生成" }); expect(confirm).toBeDisabled(); agree(); expect(confirm).toBeEnabled();
    fireEvent.click(confirm); expect(c.confirm).toHaveBeenCalledTimes(1); expect(confirm).toBeDisabled(); expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
  it.each([
    ["无身份", { identityReady: false }], ["无搭配", { target: null }], ["无照片", { photo: null }], ["正在读取条件", { availabilityLoading: true }],
    ["条件尚未读取", { availability: null }], ["照片错误", { photoError: "新文件未通过校验" }], ["正在提交", { submitting: true }], ["结果未知", { uncertain: true }], ["删除未完成", { deletionPending: true }],
  ] as [string, Partial<PersonalPreviewController>][])("%s时即使原先已勾选也立即禁提交", (_label, patch) => {
    const c = controller(); const view = render(<PersonalPreviewPanel controller={c} />); agree(); expect(screen.getByRole("button", { name: "确认生成" })).toBeEnabled();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, ...patch }} />);
    expect(screen.getByRole("button", { name: /^(确认生成|正在提交…)$/ })).toBeDisabled(); expect(c.confirm).not.toHaveBeenCalled();
  });
  it("目标变化保持原三SKU，必须显式改目标且再次同意", () => {
    const c = controller(); const view = render(<PersonalPreviewPanel controller={c} />); agree();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, targetChanged: true }} />);
    expect(screen.getByText("当前搭配已经变化")).toBeVisible(); expect(screen.getByText("SKU-TOP-2")).toBeVisible();
    expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled(); expect(c.useCurrentTarget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "改用当前搭配并重新核对" })); expect(c.useCurrentTarget).toHaveBeenCalledTimes(1);
    view.rerender(<PersonalPreviewPanel controller={{ ...c, target: oldTarget, targetChanged: false }} />);
    expect(screen.getByText("SKU-TOP-1")).toBeVisible(); expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled(); agree(); expect(screen.getByRole("button", { name: "确认生成" })).toBeEnabled();
  });
  it("换文件后旧同意不沿用；照片错误就地显示", () => {
    const c = controller(); const view = render(<PersonalPreviewPanel controller={c} />); agree();
    const replacement = new File(["new"], "new.png", { type: "image/png" });
    view.rerender(<PersonalPreviewPanel controller={{ ...c, photo: { file: replacement, url: "blob:new" }, photoError: "图片未通过完整解码，请重新选择。" }} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("图片未通过完整解码"); expect(screen.getByLabelText("选择本人照片")).toHaveAttribute("aria-invalid", "true");
  });
  it("重新读取用途、保留或费用条件后，必须再次明确同意", () => {
    const c = controller(); const view = render(<PersonalPreviewPanel controller={c} />); agree(); expect(screen.getByRole("button", { name: "确认生成" })).toBeEnabled();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, availability: { ...c.availability!, costNote: "本次需按新额度确认", permit: {} } }} />);
    expect(screen.getByText("本次需按新额度确认")).toBeVisible(); expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled();
    agree(); expect(screen.getByRole("button", { name: "确认生成" })).toBeEnabled();
  });
  it("能力显示可用但没有生成许可时不能确认", () => {
    const c = controller(); c.availability = { ...c.availability!, permit: null };
    render(<PersonalPreviewPanel controller={c} />); agree(); expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled(); expect(c.confirm).not.toHaveBeenCalled();
  });
});

describe("真实状态、冻结图片与私有历史", () => {
  it("恢复提示原样展示，可重试时只在明确点击后沿原请求调用", () => {
    const retryRequest = vi.fn(); const c = controller({ uncertain: true, requestId: "original-request", canRetry: true, retryRequest, recoveryNotice: "已保留原请求编号，请查询原任务。" });
    render(<PersonalPreviewPanel controller={c} />); expect(screen.getByText("已保留原请求编号，请查询原任务。")).toBeVisible(); expect(retryRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查询原请求" })); expect(c.checkRequest).toHaveBeenCalledTimes(1); expect(retryRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "用原照片和原编号重试提交" })); expect(retryRequest).toHaveBeenCalledTimes(1); expect(c.confirm).not.toHaveBeenCalled(); expect(c.selectPhoto).not.toHaveBeenCalled();
    expect(screen.getByText("原请求编号：original-request")).toBeVisible();
  });
  it.each([
    ["照片或确认不在内存", { canRetry: false, retryRequest: vi.fn() }], ["没有原体重试方法", { canRetry: true }],
  ] as [string, Partial<PersonalPreviewController>][])("%s时不显示不可用的原体重试按钮", (_label, recovery) => {
    render(<PersonalPreviewPanel controller={controller({ uncertain: true, ...recovery })} />);
    expect(screen.queryByRole("button", { name: "用原照片和原编号重试提交" })).not.toBeInTheDocument();
    expect(screen.getByText("本次照片或确认已不在内存，需要查询原记录；不会自动新建。")).toBeVisible();
  });
  it.each([{ identityReady: false }, { submitting: true }])("身份未就绪或正在提交时禁用原体重试", patch => {
    const retryRequest = vi.fn(); render(<PersonalPreviewPanel controller={controller({ uncertain: true, canRetry: true, retryRequest, ...patch })} />);
    const retry = screen.getByRole("button", { name: "用原照片和原编号重试提交" }); expect(retry).toBeDisabled(); fireEvent.click(retry); expect(retryRequest).not.toHaveBeenCalled();
  });
  it("只有未知提交状态展示原体重试，普通任务状态不自动变为重做", () => {
    const retryRequest = vi.fn(); render(<PersonalPreviewPanel controller={controller({ canRetry: true, retryRequest, task: task({ status: "failed" }) })} />);
    expect(screen.queryByRole("button", { name: "用原照片和原编号重试提交" })).not.toBeInTheDocument(); expect(retryRequest).not.toHaveBeenCalled();
  });
  it("展开冻结摘要和三张参考版本，只展示当前展示对象自己的记录", () => {
    const frozen: PersonalPreviewTarget = { ...oldTarget, selectionDigest: "historical-selection-digest", items: oldTarget.items.map((item, index) => ({ ...item, referenceAssetId: `ORIGINAL-ASSET-${index}`, referenceVersion: `original-v${index}` })) };
    const current: PersonalPreviewTarget = { ...target, selectionDigest: "current-selection-digest", items: target.items.map((item, index) => ({ ...item, referenceAssetId: `CURRENT-ASSET-${index}`, referenceVersion: "current-v9" })) };
    render(<PersonalPreviewPanel controller={controller({ target: current, task: task({ target: frozen }) })} />);
    const original = screen.getByRole("region", { name: "当前本人效果任务" }); fireEvent.click(within(original).getByText("查看搭配冻结依据"));
    expect(within(original).getByText("historical-selection-digest")).toBeVisible(); expect(within(original).queryByText("current-selection-digest")).not.toBeInTheDocument();
    for (let index = 0; index < 3; index++) { expect(within(original).getByText(`素材：ORIGINAL-ASSET-${index}`)).toBeVisible(); expect(within(original).getByText(`版本：original-v${index}`)).toBeVisible(); }
    expect(within(original).queryByText("版本：current-v9")).not.toBeInTheDocument();
  });
  it("旧任务缺摘要和参考字段显示历史未记录，不用当前完整资料补齐", () => {
    const current: PersonalPreviewTarget = { ...target, selectionDigest: "current-only-digest", items: target.items.map(item => ({ ...item, referenceAssetId: "CURRENT-ONLY", referenceVersion: "current-only-v" })) };
    render(<PersonalPreviewPanel controller={controller({ target: current, task: task() })} />);
    const original = screen.getByRole("region", { name: "当前本人效果任务" }); fireEvent.click(within(original).getByText("查看搭配冻结依据"));
    expect(within(original).getByText("历史未记录")).toBeVisible(); expect(within(original).getAllByText("素材：历史未记录")).toHaveLength(3); expect(within(original).getAllByText("版本：历史未记录")).toHaveLength(3);
    expect(within(original).queryByText("current-only-digest")).not.toBeInTheDocument(); expect(within(original).queryByText("素材：CURRENT-ONLY")).not.toBeInTheDocument();
  });
  it.each(["queued", "running", "provider_unknown", "output_pending_review", "succeeded", "failed", "expired"] as PersonalPreviewStatus[])("逐项展示%s，不构造百分比和成功结果", status => {
    const c = controller({ task: task({ status, hasResult: false }), imageMode: "personal", imageUrl: null }); render(<PersonalPreviewPanel controller={c} />);
    const current = screen.getByRole("region", { name: "当前本人效果任务" }); expect(within(current).getByText("服务端给出的实际状态说明")).toBeVisible();
    expect(within(current).getByText("task-original")).toBeVisible(); expect(within(current).queryByRole("img")).not.toBeInTheDocument();
    expect(within(current).queryByRole("progressbar")).not.toBeInTheDocument();
    if (["queued", "running", "provider_unknown"].includes(status)) { agree(); expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled(); }
    if (status === "output_pending_review") expect(within(current).getByText(/暂不算生成成功/)).toBeVisible();
    if (status === "expired") expect(within(current).getByText(/过期不代表生成服务已取消/)).toBeVisible();
  });
  it("mock能力与mock任务均显著标为技术模拟而非本人真实生成", () => {
    const c = controller({ task: task({ mode: "mock" }), imageMode: "personal", imageUrl: "blob:mock-result" }); c.availability = { ...c.availability!, mode: "mock" };
    render(<PersonalPreviewPanel controller={c} />); expect(screen.getAllByText("技术模拟", { selector: "strong" })).toHaveLength(2);
    expect(screen.getByAltText("技术模拟的效果图，非本人真实生成")).toHaveAttribute("src", "blob:mock-result");
    expect(screen.getByText("技术模拟 · 非本人真实生成")).toBeVisible();
  });
  it("未知受理只查询原请求，停止等待仅触发停止查询", () => {
    const c = controller({ uncertain: true, requestId: "request-original", task: task({ status: "provider_unknown", hasResult: false }), waiting: true });
    render(<PersonalPreviewPanel controller={c} />); fireEvent.click(screen.getByRole("button", { name: "查询原请求" })); expect(c.checkRequest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "停止等待" })); expect(c.stopWaiting).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/停止等待只停止本页查询/)).toBeVisible(); expect(c.confirm).not.toHaveBeenCalled(); expect(c.deleteTask).not.toHaveBeenCalled();
  });
  it("任务模特、本人图片与SKU始终对应task.target，不拿当前搭配补历史", () => {
    const c = controller({ task: task(), imageMode: "model", imageUrl: "blob:private-original" }); const view = render(<PersonalPreviewPanel controller={c} />);
    const current = screen.getByRole("region", { name: "当前本人效果任务" });
    expect(within(current).getByRole("img")).toHaveAttribute("src", "/model-original.png"); expect(within(current).getByText("SKU-TOP-1")).toBeVisible(); expect(within(current).queryByText("SKU-TOP-2")).not.toBeInTheDocument();
    fireEvent.click(within(current).getByRole("button", { name: "本人效果" })); expect(c.setImageMode).toHaveBeenCalledWith("personal"); expect(c.confirm).not.toHaveBeenCalled();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, imageMode: "personal" }} />);
    expect(within(current).getByRole("img")).toHaveAttribute("src", "blob:private-original"); expect(within(current).getByRole("img")).not.toHaveAttribute("src", "/model-current.png");
  });
  it("后端历史未冻结展示版本号和模特URL时，用真实lookVersionId并禁用模特切换", () => {
    const frozen: PersonalPreviewTarget = { ...oldTarget, versionNo: null, modelUrl: null, lookVersionId: "lv-frozen-public-42" };
    const historical = task({ target: frozen }); const c = controller({ target, task: historical, tasks: [historical], imageMode: "model", imageUrl: "blob:private-frozen-42" });
    const view = render(<PersonalPreviewPanel controller={c} />); const current = screen.getByRole("region", { name: "当前本人效果任务" });
    expect(within(current).getByText("版本 lv-frozen-public-42")).toBeVisible(); expect(within(current).getByText("搭配版本 lv-frozen-public-42")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "本人效果历史" })).getByText("搭配版本 lv-frozen-public-42")).toBeVisible();
    expect(current).not.toHaveTextContent("版本 null"); expect(within(current).queryByText("搭配版本 2")).not.toBeInTheDocument();
    const modelSwitch = within(current).getByRole("button", { name: "固定模特" }); expect(modelSwitch).toBeDisabled(); fireEvent.click(modelSwitch); expect(c.setImageMode).not.toHaveBeenCalled();
    expect(within(current).queryByRole("img")).not.toBeInTheDocument(); expect(within(current).getByText("该历史版本没有模特参考图")).toBeVisible();
    fireEvent.click(within(current).getByRole("button", { name: "本人效果" })); expect(c.setImageMode).toHaveBeenCalledWith("personal");
    view.rerender(<PersonalPreviewPanel controller={{ ...c, imageMode: "personal" }} />);
    expect(within(current).getByAltText("版本 lv-frozen-public-42 的本人 AI 穿搭效果参考")).toHaveAttribute("src", "blob:private-frozen-42");
    expect(within(current).getByRole("button", { name: "固定模特" })).toBeDisabled();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, imageMode: "personal", imageUrl: null }} />);
    expect(within(current).queryByRole("img")).not.toBeInTheDocument(); expect(within(current).getByText("暂时没有可显示的本人效果")).toBeVisible();
    expect(c.confirm).not.toHaveBeenCalled(); expect(c.reloadImage).not.toHaveBeenCalled();
  });
  it("public_selection没有商品名时原样显示SKU，不从当前商品补名或猜测版本", () => {
    const publicSelection: PersonalPreviewTarget = { ...oldTarget, versionNo: null, modelUrl: null, lookVersionId: "lv-public-no-display-fields", items: oldTarget.items.map(item => ({ ...item, name: item.skuId })) };
    render(<PersonalPreviewPanel controller={controller({ target: publicSelection, task: task({ target: publicSelection }), imageMode: "model" })} />);
    for (const label of ["本次生成搭配", "当前本人效果任务"]) {
      const region = screen.getByRole("region", { name: label });
      expect(within(region).getByText("搭配版本 lv-public-no-display-fields")).toBeVisible();
      for (const item of publicSelection.items) expect(within(region).getByText(item.skuId, { selector: "strong" })).toBeVisible();
      for (const item of [...oldTarget.items, ...target.items]) expect(within(region).queryByText(item.name)).not.toBeInTheDocument();
      expect(region).not.toHaveTextContent("版本 null");
    }
    const current = screen.getByRole("region", { name: "当前本人效果任务" }); expect(within(current).queryByRole("img")).not.toBeInTheDocument();
    expect(within(current).getByRole("button", { name: "固定模特" })).toBeDisabled();
  });
  it("成功任务读取失败只有重新读取，不显示固定图代成功或发起重做", () => {
    const c = controller({ task: task(), imageMode: "personal", imageError: "授权结果暂时读取失败", imageUrl: null }); render(<PersonalPreviewPanel controller={c} />);
    const current = screen.getByRole("region", { name: "当前本人效果任务" }); expect(within(current).queryByRole("img")).not.toBeInTheDocument();
    expect(within(current).getByText("效果已完成")).toBeVisible(); expect(within(current).getByText("暂时没有可显示的本人效果")).toBeVisible();
    fireEvent.click(within(current).getByRole("button", { name: "重新读取本人效果" })); expect(c.reloadImage).toHaveBeenCalledTimes(1); expect(c.confirm).not.toHaveBeenCalled();
  });
  it("本人图浏览器解码失败隐藏破图，只有显式重读原结果，不自动请求或套模特", () => {
    const c = controller({ task: task(), imageMode: "personal", imageUrl: "blob:invalid-result" }); const view = render(<PersonalPreviewPanel controller={c} />);
    const current = screen.getByRole("region", { name: "当前本人效果任务" }); const broken = within(current).getByRole("img"); fireEvent.error(broken);
    expect(within(current).queryByRole("img")).not.toBeInTheDocument(); expect(within(current).getByText("本人效果图片暂时无法显示，可重新读取原结果，不会重新生成。")).toBeVisible(); expect(within(current).getByText("效果已完成")).toBeVisible();
    expect(c.reloadImage).not.toHaveBeenCalled(); expect(c.confirm).not.toHaveBeenCalled();
    fireEvent.click(within(current).getByRole("button", { name: "重新读取本人效果" })); expect(c.reloadImage).toHaveBeenCalledTimes(1); expect(c.confirm).not.toHaveBeenCalled();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, imageUrl: "blob:reloaded-result" }} />);
    expect(within(current).getByRole("img")).toHaveAttribute("src", "blob:reloaded-result"); expect(within(current).queryByText("本人效果图片暂时无法显示，可重新读取原结果，不会重新生成。")).not.toBeInTheDocument();
    fireEvent.error(broken); expect(within(current).getByRole("img")).toHaveAttribute("src", "blob:reloaded-result");
  });
  it("同URL的另一任务不继承上一任务的本地图片错误", () => {
    const c = controller({ task: task(), imageMode: "personal", imageUrl: "blob:task-result" }); const view = render(<PersonalPreviewPanel controller={c} />);
    fireEvent.error(screen.getByAltText("版本 1 的本人 AI 穿搭效果参考")); expect(screen.getByText("本人效果图片暂时无法显示，可重新读取原结果，不会重新生成。")).toBeVisible();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, task: task({ id: "task-another", target }) }} />);
    expect(screen.getByAltText("版本 2 的本人 AI 穿搭效果参考")).toHaveAttribute("src", "blob:task-result"); expect(screen.queryByText("本人效果图片暂时无法显示，可重新读取原结果，不会重新生成。")).not.toBeInTheDocument();
  });
  it("固定图遵从basePath，出错只占位、不更改本人任务与图片状态", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/styling");
    const c = controller({ task: task(), imageMode: "model", imageUrl: "blob:valid-result" }); const view = render(<PersonalPreviewPanel controller={c} />);
    const current = screen.getByRole("region", { name: "当前本人效果任务" }); const model = within(current).getByRole("img"); expect(model).toHaveAttribute("src", "/styling/model-original.png");
    fireEvent.error(model); expect(within(current).queryByRole("img")).not.toBeInTheDocument(); expect(within(current).getByText("这张固定模特参考图暂时无法显示，不影响本人效果的任务状态。")).toBeVisible(); expect(within(current).getByText("效果已完成")).toBeVisible();
    expect(c.reloadImage).not.toHaveBeenCalled(); expect(c.confirm).not.toHaveBeenCalled();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, imageMode: "personal" }} />); expect(within(current).getByRole("img")).toHaveAttribute("src", "blob:valid-result");
    expect(within(current).queryByText("这张固定模特参考图暂时无法显示，不影响本人效果的任务状态。")).not.toBeInTheDocument();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, task: task({ target: { ...oldTarget, modelUrl: "/model-reloaded.png" } }) }} />);
    expect(within(current).getByRole("img")).toHaveAttribute("src", "/styling/model-reloaded.png");
  });
  it("身份失效即隐藏旧照片、任务及私有历史，并禁选照与提交", () => {
    const c = controller({ task: task(), tasks: [task()], imageMode: "personal", imageUrl: "blob:private-original" }); const view = render(<PersonalPreviewPanel controller={c} />);
    expect(screen.getByRole("button", { name: "查看任务 task-original" })).toBeVisible();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, identityReady: false }} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); expect(screen.queryByText("task-original")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "查看任务 task-original" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择照片" })).toBeDisabled(); expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled();
  });
  it("历史读取、空、错误分别展示，查看已有任务不生成", () => {
    const c = controller(); const view = render(<PersonalPreviewPanel controller={c} />); expect(screen.getByText(/还没有本人效果记录/)).toBeVisible();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, historyLoading: true }} />); expect(screen.getByText("正在读取效果历史…")).toBeVisible();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, historyError: "历史读取失败" }} />); expect(screen.getByText("历史读取失败")).toBeVisible(); expect(screen.queryByText(/还没有本人效果记录/)).not.toBeInTheDocument();
    const old = task({ mode: "mock" }); view.rerender(<PersonalPreviewPanel controller={{ ...c, tasks: [old] }} />);
    expect(screen.getByText("效果已完成 · 技术模拟，非本人真实生成")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "查看任务 task-original" })); expect(c.viewTask).toHaveBeenCalledWith(old); expect(c.confirm).not.toHaveBeenCalled();
  });
});

describe("删除与模态焦点", () => {
  it("删除必须二次确认，取消不调用；仅明确确认才交给控制器", () => {
    const c = controller({ task: task() }); render(<PersonalPreviewPanel controller={c} />);
    fireEvent.click(screen.getByRole("button", { name: "删除这次照片与效果" })); expect(c.deleteTask).not.toHaveBeenCalled();
    const group = screen.getByRole("group", { name: "确认删除这次照片与效果" }); expect(within(group).getByText(/可能仍在运行或计费/)).toBeVisible();
    fireEvent.click(within(group).getByRole("button", { name: "保留这次效果" })); expect(screen.queryByRole("group", { name: "确认删除这次照片与效果" })).not.toBeInTheDocument(); expect(c.deleteTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除这次照片与效果" })); fireEvent.click(screen.getByRole("button", { name: "确认删除" })); expect(c.deleteTask).toHaveBeenCalledTimes(1);
  });
  it("换看另一任务不沿用删除确认", () => {
    const c = controller({ task: task() }); const view = render(<PersonalPreviewPanel controller={c} />);
    fireEvent.click(screen.getByRole("button", { name: "删除这次照片与效果" })); view.rerender(<PersonalPreviewPanel controller={{ ...c, task: task({ id: "task-another" }) }} />);
    expect(screen.queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument(); expect(c.deleteTask).not.toHaveBeenCalled();
  });
  it.each(["deleting", "deleted"] as const)("服务端%s时旧结果不可见，删除处理不被写成已完成", deletion => {
    const c = controller({ task: task({ deletion }), imageMode: "personal", imageUrl: "blob:stale" }); render(<PersonalPreviewPanel controller={c} />);
    const current = screen.getByRole("region", { name: "当前本人效果任务" }); expect(within(current).queryByRole("img")).not.toBeInTheDocument(); expect(within(current).queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument();
    if (deletion === "deleting") { expect(within(current).getByText("删除处理中")).toBeVisible(); expect(within(current).queryByText("已删除")).not.toBeInTheDocument(); expect(within(current).getByText(/服务端是否完成以重新查询的状态为准/)).toBeVisible(); }
    else expect(within(current).getByText(/这不代表生成服务方已完成删除/)).toBeVisible();
  });
  it("本地删除pending立即撤图，但仍不宣称服务端完成", () => {
    const c = controller({ task: task(), deletionPending: true, imageMode: "personal", imageUrl: "blob:stale" }); render(<PersonalPreviewPanel controller={c} />);
    const current = screen.getByRole("region", { name: "当前本人效果任务" }); expect(within(current).queryByRole("img")).not.toBeInTheDocument(); expect(within(current).getByText("删除处理中")).toBeVisible(); expect(within(current).queryByText("已删除")).not.toBeInTheDocument();
  });
  function Harness() {
    const [open, setOpen] = useState(false); const c = controller({ open, closePanel: () => setOpen(false) });
    return <><button onClick={() => setOpen(true)}>打开本人效果</button><PersonalPreviewPanel controller={c} /></>;
  }
  it.each(["Escape", "关闭本人效果", "暂不生成"])("%s关闭并归还触发按钮焦点", action => {
    render(<StrictMode><Harness /></StrictMode>); const trigger = screen.getByRole("button", { name: "打开本人效果" }); trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "看看我穿的效果" }); expect(screen.getByRole("button", { name: "关闭本人效果" })).toHaveFocus();
    if (action === "Escape") fireEvent.keyDown(dialog, { key: "Escape" }); else fireEvent.click(screen.getByRole("button", { name: action }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
  });
  it("Tab在可用控件首尾循环；原生cancel只请求关闭", () => {
    const c = controller(); render(<PersonalPreviewPanel controller={c} />); const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("button", { name: "关闭本人效果" }); const last = screen.getByRole("button", { name: "暂不生成" });
    first.focus(); fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" }); expect(first).toHaveFocus();
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true })); expect(c.closePanel).toHaveBeenCalledTimes(1);
  });
});

describe("publication 1.0.2 original model and cleared history", () => {
  it("shows retained IDs for cleared history without current SKU or current images", () => {
    const cleared = { ...oldTarget, lookId: null, modelUrl: null, versionNo: null, items: [], contentCleared: true };
    const c = controller({ target: cleared, photo: null, availability: null, task: task({ target: cleared, selectionStatus: "content_cleared", hasResult: false }), tasks: [] });
    render(<PersonalPreviewPanel controller={c} />);
    expect(screen.getAllByText(/搭配内容已按期限清除/).length).toBeGreaterThan(0);
    expect(screen.getByText("task-original")).toBeVisible(); expect(screen.queryByText("白色上衣")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "查看效果图片" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新读取生成条件" })).toBeDisabled(); expect(screen.getByRole("button", { name: "确认生成" })).toBeDisabled();
  });
  it("reads the protected frozen model and displays its owned Blob instead of the legacy URL", () => {
    const reloadModelImage = vi.fn(); const c = controller({ task: task({ selectionStatus: "available", modelImagePath: "/api/v1/personal-preview/tasks/task-original/model-image" }), reloadModelImage });
    const view = render(<PersonalPreviewPanel controller={c} />); expect(reloadModelImage).toHaveBeenCalledTimes(1);
    expect(screen.queryByAltText(/固定模特搭配参考/)).not.toBeInTheDocument();
    view.rerender(<PersonalPreviewPanel controller={{ ...c, modelImageUrl: "blob:frozen-original" }} />);
    expect(screen.getByAltText(/固定模特搭配参考/)).toHaveAttribute("src", "blob:frozen-original");
    expect(reloadModelImage).toHaveBeenCalledTimes(1); expect(c.confirm).not.toHaveBeenCalled();
  });
});

describe("real pending output private download", () => {
  it("keeps pending warning and offers only the owned result Blob for download", () => {
    const c = controller({ task: task({ mode: "real", status: "output_pending_review", hasResult: true }), imageMode: "personal", imageUrl: "blob:authorized-result" });
    render(<PersonalPreviewPanel controller={c} />); expect(screen.getByText(/画面与完整三件商品仍待核对/)).toBeVisible();
    expect(screen.getByRole("link", { name: "下载本人AI参考图" })).toHaveAttribute("href", "blob:authorized-result");
    expect(screen.getByRole("link", { name: "下载本人AI参考图" })).toHaveAttribute("download", "personal-ai-reference-task-original.jpg"); expect(screen.queryByText(/技术模拟.*非本人真实/)).not.toBeInTheDocument(); expect(c.confirm).not.toHaveBeenCalled();
  });
});
