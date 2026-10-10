import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BudgetPicker, SizeButtons, WheelPicker, type WheelPickerProps } from "../components/profile-controls";

function ControlledWheel(props: Partial<WheelPickerProps> & { initial?: number | null } = {}) {
  const [value, setValue] = useState<number | null>(props.initial ?? null);
  return <WheelPicker label="身高" unit="cm" initialValue={165} {...props} value={value} onChange={next => { setValue(next); props.onChange?.(next); }} />;
}
function ControlledBudget({ initial = null, onChange = () => undefined, disabled = false }: { initial?: number | null; onChange?: (next: number | null) => void; disabled?: boolean }) {
  const [value, setValue] = useState<number | null>(initial);
  return <BudgetPicker value={value} disabled={disabled} onChange={next => { setValue(next); onChange(next); }} />;
}

describe("资料滚筒控件", () => {
  it("未触碰的身高体重鞋码保持 null，不提交中间刻度", () => {
    const change = vi.fn();
    render(<><WheelPicker label="身高" unit="cm" value={null} initialValue={165} onChange={change} />
      <WheelPicker label="体重" unit="kg" value={null} initialValue={55} onChange={change} />
      <WheelPicker label="鞋码" unit="中国码" value={null} options={[35, 36, 37, 38, 39, 40]} initialValue={38} onChange={change} /></>);
    expect(screen.getAllByRole("spinbutton")).toHaveLength(3);
    for (const control of screen.getAllByRole("spinbutton")) {
      expect(control).toHaveAttribute("aria-valuetext", "未选择");
      expect(control).not.toHaveAttribute("aria-valuenow");
      expect(control.firstElementChild?.children).toHaveLength(5);
    }
    expect(screen.getAllByRole("textbox").every(input => (input as HTMLInputElement).value === "")).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });

  it("明确上下按钮选择并调整，清空后保持未选择", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(<ControlledWheel onChange={change} />);
    await user.click(screen.getByRole("button", { name: "增大身高" }));
    expect(change).toHaveBeenLastCalledWith(165);
    await user.click(screen.getByRole("button", { name: "增大身高" }));
    expect(screen.getByRole("spinbutton")).toHaveAttribute("aria-valuenow", "166");
    await user.click(screen.getByRole("button", { name: "减小身高" }));
    expect(change).toHaveBeenLastCalledWith(165);
    await user.click(screen.getByRole("button", { name: "清空或跳过身高" }));
    expect(change).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("键盘方向/Page/Home/End/删除可用，无硬编码身高合法上下界", () => {
    render(<ControlledWheel initial={165} />);
    const wheel = screen.getByRole("spinbutton");
    expect(wheel).not.toHaveAttribute("aria-valuemax");
    expect(wheel).not.toHaveAttribute("aria-valuemin");
    fireEvent.keyDown(wheel, { key: "ArrowUp" });
    expect(wheel).toHaveAttribute("aria-valuenow", "166");
    fireEvent.keyDown(wheel, { key: "ArrowDown" });
    fireEvent.keyDown(wheel, { key: "PageUp" });
    expect(wheel).toHaveAttribute("aria-valuenow", "170");
    fireEvent.keyDown(wheel, { key: "PageDown" });
    expect(wheel).toHaveAttribute("aria-valuenow", "165");
    fireEvent.keyDown(wheel, { key: "Home" });
    expect(wheel).toHaveAttribute("aria-valuenow", "145");
    fireEvent.keyDown(wheel, { key: "End" });
    expect(wheel).toHaveAttribute("aria-valuenow", "185");
    fireEvent.keyDown(wheel, { key: "Delete" });
    expect(wheel).not.toHaveAttribute("aria-valuenow");
  });

  it("点击聚焦后鼠标滚轮才对选择生效，横向和缩放手势不选值", () => {
    const change = vi.fn();
    render(<ControlledWheel initial={165} onChange={change} />);
    const wheel = screen.getByRole("spinbutton");
    fireEvent.click(wheel);
    expect(wheel).toHaveFocus();
    fireEvent.wheel(wheel, { deltaY: 100 });
    expect(change).toHaveBeenLastCalledWith(166);
    fireEvent.wheel(wheel, { deltaY: -100 });
    expect(change).toHaveBeenLastCalledWith(165);
    fireEvent.wheel(wheel, { deltaY: 100, ctrlKey: true });
    fireEvent.wheel(wheel, { deltaY: 10, deltaX: 100 });
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("滚动经过未聚焦滚筒不改变身体值，也不阻止面板滚动", () => {
    const change = vi.fn();
    render(<ControlledWheel initial={165} onChange={change} />);
    const wheel = screen.getByRole("spinbutton");
    expect(wheel).not.toHaveFocus();
    const scrolling = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    fireEvent(wheel, scrolling);
    expect(scrolling.defaultPrevented).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(wheel).toHaveAttribute("aria-valuenow", "165");
    fireEvent.click(wheel);
    const selecting = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    fireEvent(wheel, selecting);
    expect(selecting.defaultPrevented).toBe(true);
    expect(change).toHaveBeenLastCalledWith(166);
    screen.getByRole("textbox").focus();
    const afterBlur = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    fireEvent(wheel, afterBlur);
    expect(afterBlur.defaultPrevented).toBe(false);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("直接输入不受快捷刻度限制，小数在显式确认时原样传入", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(<ControlledWheel label="体重" unit="kg" initialValue={55} onChange={change} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "250.75");
    expect(change).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(change).toHaveBeenLastCalledWith(250.75);
    expect(input).toHaveValue("250.75");
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "ArrowUp" });
    expect(change).toHaveBeenLastCalledWith(251.75);
  });

  it.each(["-3", "0", "NaN", "Infinity", "1e3", "165cm", "3.1.2"])("非法输入 %s 显示就近错误且不改变原值", raw => {
    const change = vi.fn();
    render(<ControlledWheel initial={165} onChange={change} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: raw } });
    expect(input).toBeInvalid();
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toHaveTextContent("有效身高");
    expect(input).toHaveValue(raw);
    expect(screen.getByRole("spinbutton")).toHaveAttribute("aria-valuenow", "165");
    expect(change).not.toHaveBeenCalled();
  });

  it("鞋码枚举校验与上下边界独立于现有M1仅38覆盖", () => {
    const change = vi.fn();
    render(<ControlledWheel label="鞋码" unit="中国码" initial={38} initialValue={38} options={[35, 36, 37, 38, 39, 40]} onChange={change} />);
    const wheel = screen.getByRole("spinbutton");
    fireEvent.keyDown(wheel, { key: "Home" });
    expect(change).toHaveBeenLastCalledWith(35);
    expect(screen.getByRole("button", { name: "减小鞋码" })).toBeDisabled();
    fireEvent.keyDown(wheel, { key: "PageUp" });
    expect(change).toHaveBeenLastCalledWith(40);
    expect(screen.getByRole("button", { name: "增大鞋码" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "41" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(screen.getByRole("alert")).toHaveTextContent("35、36、37、38、39、40 中国码");
    expect(change).toHaveBeenCalledTimes(2);
  });

  it("修正或清空非法编辑可恢复 native validity，外部刷新值不会保留旧输入", () => {
    const change = vi.fn();
    const view = render(<WheelPicker label="身高" unit="cm" value={165} onChange={change} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "no" } });
    fireEvent.blur(input);
    expect(input).toBeInvalid();
    fireEvent.click(screen.getByRole("button", { name: "清空或跳过身高" }));
    expect(input).toBeValid();
    view.rerender(<WheelPicker label="身高" unit="cm" value={170} onChange={change} />);
    expect(input).toHaveValue("170");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("禁用状态不接受鼠标、键盘或滚轮修改", () => {
    const change = vi.fn();
    render(<WheelPicker label="身高" unit="cm" value={165} onChange={change} disabled />);
    const wheel = screen.getByRole("spinbutton");
    expect(wheel).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.keyDown(wheel, { key: "ArrowUp" });
    fireEvent.wheel(wheel, { deltaY: 100 });
    fireEvent.click(screen.getByRole("button", { name: "增大身高" }));
    expect(change).not.toHaveBeenCalled();
  });

  it("调用方可按将来正式schema指定范围，但无效输入不静默截断到边界", () => {
    const change = vi.fn();
    render(<ControlledWheel initial={165} min={100} max={250} step={0.5} onChange={change} />);
    const wheel = screen.getByRole("spinbutton");
    fireEvent.keyDown(wheel, { key: "End" });
    expect(change).toHaveBeenLastCalledWith(250);
    expect(screen.getByRole("button", { name: "增大身高" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "251" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(screen.getByRole("alert")).toHaveTextContent("不能大于 250 cm");
    expect(change).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(wheel, { key: "Home" });
    expect(change).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(wheel, { key: "ArrowUp" });
    expect(change).toHaveBeenLastCalledWith(100.5);
  });

  it.each([
    ["身高", "cm", 100, 250, "99.5", "不能小于"],
    ["身高", "cm", 100, 250, "250.5", "不能大于"],
    ["身高", "cm", 100, 250, "165.3", "0.5 cm 的步长"],
    ["体重", "kg", 20, 300, "19.5", "不能小于"],
    ["体重", "kg", 20, 300, "300.5", "不能大于"],
    ["体重", "kg", 20, 300, "55.25", "0.5 kg 的步长"],
  ])("正式资料范围%s %s拒绝%s..%s外或不符步长输入%s", (label, unit, min, max, raw, error) => {
    const change = vi.fn();
    render(<ControlledWheel label={label} unit={unit} min={min} max={max} step={0.5} onChange={change} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: raw } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(screen.getByRole("alert")).toHaveTextContent(error);
    expect(change).not.toHaveBeenCalled();
  });
});

describe("尺码与预算控件", () => {
  it("上衣和下装独立选择，不从另一槽位推断；可单独清空", async () => {
    function Sizes() {
      const [top, setTop] = useState<string | null>(null);
      const [bottom, setBottom] = useState<string | null>(null);
      return <><SizeButtons label="上衣常穿尺码" value={top} onChange={setTop} /><SizeButtons label="下装常穿尺码" value={bottom} onChange={setBottom} /></>;
    }
    const user = userEvent.setup();
    render(<Sizes />);
    const top = within(screen.getByRole("group", { name: "上衣常穿尺码" }));
    const bottom = within(screen.getByRole("group", { name: "下装常穿尺码" }));
    await user.click(top.getByRole("button", { name: "S" }));
    expect(bottom.getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "false");
    await user.click(bottom.getByRole("button", { name: "M" }));
    expect(top.getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "true");
    expect(bottom.getByRole("button", { name: "M" })).toHaveAttribute("aria-pressed", "true");
    await user.click(top.getByRole("button", { name: "清空或跳过上衣常穿尺码" }));
    expect(top.getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "false");
    expect(bottom.getByRole("button", { name: "M" })).toHaveAttribute("aria-pressed", "true");
  });

  it("本次预算快捷金额明确是整套人民币，空值不默认提交500或800", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(<ControlledBudget onChange={change} />);
    expect(screen.getByRole("group")).toHaveAccessibleName("本次整套预算 人民币 / 元");
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(change).not.toHaveBeenCalled();
    for (const amount of [500, 800, 1000, 1500]) {
      await user.click(screen.getByRole("button", { name: `¥${amount}` }));
      expect(change).toHaveBeenLastCalledWith(amount * 100);
      expect(screen.getByRole("button", { name: `¥${amount}` })).toHaveAttribute("aria-pressed", "true");
    }
    expect(screen.getByText(/常用预算需要单独设置/)).toBeInTheDocument();
  });

  it.each([["0.29", 29], ["800.01", 80001], ["1234.5", 123450], ["737", 73700]])("预算 %s 按字符串精确转换为 %d 分", (raw, fen) => {
    const change = vi.fn();
    render(<ControlledBudget onChange={change} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: raw } });
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(change).toHaveBeenCalledExactlyOnceWith(fen);
  });

  it.each(["800.001", "-500", "0", "NaN", "1e4", "¥800", "9007199254740992"])("预算非法 %s 不截断、不四舍五入、不覆盖已确认预算", raw => {
    const change = vi.fn();
    render(<ControlledBudget initial={80000} onChange={change} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: raw } });
    expect(input).toBeInvalid();
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toHaveTextContent("最多两位小数");
    expect(screen.getByRole("button", { name: "¥800" })).toHaveAttribute("aria-pressed", "true");
    expect(change).not.toHaveBeenCalled();
  });

  it("预算失焦确认、空输入与清空按钮均保留明确空值", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(<ControlledBudget initial={80000} onChange={change} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "1000.25" } });
    fireEvent.blur(input);
    expect(change).toHaveBeenLastCalledWith(100025);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(change).toHaveBeenLastCalledWith(null);
    await user.click(screen.getByRole("button", { name: "¥500" }));
    await user.click(screen.getByRole("button", { name: "清空本次预算" }));
    expect(change).toHaveBeenLastCalledWith(null);
    expect(input).toHaveValue("");
  });

  it("全部控件只发受控回调，没有持久化、埋点或自动发送", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<><ControlledWheel /><ControlledBudget /><SizeButtons label="上衣" value={null} onChange={vi.fn()} /></>);
    await user.click(screen.getByRole("button", { name: "增大身高" }));
    await user.click(screen.getByRole("button", { name: "¥800" }));
    await user.click(screen.getByRole("button", { name: "S" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    fetch.mockRestore(); storage.mockRestore();
  });

  it("预算范围只在调用方明确传入时启用，超限提示保留原输入", () => {
    const change = vi.fn();
    render(<BudgetPicker value={80000} minFen={1} maxFen={100000} onChange={change} />);
    expect(screen.getByRole("button", { name: "¥1500" })).toBeDisabled();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "1000.01" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toHaveTextContent("不能高于 ¥1000.00");
    expect(input).toHaveValue("1000.01");
    expect(change).not.toHaveBeenCalled();
  });
});
