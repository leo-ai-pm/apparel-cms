"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, SlidersHorizontal, X } from "lucide-react";
import { EMPTY_PROFILE_DRAFT, type ProfileDraft, type ProfileField } from "@/app/lib/profile-draft";
import { BudgetPicker, SizeButtons, WheelPicker } from "./profile-controls";
import { PROFILE_LIMITS, type ClothingProfileSize, type ProfileFields, type SavedConsumerProfile, type ShoeProfileSize } from "@/app/lib/consumer-profile";
import type { ConsumerProfileController } from "@/app/lib/use-consumer-profile";
import type { ProfilePanelEditing } from "@/app/lib/profile-edit-backup";
import styles from "./consumer-profile.module.css";

export { EMPTY_PROFILE_DRAFT };
export type { ProfileDraft, ProfileField };

export interface ProfilePanelProps {
  open: boolean;
  onClose: () => void;
  draft: ProfileDraft;
  onApply: (draft: ProfileDraft) => void;
  onClearLocal?: () => void;
  controller?: ConsumerProfileController;
  onCleared?: () => void;
  initialEditing?: ProfilePanelEditing | null;
  onEditingChange?: (value: ProfilePanelEditing | null) => void;
}

const SHOE_CHOICES = [35, 36, 37, 38, 39, 40];

export function savedProfileDraft(profile: SavedConsumerProfile | null): ProfileDraft {
  if (!profile || profile.status !== "saved") return { ...EMPTY_PROFILE_DRAFT };
  return {
    height_cm: profile.base_profile.height_cm,
    weight_kg: profile.base_profile.weight_kg,
    top: profile.base_profile.usual_sizes.top?.value ?? null,
    bottom: profile.base_profile.usual_sizes.bottom?.value ?? null,
    shoes: profile.base_profile.usual_sizes.shoes ? Number(profile.base_profile.usual_sizes.shoes.value) : null,
    budget_fen: profile.default_budget_fen,
  };
}

function mergeChoices(draft: ProfileDraft, saved: SavedConsumerProfile | null): ProfileDraft {
  const inherited = savedProfileDraft(saved);
  return Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value ?? inherited[key as keyof ProfileDraft]])) as ProfileDraft;
}

function CoverageNote({ top, bottom, shoes, budget_fen }: Partial<ProfileDraft>) {
  const missingSize = (top != null && top !== "M") || (bottom != null && bottom !== "M") || (shoes != null && shoes !== 38);
  const lowBudget = budget_fen != null && budget_fen < 73700;
  return <div className={styles.coverage} aria-live="polite">
    <strong>当前搭配覆盖</strong>
    <p>正式示例目前只有 4 套完整图，支持上衣 M、下装 M、鞋码 38，最低整套 ¥737。</p>
    {missingSize && <p className={styles.coverageWarning}>你选的尺码暂未完整覆盖。选择会原样保留，不会改成 M / M / 38。</p>}
    {lowBudget && <p className={styles.coverageWarning}>本次预算低于当前最低整套价格，暂时没有预算内完整搭配；不会替你提高预算。</p>}
    <p>可填写的资料范围与能生成的搭配范围不同；身高体重不用于推定确定尺码或合身效果。</p>
  </div>;
}

/** The edit form is mounted per opening, so dismissing never changes the caller's draft. */
export function ProfilePanel(props: ProfilePanelProps) {
  return props.open ? <ProfilePanelDialog {...props} /> : null;
}

function ProfilePanelDialog({ onClose, draft, onApply, onClearLocal, controller, onCleared, initialEditing, onEditingChange }: ProfilePanelProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const headingId = useId();
  const [editing, setEditing] = useState<ProfileDraft>(() => initialEditing ? { ...initialEditing.editing } : mergeChoices(draft, controller?.ready ? controller.profile : null));
  const [touched, setTouched] = useState<Set<keyof ProfileDraft>>(() => new Set(initialEditing?.touched ?? Object.entries(draft).filter(([, value]) => value !== null).map(([key]) => key as keyof ProfileDraft)));
  const touchedRef = useRef(touched);
  const touchRevision = useRef<Partial<Record<keyof ProfileDraft, number>>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmSavedClear, setConfirmSavedClear] = useState(false);
  const [confirmBudget, setConfirmBudget] = useState<"set" | "clear" | null>(null);
  const selectedCount = Object.values(editing).filter(value => value !== null).length;
  const saved = controller?.profile ?? null;
  const canWrite = Boolean(controller?.ready && !controller.busy);
  const baseTouched = [...touched].filter(field => field !== "budget_fen");

  useEffect(() => { touchedRef.current = touched; }, [touched]);
  useEffect(() => { onEditingChange?.(touched.size ? { editing: { ...editing }, touched: [...touched] } : null); }, [editing, touched, onEditingChange]);
  useEffect(() => {
    if (!saved || controller?.status !== "ready") return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const defaults = savedProfileDraft(saved);
      setEditing(current => Object.fromEntries(Object.entries(current).map(([field, value]) => [field, touchedRef.current.has(field as keyof ProfileDraft) ? value : defaults[field as keyof ProfileDraft]])) as ProfileDraft);
    });
    return () => { active = false; };
  }, [saved, controller?.status]);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { if (node?.open) node.close(); };
  }, []);

  function select<K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]) {
    touchRevision.current[field] = (touchRevision.current[field] ?? 0) + 1;
    touchedRef.current = new Set([...touchedRef.current, field]);
    setEditing(current => ({ ...current, [field]: value }));
    setTouched(current => new Set([...current, field]));
  }

  async function saveBase() {
    if (!controller || !canWrite || !form.current?.reportValidity() || !baseTouched.length) return;
    const sentRevisions = { ...touchRevision.current };
    const fields: ProfileFields = {};
    for (const field of baseTouched) {
      if (field === "height_cm" || field === "weight_kg") fields[field] = editing[field];
      else if (field === "top" || field === "bottom") {
        fields.usual_sizes ??= {};
        fields.usual_sizes[field] = editing[field] === null ? null : { system: "clothing_alpha", value: editing[field] as ClothingProfileSize["value"] };
      } else if (field === "shoes") {
        fields.usual_sizes ??= {};
        fields.usual_sizes.shoes = editing.shoes === null ? null : { system: "cn_shoe", value: String(editing.shoes) as ShoeProfileSize["value"] };
      }
    }
    if (await controller.mutate(saved?.status === "saved" ? "update" : "save", { base_profile: fields })) setTouched(current => new Set([...current].filter(field => field === "budget_fen" || !baseTouched.includes(field) || touchRevision.current[field] !== sentRevisions[field])));
  }

  async function saveBudget() {
    if (!controller || !canWrite || !confirmBudget || !form.current?.reportValidity()) return;
    const value = confirmBudget === "clear" ? null : editing.budget_fen;
    if (value === null && confirmBudget !== "clear") return;
    const beforeSave = touchRevision.current.budget_fen;
    if (await controller.mutate(saved?.status === "saved" ? "update" : "save", { default_budget_fen: value }, true)) {
      setConfirmBudget(null);
      if (touchRevision.current.budget_fen === beforeSave) setTouched(fields => new Set([...fields].filter(field => field !== "budget_fen")));
    }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={headingId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={form} className={styles.shell} onSubmit={event => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity()) return;
      onApply({ ...editing });
      onClose();
    }}>
      <header className={styles.header}>
        <div><span className={styles.eyebrow}>更懂你的日常</span><h2 id={headingId}>我的穿搭资料</h2></div>
        <button className={styles.close} type="button" aria-label="关闭我的穿搭资料" onClick={onClose}><X size={20} aria-hidden="true" /></button>
      </header>
      <div className={styles.body}>
        <div className={styles.introduction}>
          <span className={styles.unsaved}><span aria-hidden="true" />{controller ? "本次编辑，不自动保存" : "仅本次使用，未保存"}</span>
          <p>选你愿意提供的，其他可以留空。也可以关掉面板，直接告诉穿搭顾问。</p>
          {controller && <div className={styles.savedSummary}>
            <div><strong>已保存的资料</strong><button type="button" disabled={controller.busy || controller.status === "loading"} onClick={() => void controller.refresh()}>重新读取</button></div>
            {controller.status === "loading" ? <p role="status">正在读取当前资料与保存范围…输入仍可编辑。</p> : controller.status === "error" ? <p>资料尚未成功读取，不能把上次显示的值当作当前默认。你仍可仅本次填写。</p> : saved && <>
              <p>{saved.scope_kind === "device" ? "本设备的当前浏览器" : "当前用户资料"} · 版本 {saved.profile_version} · {({ empty: "尚未保存", saved: "已保存", cleared: "已清除", expired: "已到期" })[saved.status]}</p>
              <dl><dt>身高 / 体重</dt><dd>{saved.base_profile.height_cm ?? "未填"}{saved.base_profile.height_cm !== null ? " cm" : ""} / {saved.base_profile.weight_kg ?? "未填"}{saved.base_profile.weight_kg !== null ? " kg" : ""}</dd><dt>上衣 / 下装 / 鞋码</dt><dd>{saved.base_profile.usual_sizes.top?.value ?? "未填"} / {saved.base_profile.usual_sizes.bottom?.value ?? "未填"} / {saved.base_profile.usual_sizes.shoes?.value ?? "未填"}</dd><dt>常用预算</dt><dd>{saved.default_budget_fen === null ? "未设置" : `¥${saved.default_budget_fen / 100}`}</dd></dl>
              <p>{saved.storage_notice}</p>
              {saved.expires_at && <p>资料有效至 {new Date(saved.expires_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}。</p>}
              <button type="button" disabled={controller.busy} onClick={() => { setEditing(mergeChoices(draft, saved)); setTouched(new Set()); }}>将已保存资料放入本次编辑</button>
            </>}
            {controller.error && <p role="alert" className={styles.operationError}>{controller.error}</p>}
            {controller.notice && <p role="status">{controller.notice}</p>}
            {controller.pendingMutation && <div className={styles.pendingActions}><button type="button" disabled={controller.busy} onClick={() => void controller.retryMutation()}>{controller.canReplayPending ? "查询并按原编号重试资料操作" : "仅查询原资料操作"}</button><button type="button" disabled={controller.busy} onClick={controller.discardPendingMutation}>结束查询并重新编辑</button><p>结束查询不代表取消服务端操作；会重新读取当前资料，再由你确认下一次保存。</p></div>}
          </div>}
        </div>
        <section className={styles.section} aria-labelledby={`${headingId}-sizes`}>
          <div className={styles.sectionHeading}><h3 id={`${headingId}-sizes`}>常穿尺码</h3><span>各自选择，不推算</span></div>
          <SizeButtons label="上衣常穿尺码" value={editing.top} onChange={value => select("top", value)} />
          <SizeButtons label="下装常穿尺码" value={editing.bottom} onChange={value => select("bottom", value)} />
          <div className={styles.shoeRow}>
            <WheelPicker label="常穿鞋码" unit="中国码" options={SHOE_CHOICES} initialValue={38} value={editing.shoes} onChange={value => select("shoes", value)} />
            <p>使用中国鞋码。请按平时常穿的鞋码选择，搭配图不代表实际试穿。</p>
          </div>
        </section>
        <section className={styles.section} aria-labelledby={`${headingId}-body`}>
          <div className={styles.sectionHeading}><h3 id={`${headingId}-body`}>身高与体重</h3><span>可跳过</span></div>
          <div className={styles.measurements}>
            <WheelPicker label="身高" unit="cm" initialValue={165} min={PROFILE_LIMITS.height_cm.min} max={PROFILE_LIMITS.height_cm.max} step={PROFILE_LIMITS.height_cm.step} value={editing.height_cm} onChange={value => select("height_cm", value)} />
            <WheelPicker label="体重" unit="kg" initialValue={55} min={PROFILE_LIMITS.weight_kg.min} max={PROFILE_LIMITS.weight_kg.max} step={PROFILE_LIMITS.weight_kg.step} value={editing.weight_kg} onChange={value => select("weight_kg", value)} />
          </div>
        </section>
        <section className={`${styles.section} ${styles.budgetSection}`} aria-labelledby={`${headingId}-budget`}>
          <div className={styles.sectionHeading}><h3 id={`${headingId}-budget`}>这一次怎么搭</h3><span>本次条件</span></div>
          <BudgetPicker value={editing.budget_fen} minFen={PROFILE_LIMITS.budget_fen.min} maxFen={PROFILE_LIMITS.budget_fen.max} onChange={value => select("budget_fen", value)} />
          <div className={styles.defaultBudget}><div><strong>常用预算</strong><p>只有主动设置，才作为以后新对话的默认值。</p></div><button type="button" disabled={!canWrite || editing.budget_fen === null} onClick={() => setConfirmBudget("set")}>设为常用预算</button></div>
          {!controller ? <p className={styles.serviceNote}>资料服务尚未开放，常用预算暂不能保存。</p> : <>
            {saved?.default_budget_fen !== null && saved?.default_budget_fen !== undefined && <button type="button" className={styles.textButton} disabled={!canWrite} onClick={() => setConfirmBudget("clear")}>清除常用预算</button>}
            {confirmBudget && <div className={styles.clearConfirm}><p>{confirmBudget === "clear" ? "只清除已保存的常用预算；本次明确选择的预算保持不变。" : `将 ¥${(editing.budget_fen ?? 0) / 100} 设为新对话的常用整套预算，不自动改变已受理请求。`}</p><button type="button" disabled={!canWrite} onClick={() => void saveBudget()}>{confirmBudget === "clear" ? "确认清除常用预算" : "确认设为常用预算"}</button><button type="button" onClick={() => setConfirmBudget(null)}>取消预算设置</button></div>}
          </>}
        </section>
        <CoverageNote {...editing} />
        <section className={`${styles.section} ${styles.persistence}`} aria-labelledby={`${headingId}-saved`}>
          <div className={styles.sectionHeading}><h3 id={`${headingId}-saved`}>保存与复用</h3><span>{controller ? "需要你明确确认" : "尚未开放"}</span></div>
          {!controller ? <><p>资料服务尚未开放。本页选择不会保存到浏览器或账户；刷新、关闭页面后需要重新选择。</p><div className={styles.mutedActions}><button type="button" disabled>保存我的资料</button><button type="button" disabled>更新我的资料</button><button type="button" disabled>清除已保存资料</button></div></> : <>
            <p>只保存你本次明确调整的基础资料；未调整的字段保持原值。点“跳过 / 清空”后保存会删除该字段。保存不发送搭配请求，本次草稿保持不变。</p>
            <div className={styles.mutedActions}><button type="button" disabled={!canWrite || !baseTouched.length} onClick={() => void saveBase()}>{controller.busy ? "正在确认资料操作…" : saved?.status === "saved" ? "更新我的资料" : "保存我的资料"}</button><button type="button" disabled={!canWrite || saved?.status !== "saved"} onClick={() => setConfirmSavedClear(true)}>清除已保存资料</button></div>
            {confirmSavedClear && <div className={styles.clearConfirm}><p>将清除已保存的基础资料与常用预算，并使未受理的旧准备失效。历史搭配、已受理请求和当前浏览器身份保留。前端未发送的资料选择也会清空。</p><button type="button" disabled={!canWrite} onClick={async () => {
              const beforeClear = { ...touchRevision.current };
              if (await controller.mutate("clear", {})) {
                setEditing(values => Object.fromEntries(Object.entries(values).map(([field, value]) => [field, touchRevision.current[field as keyof ProfileDraft] !== beforeClear[field as keyof ProfileDraft] ? value : null])) as ProfileDraft);
                setTouched(fields => new Set([...fields].filter(field => touchRevision.current[field] !== beforeClear[field])));
                setConfirmSavedClear(false); onCleared?.();
              }
            }}>确认清除已保存资料</button><button type="button" onClick={() => setConfirmSavedClear(false)}>保留已保存资料</button></div>}
          </>}
          <details className={styles.scope}>
            <summary>保存范围与共享设备</summary>
            <p>{controller && saved ? saved.scope_kind === "device" ? "当前范围为本设备、同一浏览器与同一站点的资料空间；不识别自然人身份。" : "当前范围为服务端确认的用户资料；不自动合并其他账户或匿名资料。" : "未来保存范围为同一浏览器、同一站点及合法授权空间；实际归属以资料服务返回为准，当前尚未确认身份或保存范围。"}</p>
            <p>清除 Cookie / 站点数据、隐私窗口、换浏览器或设备后，匿名资料可能无法恢复，不默认跨设备同步。</p>
            <p>清除已保存资料不会删除历史搭配或已受理请求，也不会自动取消正在处理的请求。</p>
            <p>{controller ? "多人共用设备时，本页不能识别是否换了使用者。可仅本次使用，或明确清除已保存资料与未发送选择。清除资料仍保留此浏览器身份，不代表退出或换人。" : "多人共用设备时，本页不能识别是否换了使用者。换人使用前请清除已保存资料（暂未开放）；当前只能清空未发送的选择。"}</p>
          </details>
          {onClearLocal && <div className={styles.clearArea}>
            {confirmClear ? <div className={styles.clearConfirm}>
              <p>只清空本次未发送的选择，不清除服务端资料、历史或已受理请求。</p>
              <button type="button" onClick={() => { onClearLocal(); onClose(); }}>确认清空本次选择</button>
              <button type="button" onClick={() => setConfirmClear(false)}>保留选择</button>
            </div> : <button className={styles.textButton} type="button" onClick={() => setConfirmClear(true)}>清空本次选择</button>}
          </div>}
        </section>
      </div>
      <footer className={styles.footer}>
        <div className={styles.footerHint}><Check size={14} aria-hidden="true" /><span>{selectedCount > 0 ? `已选择 ${selectedCount} 项` : "全部可留空"} · 填入后仍可修改，不自动发送</span></div>
        <div className={styles.footerActions}><button type="button" onClick={onClose}>取消</button><button className={styles.primary} type="submit">填入本次草稿<ArrowUpRight size={17} aria-hidden="true" /></button></div>
      </footer>
    </form>
  </dialog>;
}

export interface ProfileSupplementCardProps {
  field: ProfileField;
  value: string | number | null;
  onChange: (value: string | number | null) => void;
  onOpenProfile: () => void;
  onDismiss: () => void;
}

/** Rendered only for a field explicitly requested by the server or chosen by the user. */
export function ProfileSupplementCard({ field, value, onChange, onOpenProfile, onDismiss }: ProfileSupplementCardProps) {
  const title = field === "top" ? "补充上衣尺码" : field === "bottom" ? "补充下装尺码" : field === "shoes" ? "补充常穿鞋码" : "补充本次预算";
  const titleId = useId();
  const [editing, setEditing] = useState<string | number | null>(value);
  const size = typeof editing === "string" ? editing : null;
  const number = typeof editing === "number" ? editing : null;
  const selected: Partial<ProfileDraft> = field === "top" || field === "bottom" ? { [field]: size } : { [field]: number };

  return <form className={styles.supplement} aria-labelledby={titleId} onSubmit={event => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    onChange(editing);
  }}>
    <div className={styles.supplementHeading}><div><span>只补这一项</span><h3 id={titleId}>{title}</h3></div><button type="button" className={styles.close} aria-label={`关闭${title}`} onClick={onDismiss}><X size={17} aria-hidden="true" /></button></div>
    {(field === "top" || field === "bottom") && <SizeButtons label={field === "top" ? "上衣常穿尺码" : "下装常穿尺码"} value={size} onChange={setEditing} />}
    {field === "shoes" && <WheelPicker label="常穿鞋码" unit="中国码" options={SHOE_CHOICES} initialValue={38} value={number} onChange={setEditing} />}
    {field === "budget_fen" && <BudgetPicker value={number} minFen={PROFILE_LIMITS.budget_fen.min} maxFen={PROFILE_LIMITS.budget_fen.max} onChange={setEditing} />}
    <CoverageNote {...selected} />
    <p className={styles.supplementHint}>只填入本次草稿，不保存、不发送；其他场景和需求继续保留。</p>
    <div className={styles.supplementActions}><button className={styles.textButton} type="button" onClick={onOpenProfile}><SlidersHorizontal size={14} aria-hidden="true" />我的穿搭资料</button><button type="submit" className={styles.primary}>填入本次草稿</button></div>
  </form>;
}
