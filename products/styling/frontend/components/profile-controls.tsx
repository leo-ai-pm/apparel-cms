"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import styles from "./profile-controls.module.css";

export interface WheelPickerProps {
  label: string;
  unit: string;
  value: number | null;
  onChange: (value: number | null) => void;
  options?: number[];
  step?: number;
  initialValue?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}

function positiveNumber(raw: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function roundedStep(value: number, step: number, direction: number): number {
  // Decimal wheel steps should not expose floating point residue in the field.
  const decimalPlaces = (number: number) => {
    const [coefficient, exponent = "0"] = String(number).toLowerCase().split("e");
    return Math.max(0, (coefficient.split(".")[1]?.length ?? 0) - Number(exponent));
  };
  return Number((value + step * direction).toFixed(Math.min(100, Math.max(decimalPlaces(value), decimalPlaces(step)))));
}

export function WheelPicker({ label, unit, value, onChange, options, step, initialValue = 1, min, max, disabled = false }: WheelPickerProps) {
  const id = useId();
  const wheel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ original: number | null; text: string } | null>(null);
  const [error, setError] = useState("");
  const stepValue = typeof step === "number" && Number.isFinite(step) && step > 0 ? step : 1;
  const start = Number.isFinite(initialValue) && initialValue > 0 ? initialValue : 1;
  function inRange(candidate: number) { return Number.isFinite(candidate) && candidate > 0 && (min === undefined || candidate >= min) && (max === undefined || candidate <= max); }
  const choices = options?.filter((candidate, index, all) => inRange(candidate) && all.indexOf(candidate) === index).sort((a, b) => a - b);
  const center = value ?? (choices?.includes(start) ? start : choices?.[0]) ?? Math.max(min ?? Number.MIN_VALUE, Math.min(max ?? Infinity, start));
  const inputValue = editing?.original === value ? editing.text : value === null ? "" : String(value);
  const visibleError = editing?.original === value ? error : "";
  function inputError(raw: string) {
    if (raw.trim() === "") return "";
    const next = positiveNumber(raw);
    if (next === null) return `请输入大于 0 的有效${label}（${unit}）`;
    if (min !== undefined && next < min) return `${label}不能小于 ${min} ${unit}`;
    if (max !== undefined && next > max) return `${label}不能大于 ${max} ${unit}`;
    if (step !== undefined && Math.abs(next / stepValue - Math.round(next / stepValue)) > 1e-9) return `${label}请按 ${stepValue} ${unit} 的步长输入`;
    return choices && !choices.includes(next) ? `请选择 ${choices.join("、")} ${unit}` : "";
  }
  const validityMessage = editing?.original === value ? inputError(editing.text) : "";
  useEffect(() => { input.current?.setCustomValidity(validityMessage); }, [validityMessage]);

  function select(next: number | null) {
    setEditing(null);
    setError("");
    input.current?.setCustomValidity("");
    onChange(next);
  }

  function nextValue(direction: number): number | null {
    if (value === null) return inRange(center) && (!choices || choices.includes(center)) ? center : null;
    if (choices) {
      const index = choices.indexOf(value);
      if (index < 0) return direction > 0 ? choices.find(candidate => candidate > value) ?? null : choices.findLast(candidate => candidate < value) ?? null;
      const nextIndex = index + direction;
      return choices[Math.abs(direction) > 1 ? Math.max(0, Math.min(choices.length - 1, nextIndex)) : nextIndex] ?? null;
    }
    const next = roundedStep(value, stepValue, direction);
    return inRange(next) ? next : null;
  }

  function move(direction: number) {
    if (disabled) return;
    const next = nextValue(direction);
    if (next !== null) select(next);
  }

  // Scrolling past an unfocused picker must scroll the panel without changing a body value.
  const moveRef = useRef(move);
  useEffect(() => { moveRef.current = move; });
  useEffect(() => {
    const element = wheel.current;
    if (!element || disabled) return;
    let accumulated = 0;
    function onWheel(event: WheelEvent) {
      if (document.activeElement !== element) { accumulated = 0; return; }
      if (event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const amount = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 80 : 1);
      if (Math.sign(amount) !== Math.sign(accumulated)) accumulated = 0;
      accumulated += amount;
      if (Math.abs(accumulated) >= 32) {
        moveRef.current(accumulated > 0 ? 1 : -1);
        accumulated = 0;
      }
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [disabled]);

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : event.key === "PageUp" ? 5 : event.key === "PageDown" ? -5 : 0;
    if (direction) {
      event.preventDefault();
      move(direction);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = choices ? event.key === "Home" ? choices[0] : choices[choices.length - 1]
        : event.key === "Home" ? min ?? Math.max(stepValue, roundedStep(start, stepValue, -20)) : max ?? roundedStep(start, stepValue, 20);
      if (next !== undefined && inRange(next)) select(next);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      select(null);
    }
  }

  function commitInput() {
    if (disabled || !editing) return;
    if (inputValue.trim() === "") { select(null); return; }
    const invalid = inputError(inputValue);
    if (invalid) { input.current?.setCustomValidity(invalid); setError(invalid); return; }
    const next = positiveNumber(inputValue);
    select(next);
  }

  const rows = [-2, -1, 0, 1, 2].map(offset => {
    if (offset === 0 && value === null) return null;
    if (choices) {
      const index = choices.indexOf(center);
      return choices[index + offset] ?? null;
    }
    const candidate = roundedStep(center, stepValue, offset);
    return inRange(candidate) ? candidate : null;
  });

  return <fieldset className={styles.field} disabled={disabled}>
    <legend id={`${id}-label`}>{label} <span>{unit}</span></legend>
    <div className={styles.wheelLayout}>
      <div ref={wheel} className={styles.wheel} role="spinbutton" tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint${visibleError ? ` ${id}-error` : ""}`}
        aria-valuenow={value ?? undefined} aria-valuetext={value === null ? "未选择" : `${value} ${unit}`}
        aria-valuemin={choices?.[0] ?? min} aria-valuemax={choices?.[choices.length - 1] ?? max} aria-disabled={disabled} onKeyDown={keyboard}
        onClick={event => { if (!disabled) event.currentTarget.focus(); }}>
        <div aria-hidden="true" className={styles.wheelRows}>
          {rows.map((row, index) => <div key={index} className={index === 2 ? styles.selectedRow : styles.wheelRow}>
            {index === 2 && value === null ? <span className={styles.unselected}>未选择</span> : row ?? "—"}
            {index === 2 && row !== null && <small>{unit}</small>}
          </div>)}
        </div>
      </div>
      <div className={styles.wheelButtons}>
        <button type="button" aria-label={`增大${label}`} disabled={disabled || nextValue(1) === null} onClick={() => move(1)}>↑</button>
        <button type="button" aria-label={`减小${label}`} disabled={disabled || nextValue(-1) === null} onClick={() => move(-1)}>↓</button>
      </div>
    </div>
    <p id={`${id}-hint`} className={styles.hint}>点击滚筒后滚动，或用 ↑ ↓ 选择，也可直接输入。未选择时保持空白。</p>
    <div className={styles.inputRow}>
      <input ref={input} id={`${id}-input`} aria-label={`直接输入${label}（${unit}）`} type="text" inputMode="decimal"
        value={inputValue} placeholder={unit} aria-invalid={Boolean(visibleError)} aria-describedby={visibleError ? `${id}-error` : undefined}
        onChange={event => { setEditing({ original: value, text: event.target.value }); event.target.setCustomValidity(inputError(event.target.value)); setError(""); }} onBlur={commitInput}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitInput(); } }} />
      <button type="button" onClick={commitInput}>使用</button>
      <button type="button" className={styles.clearButton} onClick={() => select(null)} aria-label={`清空或跳过${label}`}>跳过 / 清空</button>
    </div>
    {visibleError && <p role="alert" id={`${id}-error`} className={styles.error}>{visibleError}</p>}
  </fieldset>;
}

export interface SizeButtonsProps {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  values?: string[];
  disabled?: boolean;
}

export function SizeButtons({ label, value, onChange, values = ["S", "M", "L", "XL"], disabled = false }: SizeButtonsProps) {
  return <fieldset className={styles.field} disabled={disabled}>
    <legend>{label}</legend>
    <div className={styles.sizeButtons}>
      {values.map(size => <button type="button" key={size} aria-pressed={value === size} onClick={() => onChange(size)}>{size}</button>)}
      <button type="button" className={styles.clearButton} aria-label={`清空或跳过${label}`} onClick={() => onChange(null)}>跳过 / 清空</button>
    </div>
  </fieldset>;
}

export interface BudgetPickerProps {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  minFen?: number;
  maxFen?: number;
}

function budgetText(fen: number | null): string {
  return fen === null ? "" : `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, "0")}`;
}

function parseBudget(raw: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  const fen = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(fen) && fen > 0 ? fen : null;
}

export function BudgetPicker({ value, onChange, disabled = false, minFen, maxFen }: BudgetPickerProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ original: number | null; text: string } | null>(null);
  const [error, setError] = useState("");
  const inputValue = editing?.original === value ? editing.text : budgetText(value);
  const visibleError = editing?.original === value ? error : "";
  function inputError(raw: string) {
    if (raw.trim() === "") return "";
    const fen = parseBudget(raw);
    if (fen === null) return "请输入可准确保存的大于 0 的人民币金额，最多两位小数";
    if (minFen !== undefined && fen < minFen) return `预算不能低于 ¥${budgetText(minFen)}`;
    if (maxFen !== undefined && fen > maxFen) return `预算不能高于 ¥${budgetText(maxFen)}`;
    return "";
  }
  const validityMessage = editing?.original === value ? inputError(editing.text) : "";
  useEffect(() => { input.current?.setCustomValidity(validityMessage); }, [validityMessage]);
  function select(next: number | null) { setEditing(null); setError(""); input.current?.setCustomValidity(""); onChange(next); }
  function commitInput() {
    if (disabled || !editing) return;
    const raw = inputValue.trim();
    if (raw === "") { select(null); return; }
    const invalid = inputError(raw);
    if (invalid) { input.current?.setCustomValidity(invalid); setError(invalid); return; }
    const fen = parseBudget(raw);
    select(fen);
  }
  return <fieldset className={styles.field} disabled={disabled}>
    <legend>本次整套预算 <span>人民币 / 元</span></legend>
    <div className={styles.budgetButtons}>
      {[500, 800, 1000, 1500].map(amount => <button key={amount} type="button" disabled={disabled || Boolean(inputError(String(amount)))} aria-pressed={value === amount * 100} onClick={() => select(amount * 100)}>¥{amount}</button>)}
    </div>
    <div className={styles.inputRow}>
      <label htmlFor={id} className={styles.inputLabel}>自定义</label>
      <input ref={input} id={id} type="text" inputMode="decimal" value={inputValue} aria-label="自定义整套预算（人民币元）" placeholder="例如 800.00"
        aria-invalid={Boolean(visibleError)} aria-describedby={visibleError ? `${id}-error` : undefined}
        onChange={event => { setEditing({ original: value, text: event.target.value }); event.target.setCustomValidity(inputError(event.target.value)); setError(""); }} onBlur={commitInput}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commitInput(); } }} />
      <button type="button" onClick={commitInput}>使用</button>
      <button type="button" className={styles.clearButton} aria-label="清空本次预算" onClick={() => select(null)}>清空</button>
    </div>
    {visibleError && <p role="alert" id={`${id}-error`} className={styles.error}>{visibleError}</p>}
    <p className={styles.hint}>调整只用于本次搭配；常用预算需要单独设置。</p>
  </fieldset>;
}
