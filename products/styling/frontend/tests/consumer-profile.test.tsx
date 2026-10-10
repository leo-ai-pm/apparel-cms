import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE_DRAFT, type ProfileDraft } from "../app/lib/profile-draft";
import { ProfilePanel, ProfileSupplementCard } from "../components/consumer-profile";
import type { ConsumerProfileController } from "../app/lib/use-consumer-profile";
import type { SavedConsumerProfile } from "../app/lib/consumer-profile";

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); } });
});

afterEach(() => {
  cleanup();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function Harness({ onApply = vi.fn(), onClearLocal = vi.fn(), initial = EMPTY_PROFILE_DRAFT }: { onApply?: (value: ProfileDraft) => void; onClearLocal?: () => void; initial?: ProfileDraft }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>打开资料</button><ProfilePanel open={open} onClose={() => setOpen(false)} draft={initial} onApply={onApply} onClearLocal={onClearLocal} /></>;
}

function openPanel(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "打开资料" }));
  return screen.getByRole("dialog", { name: "我的穿搭资料" });
}

function chooseSize(label: string, size: string) {
  fireEvent.click(within(screen.getByRole("group", { name: label })).getByRole("button", { name: size }));
}

describe("本次资料抽屉，不伪造服务端保存", () => {
  it("打开不填中间值、不请求接口或写存储，全部字段保持可空", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const onApply = vi.fn();
    openPanel({ onApply });
    expect(screen.getByText("仅本次使用，未保存")).toBeVisible();
    for (const input of screen.getAllByRole("textbox")) expect(input).toHaveValue("");
    expect(onApply).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(onApply).toHaveBeenCalledWith(EMPTY_PROFILE_DRAFT);
    storage.mockRestore();
  });

  it("取消舍弃未应用编辑，重开仍为调用者草稿，不改入参", () => {
    const original = Object.freeze({ ...EMPTY_PROFILE_DRAFT, bottom: "L" });
    const onApply = vi.fn();
    openPanel({ initial: original, onApply });
    chooseSize("上衣常穿尺码", "S");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "打开资料" }));
    expect(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "false");
    expect(within(screen.getByRole("group", { name: "下装常穿尺码" })).getByRole("button", { name: "L" })).toHaveAttribute("aria-pressed", "true");
    expect(original.top).toBeNull();
  });

  it("独立保留 S / XL / 39 / 500，不把可选资料改成 M1 支持值", () => {
    const onApply = vi.fn();
    openPanel({ onApply });
    chooseSize("上衣常穿尺码", "S");
    chooseSize("下装常穿尺码", "XL");
    const shoe = screen.getByRole("textbox", { name: "直接输入常穿鞋码（中国码）" });
    fireEvent.change(shoe, { target: { value: "39" } }); fireEvent.blur(shoe);
    fireEvent.click(screen.getByRole("button", { name: "¥500" }));
    expect(screen.getByText(/选的尺码暂未完整覆盖/)).toBeVisible();
    expect(screen.getByText(/本次预算低于当前最低/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ height_cm: null, weight_kg: null, top: "S", bottom: "XL", shoes: 39, budget_fen: 50000 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("长期保存、更新、清除、默认预算均不可假成功，独立预算不自动保存", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    openPanel();
    for (const name of ["保存我的资料", "更新我的资料", "清除已保存资料", "设为常用预算"]) {
      const action = screen.getByRole("button", { name });
      expect(action).toBeDisabled(); fireEvent.click(action);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByText(/资料服务尚未开放。本页选择不会保存/)).toBeVisible();
    expect(screen.queryByText(/已保存在本设备/)).not.toBeInTheDocument();
  });

  it("非法身高输入阻止填入，保留编辑并显示就地错误", () => {
    const onApply = vi.fn();
    openPanel({ onApply, initial: { ...EMPTY_PROFILE_DRAFT, height_cm: 165 } });
    const height = screen.getByRole("textbox", { name: "直接输入身高（cm）" });
    fireEvent.change(height, { target: { value: "-1" } }); fireEvent.blur(height);
    expect(height).toBeInvalid();
    expect(screen.getByRole("alert")).toHaveTextContent("身高");
    fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(height).toHaveValue("-1");
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("Escape、外部背景和关闭按钮都取消，不应用选择", () => {
    const onApply = vi.fn();
    const dialog = openPanel({ onApply });
    chooseSize("上衣常穿尺码", "S");
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开资料" }));
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开资料" }));
    fireEvent.click(screen.getByRole("heading", { name: "我的穿搭资料" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭我的穿搭资料" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("仅确认后清本次选择，说明不删服务端资料与历史，也不伪装退出", () => {
    const onClearLocal = vi.fn(); const onApply = vi.fn();
    openPanel({ onClearLocal, onApply });
    fireEvent.click(screen.getByText("保存范围与共享设备"));
    expect(screen.getByText(/当前尚未确认身份或保存范围/)).toBeVisible();
    expect(screen.getByText(/清除已保存资料不会删除历史搭配或已受理请求/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清空本次选择" }));
    expect(onClearLocal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保留选择" }));
    fireEvent.click(screen.getByRole("button", { name: "清空本次选择" }));
    fireEvent.click(screen.getByRole("button", { name: "确认清空本次选择" }));
    expect(onClearLocal).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /退出|换人/ })).not.toBeInTheDocument();
  });

  it("StrictMode 的 dialog effect 回收不触发取消", () => {
    const onClose = vi.fn();
    render(<StrictMode><ProfilePanel open onClose={onClose} draft={EMPTY_PROFILE_DRAFT} onApply={vi.fn()} /></StrictMode>);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("单字段补充卡片", () => {
  it("仅呈现父层指定字段，选择不会发送或提交，应用只回传该值", () => {
    const onChange = vi.fn(); const onDismiss = vi.fn(); const onOpenProfile = vi.fn();
    render(<ProfileSupplementCard field="top" value={null} onChange={onChange} onDismiss={onDismiss} onOpenProfile={onOpenProfile} />);
    expect(screen.queryByRole("group", { name: "下装常穿尺码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    chooseSize("上衣常穿尺码", "L");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(onChange).toHaveBeenCalledWith("L");
    fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭补充上衣尺码" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("预算只按人民币分回传，非法草稿不会提交旧金额", () => {
    const onChange = vi.fn();
    render(<ProfileSupplementCard field="budget_fen" value={80000} onChange={onChange} onDismiss={vi.fn()} onOpenProfile={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "自定义整套预算（人民币元）" });
    fireEvent.change(input, { target: { value: "0.001" } }); fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "500.50" } }); fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(onChange).toHaveBeenCalledWith(50050);
  });
});

const savedProfile = (): SavedConsumerProfile => ({ profile_contract: "consumer_profile_v1", profile_id: "profile-panel-unit", profile_version: 1, scope_kind: "device", status: "saved", base_profile: { height_cm: 165, weight_kg: null, usual_sizes: { top: { system: "clothing_alpha", value: "M" }, bottom: { system: "clothing_alpha", value: "L" }, shoes: { system: "cn_shoe", value: "38" } } }, default_budget_fen: 80000, updated_at: "2026-10-10T00:00:00Z", expires_at: "2027-04-08T00:00:00Z", storage_notice: "测试夹具：保存在当前浏览器，非跨设备同步" });
function controller(profile: SavedConsumerProfile | null = savedProfile()): ConsumerProfileController {
  return { profile, status: "ready", ready: true, identityReady: true, busy: false, error: "", notice: "", pendingMutation: null, identityRevision: 0, refresh: vi.fn(async () => profile), mutate: vi.fn(async () => true), retryMutation: vi.fn(async () => true), reset: vi.fn(), canReplayPending: true, discardPendingMutation: vi.fn() };
}

describe("已接真实资料接口的抽屉状态（控制器替身不代表服务端保存证据）", () => {
  it("展示真实scope/版本，仅保存触碰字段，预算与未填字段不混入patch", async () => {
    const service = controller(); const onApply = vi.fn();
    render(<ProfilePanel open draft={EMPTY_PROFILE_DRAFT} onApply={onApply} onClose={vi.fn()} controller={service} />);
    expect(screen.getByText(/本设备的当前浏览器 · 版本 1/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "直接输入身高（cm）" })).toHaveValue("165");
    expect(service.mutate).not.toHaveBeenCalled();
    chooseSize("上衣常穿尺码", "S");
    fireEvent.click(screen.getByRole("button", { name: "¥500" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新我的资料" })); });
    expect(service.mutate).toHaveBeenCalledWith("update", { base_profile: { usual_sizes: { top: { system: "clothing_alpha", value: "S" } } } });
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "自定义整套预算（人民币元）" })).toHaveValue("500.00");
  });

  it("明确清空单字段才提交null，其他已保存资料省略不删", async () => {
    const service = controller();
    render(<ProfilePanel open draft={EMPTY_PROFILE_DRAFT} onApply={vi.fn()} onClose={vi.fn()} controller={service} />);
    fireEvent.click(screen.getByRole("button", { name: "清空或跳过身高" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新我的资料" })); });
    expect(service.mutate).toHaveBeenCalledWith("update", { base_profile: { height_cm: null } });
  });

  it("常用预算独立二次确认，仅发送default_budget_fen和显式预算意图", async () => {
    const service = controller();
    render(<ProfilePanel open draft={EMPTY_PROFILE_DRAFT} onApply={vi.fn()} onClose={vi.fn()} controller={service} />);
    fireEvent.click(screen.getByRole("button", { name: "¥500" }));
    fireEvent.click(screen.getByRole("button", { name: "设为常用预算" }));
    expect(service.mutate).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确认设为常用预算" })); });
    expect(service.mutate).toHaveBeenCalledWith("update", { default_budget_fen: 50000 }, true);
    fireEvent.click(screen.getByRole("button", { name: "清除常用预算" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确认清除常用预算" })); });
    expect(service.mutate).toHaveBeenLastCalledWith("update", { default_budget_fen: null }, true);
    expect(screen.getByRole("textbox", { name: "自定义整套预算（人民币元）" })).toHaveValue("500.00");
  });

  it("读取未完成时可编辑，加载成功只补未触碰字段；后台清除不复活默认", async () => {
    const loading = { ...controller(null), status: "loading" as const, ready: false, identityReady: false };
    const props = { open: true, draft: EMPTY_PROFILE_DRAFT, onApply: vi.fn(), onClose: vi.fn() };
    const view = render(<ProfilePanel {...props} controller={loading} />);
    chooseSize("上衣常穿尺码", "S");
    view.rerender(<ProfilePanel {...props} controller={controller()} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "直接输入身高（cm）" })).toHaveValue("165"));
    expect(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "true");
    const clearedProfile = { ...savedProfile(), profile_version: 2, status: "cleared" as const, base_profile: { height_cm: null, weight_kg: null, usual_sizes: { top: null, bottom: null, shoes: null } }, default_budget_fen: null };
    view.rerender(<ProfilePanel {...props} controller={controller(clearedProfile)} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "直接输入身高（cm）" })).toHaveValue(""));
    expect(screen.getByRole("textbox", { name: "自定义整套预算（人民币元）" })).toHaveValue("");
    expect(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    expect(props.onApply).toHaveBeenCalledWith({ ...EMPTY_PROFILE_DRAFT, top: "S" });
  });

  it("保存失败保留编辑且不触发本次发送；清除成功才通知调用者", async () => {
    const service = controller(); vi.mocked(service.mutate).mockResolvedValueOnce(false);
    const onCleared = vi.fn(); const onApply = vi.fn();
    render(<ProfilePanel open draft={EMPTY_PROFILE_DRAFT} onApply={onApply} onClose={vi.fn()} controller={service} onCleared={onCleared} />);
    chooseSize("上衣常穿尺码", "S");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新我的资料" })); });
    expect(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "true");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清除已保存资料" }));
    expect(onCleared).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确认清除已保存资料" })); });
    expect(service.mutate).toHaveBeenLastCalledWith("clear", {});
    expect(onCleared).toHaveBeenCalledTimes(1);
  });
});
