"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BarChart3, Database, FileCheck2, ImageIcon, LogOut, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";
import { appPath } from "../lib/app-path";
import { adminApi, adminExport, adminQuery, AdminError, formatAdminTime as time, windowQuery } from "../lib/admin-api";
import type { Overview, Group, Turn, TurnDetail, Handoff, HandoffDetail, PageResult, DemandAttributes } from "../lib/admin-api";
import AdminContextBoundary, { type AdminContextAccess } from "./AdminContextBoundary";
import { useAdminAction } from "./use-admin-action";
import { AdminActionStatus, AdminOperationRecovery } from "./AdminActionStatus";
import DemandReview from "./DemandReview";
import FrozenSources from "./FrozenSources";
import DirectDelivery, { adminDirectSession, forgetAdminDirectSession } from "./DirectDelivery";
import s from "./admin.module.css";
import { DemoAccessBoundary } from "@/components/demo-access-boundary";

type Tab = "heat" | "turns" | "handoffs" | "images" | "storage";
type Modal = { kind: "group" | "turn" | "handoff"; id: string; title: string };
type QueryWindow = { window_start: string | null; window_end: string };
type Review = { target: Modal; serial: number; days: 0 | 7; bounds: QueryWindow };
const labels: Record<string, string> = { approved: "已批准", sending: "发送中", received: "已接收", failed: "失败", unconfirmed: "接收待确认", succeeded: "成功", processing: "生成中", pending: "待审核", rejected: "已排除", active: "有效", excluded: "已排除", retracted: "已撤回", extracted: "已提炼", no_explicit_demand: "无明确需求", negative_preference: "否定偏好", needs_review: "待复核", extraction_failed: "提炼失败", extracting: "正在提炼" };
const fields: Record<string, string> = { season: "季节", scene: "场景", category: "品类", fit: "松紧", silhouette: "廓形" };
const reasons: Record<string, string> = { evidence_missing: "来源证据缺失", evidence_inactive: "证据已排除或撤回", evidence_revision_changed: "证据修订已变化", snapshot_content_changed: "快照内容校验不一致", receiver_timeout: "接收方超时，尚未确认接收", receiver_http_error: "接收接口返回错误", receiver_network_error: "无法连接接收方", receipt_mismatch: "回执编号或状态不匹配", receipt_revision_mismatch: "回执版本不匹配", receipt_digest_mismatch: "回执内容摘要不匹配", send_interrupted: "发送中断，需查询原交接后再决定重试" };
const stateLabel = (value: string) => labels[value] ?? `未知状态（${value}）`;
const origin = (value: string) => value === "simulation_fixture" ? "合成演示样本" : value === "mixed_demo" ? "混合演示来源" : "实际程序交流 · 模拟业务";
const errorText = (e: unknown) => e instanceof Error ? e.message : "请求失败，请重试";
const nav = [{ id: "heat", title: "需求热度", short: "热度", icon: BarChart3 }, { id: "turns", title: "交流记录", short: "交流", icon: MessageSquare }, { id: "handoffs", title: "审批与交接", short: "交接", icon: FileCheck2 }, { id: "images", title: "图片记录", short: "图片", icon: ImageIcon }, { id: "storage", title: "数据存储", short: "存储", icon: Database }] as const;

function Pager({ page, total, size = 10, busy, onChange, label = "列表分页" }: { page: number; total: number; size?: number; busy: boolean; onChange: (page: number) => void; label?: string }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return <nav className={s.pager} aria-label={label}><span>共 {total} 条 · 第 {page} / {pages} 页</span><button disabled={busy || page <= 1} onClick={() => onChange(page - 1)}>上一页</button><button disabled={busy || page >= pages} onClick={() => onChange(page + 1)}>下一页</button></nav>;
}
function Attributes({ values }: { values: DemandAttributes }) {
  return <dl className={s.attributes}>{Object.entries(fields).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{values[key as keyof DemandAttributes] || "未明确"}</dd></div>)}</dl>;
}
function WindowInfo({ start, end, days }: { start: string | null; end: string | null; days?: 0 | 7 }) {
  return <p className={s.window}>查询窗口（北京时间）：{start ? time(start) : "最早记录"} ≤ 交流时间 &lt; {end ? time(end) : "未记录"}。{days === 7 ? "滚动7天（168小时），固定截止" : days === 0 ? "累计记录，固定截止" : "批准当时保存的精确区间"}；UTC[start,end)，含起点、不含截止。</p>;
}

export default function AdminPage() {
  if (process.env.NEXT_PUBLIC_DEMO_ACCESS_SUPPORTED === "1") return <div className={s.adminBoundary}><DemoAccessBoundary role="styling-manager"><AdminContextBoundary workspace={AdminWorkspace} /></DemoAccessBoundary></div>;
  return <div className={s.adminBoundary}>{process.env.NEXT_PUBLIC_ADMIN_CONTEXT_REQUIRED === "1"
    ? <AdminContextBoundary workspace={AdminWorkspace} />
    : <AdminWorkspace />}</div>;
}

function AdminWorkspace({ adminAccess }: { adminAccess?: AdminContextAccess }) {
  const read = useCallback(<T,>(path: string) => adminAccess ? adminAccess.read<T>(path) : adminApi<T>(path), [adminAccess]);
  const logoutAction = useAdminAction({ access: adminAccess ?? null, slot: "logout" });
  const retryAction = useAdminAction({ access: adminAccess ?? null, slot: "turn-retry" });
  const [retryConfirm, setRetryConfirm] = useState<{ id: string; checked: boolean } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const restoreDialogFocus = useRef(false);
  const reviewOpener = useRef<HTMLElement | null>(null);
  const reviewScroll = useRef(0);
  const restoreReviewFocus = useRef(false);
  const frozenOpener = useRef<HTMLElement | null>(null);
  const frozenScroll = useRef(0);
  const restoreFrozenFocus = useRef(false);
  const overviewSeq = useRef(0), listSeq = useRef(0), detailSeq = useRef(0);
  const windowRef = useRef<QueryWindow | null>(null);
  const reviewSerial = useRef(0);
  const [windowEpoch, setWindowEpoch] = useState(0);
  const [rangeRevision, setRangeRevision] = useState(0);
  const [data, setData] = useState<Overview | null>(null);
  const [password, setPassword] = useState("");
  const [auth, setAuth] = useState<"checking" | "login" | "ready" | "unavailable">("checking");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState<0 | 7>(7);
  const [tab, setTab] = useState<Tab>("heat");
  const [category, setCategory] = useState(""), [reviewState, setReviewState] = useState("");
  const [turnState, setTurnState] = useState(""), [session, setSession] = useState("");
  const [sessionDraft, setSessionDraft] = useState("");
  const [handoffState, setHandoffState] = useState("");
  const [heatPage, setHeatPage] = useState(1), [turnPage, setTurnPage] = useState(1), [handoffPage, setHandoffPage] = useState(1);
  const [turns, setTurns] = useState<PageResult<Turn> | null>(null);
  const [handoffs, setHandoffs] = useState<PageResult<Handoff> | null>(null);
  const [listLoading, setListLoading] = useState(false), [listError, setListError] = useState("");
  const [modal, setModal] = useState<Modal | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [sourceTurns, setSourceTurns] = useState<Record<string, TurnDetail>>({});
  const [turn, setTurn] = useState<TurnDetail | null>(null);
  const [handoff, setHandoff] = useState<HandoffDetail | null>(null);
  const [frozenReturn, setFrozenReturn] = useState<{ target: Modal; detail: HandoffDetail } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);
  const [directSession, setDirectSession] = useState("");

  const handleError = useCallback((e: unknown) => {
    adminAccess?.onError(e);
    if (e instanceof AdminError && e.status === 401) {
      forgetAdminDirectSession(); setDirectSession("");
      overviewSeq.current++; listSeq.current++; detailSeq.current++;
      dialogOpener.current = null; restoreDialogFocus.current = false;
      windowRef.current = null;
      setData(null); setTurns(null); setHandoffs(null); setModal(null); setReview(null); setSourceTurns({}); setTurn(null); setHandoff(null); setFrozenReturn(null); setAuth("login");
      setError("管理身份已失效，请重新登录。");
    }
  }, [adminAccess, setModal, setFrozenReturn, setSourceTurns]);
  const load = useCallback(async () => {
    const id = ++overviewSeq.current;
    setRefreshing(true);
    try {
      const result = await read<Overview>(`overview${adminQuery({ days, category, status: reviewState, page: heatPage, page_size: 20, ...(windowRef.current ? windowQuery(windowRef.current) : {}) })}`);
      if (id !== overviewSeq.current) return;
      if (!Number.isInteger(result.groups_total) || result.groups_total < 0 || !Number.isInteger(result.page) || result.page !== heatPage || result.page_size !== 20 || !result.window_end) throw new AdminError(200, "INVALID_RESPONSE", "热度分页不符合新契约，请联系后端核对。");
      if (windowRef.current && (result.window_start !== windowRef.current.window_start || result.window_end !== windowRef.current.window_end)) throw new AdminError(200, "INVALID_RESPONSE", "查询窗口意外改变，请重新获取范围并核对。");
      if (!windowRef.current) { windowRef.current = { window_start: result.window_start, window_end: result.window_end }; setWindowEpoch(v => v + 1); }
      setData(result); setHeatPage(p => Math.min(p, Math.max(1, Math.ceil(result.groups_total / result.page_size)))); setDirectSession(adminAccess?.namespace ?? adminDirectSession()); setAuth("ready"); setError("");
    } catch (e) {
      if (id !== overviewSeq.current) return;
      if (e instanceof AdminError && e.status === 401) { if (data) handleError(e); else { forgetAdminDirectSession(); setDirectSession(""); setAuth("login"); setError(""); } }
      else { setError(errorText(e)); if (!data) setAuth("unavailable"); }
    } finally { if (id === overviewSeq.current) setRefreshing(false); }
  }, [days, category, reviewState, heatPage, data, handleError, read, adminAccess]);
  // A data update must not trigger another overview request.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    const sequence = overviewSeq;
    const initial = setTimeout(() => { void loadRef.current(); }, 0);
    return () => { clearTimeout(initial); sequence.current++; };
  }, [days, category, reviewState, heatPage, rangeRevision]);

  const loadList = useCallback(async () => {
    if (tab !== "turns" && tab !== "handoffs") return;
    if (tab === "turns" && !windowRef.current) return;
    const id = ++listSeq.current;
    setListLoading(true); setListError("");
    try {
      if (tab === "turns") {
        const result = await read<PageResult<Turn>>(`turns${adminQuery({ days, ...windowQuery(windowRef.current!), status: turnState, session_id: session, page: turnPage, page_size: 10 })}`);
        if (id === listSeq.current) setTurns(result);
      } else {
        const result = await read<PageResult<Handoff>>(`handoffs${adminQuery({ status: handoffState, page: handoffPage, page_size: 10 })}`);
        if (id === listSeq.current) setHandoffs(result);
      }
    } catch (e) { if (id === listSeq.current) { setListError(errorText(e)); handleError(e); } }
    finally { if (id === listSeq.current) setListLoading(false); }
  }, [tab, days, turnState, session, turnPage, handoffState, handoffPage, handleError, read]);
  useEffect(() => {
    if (auth !== "ready") return;
    const sequence = listSeq;
    const initial = setTimeout(() => { void loadList(); }, 0);
    return () => { clearTimeout(initial); sequence.current++; };
  }, [auth, loadList, windowEpoch]);

  const fetchDetail = useCallback(async (target: Modal, quiet = false) => {
    if (target.kind === "group") return;
    const id = ++detailSeq.current;
    if (!quiet) { setDetailLoading(true); setDetailError(""); }
    try {
      if (target.kind === "turn") {
        const result = await read<TurnDetail>(`turns/${encodeURIComponent(target.id)}`);
        // Resolve referenced source turns as real details too. Their revision
        // and lifecycle are shown and rechecked before approving reviewed text.
        const sourceIds = [...new Set(result.occurrences.flatMap(o => [...o.context_turn_ids, ...Object.values(o.field_sources).flat()]).filter(sourceId => sourceId !== result.id))];
        const contexts = await Promise.all(sourceIds.map(sourceId => read<TurnDetail>(`turns/${encodeURIComponent(sourceId)}`)));
        if (id === detailSeq.current) { setTurn(result); setSourceTurns(old => ({ ...old, [result.id]: result, ...Object.fromEntries(contexts.map(t => [t.id, t])) })); }
      } else {
        const result = await read<HandoffDetail>(`handoffs/${encodeURIComponent(target.id)}`);
        if (id === detailSeq.current) setHandoff(result);
      }
    } catch (e) { if (id === detailSeq.current) { setDetailError(errorText(e)); handleError(e); } }
    finally { if (!quiet && id === detailSeq.current) setDetailLoading(false); }
  }, [handleError, read, setDetailLoading, setDetailError, setSourceTurns]);
  function open(target: Modal, opener: HTMLElement) {
    setRetryConfirm(null);
    detailSeq.current++; setDetailLoading(false); setDetailError("");
    setFrozenReturn(null);
    if (!modal) dialogOpener.current = opener;
    restoreDialogFocus.current = false;
    if (target.kind === "group") {
      if (modal && review?.target.id === target.id) { restoreReviewFocus.current = true; setModal(review.target); return; }
      if (!windowRef.current) return;
      reviewOpener.current = null; restoreReviewFocus.current = false;
      setReview({ target, serial: ++reviewSerial.current, days, bounds: { ...windowRef.current } }); setSourceTurns({});
    } else if (modal?.kind === "group" && review) {
      reviewOpener.current = opener;
      reviewScroll.current = dialogRef.current?.querySelector<HTMLElement>(`section.${s.drawer}`)?.scrollTop ?? 0;
    }
    setTurn(null); setHandoff(null); setDetailError(""); setDetailLoading(false); setMessage(""); setConfirmSend(false); setModal(target); void fetchDetail(target);
  }
  function openCurrentSource(id: string, opener: HTMLElement) {
    if (modal?.kind !== "handoff" || !handoff) return;
    const saved = { target: modal, detail: handoff };
    frozenOpener.current = opener;
    frozenScroll.current = dialogRef.current?.querySelector<HTMLElement>(`section.${s.drawer}`)?.scrollTop ?? 0;
    open({ kind: "turn", id, title: "当前出处" }, opener);
    setFrozenReturn(saved);
  }
  function returnToFrozen() {
    if (!frozenReturn || busy) return;
    detailSeq.current++; setDetailLoading(false); setDetailError(""); setMessage("");
    setTurn(null); setHandoff(frozenReturn.detail); setModal(frozenReturn.target); setFrozenReturn(null);
    restoreFrozenFocus.current = true;
  }
  function close() { if (busy) return; detailSeq.current++; restoreDialogFocus.current = true; setModal(null); setReview(null); setSourceTurns({}); setFrozenReturn(null); setDetailLoading(false); setDetailError(""); setMessage(""); }
  function resetRange() {
    overviewSeq.current++; listSeq.current++;
    windowRef.current = null; setRefreshing(true); setHeatPage(1); setTurnPage(1); setTurns(null); close();
    setRangeRevision(v => v + 1);
  }
  useEffect(() => {
    if (modal && !dialogRef.current?.open) dialogRef.current?.showModal();
    else if (!modal && restoreDialogFocus.current) {
      restoreDialogFocus.current = false;
      if (dialogOpener.current?.isConnected) dialogOpener.current.focus({ preventScroll: true });
      dialogOpener.current = null;
    }
    if (modal?.kind === "group" && restoreReviewFocus.current) {
      restoreReviewFocus.current = false;
      const drawer = dialogRef.current?.querySelector<HTMLElement>(`section.${s.drawer}`);
      if (drawer) drawer.scrollTop = reviewScroll.current;
      if (reviewOpener.current?.isConnected) reviewOpener.current.focus({ preventScroll: true });
    }
    if (modal?.kind === "handoff" && restoreFrozenFocus.current) {
      restoreFrozenFocus.current = false;
      const drawer = dialogRef.current?.querySelector<HTMLElement>(`section.${s.drawer}`);
      if (drawer) drawer.scrollTop = frozenScroll.current;
      const oldOpener = frozenOpener.current;
      const opener = oldOpener?.isConnected ? oldOpener : Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button[data-current-source]") ?? []).find(button => button.dataset.currentSource === oldOpener?.dataset.currentSource);
      opener?.focus({ preventScroll: true });
    }
  }, [modal]);
  useEffect(() => {
    if (auth !== "ready") return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || busy) return;
      void loadRef.current(); void loadList();
      // Keep group evidence frozen while the manager reviews it; handoff status can refresh.
      if (modal?.kind === "handoff") void fetchDetail(modal);
    }, 30000);
    return () => clearInterval(timer);
  }, [auth, busy, loadList, modal, fetchDetail]);

  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await adminApi("login", { password }); setDirectSession(adminDirectSession(true)); setPassword(""); await loadRef.current(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function logout() {
    if (adminAccess) {
      setBusy(true);
      try { await logoutAction.execute("logout"); } catch (reason) { setError(errorText(reason)); handleError(reason); } finally { setBusy(false); }
      return;
    }
    setBusy(true);
    try { await adminApi("logout", {}); forgetAdminDirectSession(); setDirectSession(""); overviewSeq.current++; listSeq.current++; detailSeq.current++; dialogOpener.current = null; restoreDialogFocus.current = false; windowRef.current = null; setData(null); setModal(null); setReview(null); setSourceTurns({}); setTurns(null); setHandoffs(null); setTurn(null); setHandoff(null); setFrozenReturn(null); setHeatPage(1); setAuth("login"); setError(""); }
    catch (e) { setError(errorText(e)); handleError(e); }
    finally { setBusy(false); }
  }
  async function mutate(path: string, body: unknown, success: string) {
    if (adminAccess) return;
    setBusy(true); setDetailError(""); setMessage(""); setConfirmSend(false);
    const sendTimer = path.endsWith("/send") && modal?.kind === "handoff" ? setInterval(() => { void fetchDetail(modal, true); }, 750) : undefined;
    try { await adminApi(path, body); clearInterval(sendTimer); setMessage(success); await loadRef.current(); await loadList(); if (modal) await fetchDetail(modal); }
    catch (e) {
      clearInterval(sendTimer); handleError(e);
      // Always query the original object after a conflict or send failure. Never resend automatically.
      if (modal && !(e instanceof AdminError && e.status === 401)) await fetchDetail(modal);
      setDetailError(errorText(e) + (e instanceof AdminError && e.status === 409 ? " 已重载证据，请再次核对后操作；说明已保留。" : ""));
    } finally { clearInterval(sendTimer); setBusy(false); }
  }
  async function download(id: string) {
    setBusy(true); setDetailError(""); setMessage("");
    try {
      if (adminAccess) await adminAccess.validate();
      const result = await adminExport(id);
      if (adminAccess) await adminAccess.validate();
      const url = URL.createObjectURL(result.blob), link = document.createElement("a");
      link.href = url; link.download = result.fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("交接包已下载；导出不代表发送或接收。");
      if (modal) await fetchDetail(modal);
    } catch (e) { setDetailError(errorText(e)); handleError(e); }
    finally { setBusy(false); }
  }
  async function prepareRetry() {
    if (!adminAccess || !modal || modal.kind !== "turn") return;
    setBusy(true); setRetryConfirm(null); setDetailError("");
    try {
      await adminAccess.validate();
      const current = await read<TurnDetail>(`turns/${encodeURIComponent(modal.id)}`);
      setTurn(current);
      if (current.status !== "extraction_failed" || current.occurrences.length !== 0) { setDetailError("当前交流不属于无关联需求的提炼失败，不能重新提炼。"); return; }
      if (!retryAction.archive()) return;
      setRetryConfirm({ id: current.id, checked: false });
    } catch (reason) { setDetailError(errorText(reason)); handleError(reason); }
    finally { setBusy(false); }
  }
  async function retryExtraction() {
    if (!adminAccess || !retryConfirm?.checked || !turn || turn.status !== "extraction_failed" || turn.occurrences.length !== 0 || retryConfirm.id !== turn.id || !modal) return;
    setBusy(true); setRetryConfirm(null); setDetailError("");
    try { await retryAction.execute(`turns/${encodeURIComponent(turn.id)}/retry`); await fetchDetail(modal); setMessage("原提炼操作已处理，请按当前交流状态核对；不代表新增审批。"); }
    catch (reason) { setDetailError(errorText(reason)); handleError(reason); }
    finally { setBusy(false); }
  }
  function changeTab(value: Tab) { listSeq.current++; setTab(value); setListError(""); }

  if (auth !== "ready" || !data) return <main className={s.login}><div className={s.loginCard}><span className={s.brand}><ShieldCheck size={22} /> STYLING / ADMIN</span><h1>穿搭需求管理台</h1><p>核对消费者表达，批准需求快照，追溯每次交接。</p><small>当前访问环境：{process.env.NEXT_PUBLIC_S1_FIXTURE === "1" ? "本地隔离模拟" : "授权服务"} · PRD v1.6 / S1</small>{auth === "login" ? <form onSubmit={login}><label htmlFor="admin-password">管理员密码</label><input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={256} /><button disabled={busy}>{busy ? "正在登录…" : "进入管理后台"}<ArrowUpRight size={17} /></button></form> : auth === "checking" ? <p role="status">正在验证管理权限…</p> : <><p>后台暂时无法访问。请核对本地服务或管理员配置。</p><button disabled={refreshing} onClick={() => void loadRef.current()}>重新检查</button></>}{error && <p className={s.error} role="alert">{error}</p>}<a href={appPath("/")}>返回消费者窗口 ↗</a><small>仅向已授权的产品管理者开放</small></div></main>;

  const displayedGroups = data.groups;
  const pageTitle = nav.find(n => n.id === tab)?.title;
  function renderHandoff(h: Handoff) {
    return <article className={s.handoff} key={h.id}><p>{h.title || "历史标题未记录"}</p><strong>v{h.version} · {h.occurrences} 条证据 · {stateLabel(h.status)}</strong><small>{h.id}</small><small>需求组 {h.group_key || "历史组标识未记录"}</small><small>批准时间 {time(h.created_at)} · {h.metadata?.approved_by || "历史未记录批准人"}</small>{h.needs_review && <p className={s.error}>当前待复核：{h.review_reasons.map(r => reasons[r] || r).join("、")}。历史接收事实保留。</p>}{h.last_error && <p className={s.error}>{h.last_error}</p>}<button className={s.textButton} disabled={busy} onClick={event => open({ kind: "handoff", id: h.id, title: `交接快照 v${h.version}` }, event.currentTarget)}>查看冻结快照与交接记录 ↗</button></article>;
  }

  return <div className={s.app}>
    <aside className={s.sidebar} aria-label="穿搭管理导航"><div className={s.railBrand} title="个性化穿搭 Agent" aria-label="个性化穿搭 Agent">穿</div><nav aria-label="后台栏目">{nav.map(({ id, title, short, icon: Icon }) => <button key={id} title={title} aria-label={title} aria-current={tab === id ? "page" : undefined} className={tab === id ? s.active : ""} onClick={() => changeTab(id)}><Icon size={20} aria-hidden="true" /><span>{short}</span></button>)}</nav><div className={s.sideBottom}><a href={appPath("/")} target="_blank" rel="noopener noreferrer" title="在新标签页试验，完成后切回本后台" aria-label="消费者窗口（新标签页打开）"><ArrowUpRight size={20} aria-hidden="true" /><span>消费者</span></a><button title={adminAccess?.identity.auth_method === "demo_server" ? "结束当前演示会话" : "退出登录"} aria-label={adminAccess?.identity.auth_method === "demo_server" ? "结束当前演示会话" : "退出登录"} disabled={busy || (!!adminAccess && (!logoutAction.ready || !!logoutAction.pending || logoutAction.blocked))} onClick={() => void logout()}><LogOut size={20} aria-hidden="true" /><span>{adminAccess?.identity.auth_method === "demo_server" ? "结束" : "退出"}</span></button></div></aside>
    <main className={s.main}><header className={s.header}><div><span className={s.eyebrow}>个性化穿搭 / 管理工作台</span><h1>{pageTitle}</h1><details className={s.identityDetails}><summary><ShieldCheck size={15} aria-hidden="true" /><span>{adminAccess ? `当前管理身份：${adminAccess.identity.subject}` : "管理权限已验证"}</span></summary><dl><div><dt>统计空间</dt><dd>{data.scope}</dd></div>{adminAccess && <><div><dt>管理角色</dt><dd>{adminAccess.identity.role}</dd></div><div><dt>授权空间</dt><dd>{adminAccess.identity.scope}</dd></div><div><dt>来源实例</dt><dd>{adminAccess.identity.source_instance_id}</dd></div><div><dt>身份到期</dt><dd>{time(adminAccess.identity.expires_at)}</dd></div></>}</dl></details></div><div className={s.tools}><select aria-label="统计时间范围" value={days} disabled={busy} onChange={e => { setDays(Number(e.target.value) as 0 | 7); resetRange(); }}><option value={7}>最近 7 天</option><option value={0}>累计记录</option></select><button disabled={refreshing || busy} onClick={() => { void loadRef.current(); void loadList(); }}><RefreshCw size={16} />{refreshing ? "更新中…" : "刷新"}</button><button disabled={refreshing || busy} onClick={resetRange}>更新查询范围</button></div></header>
      <section className={s.queryContext} aria-label="查询范围与数据口径"><div className={s.context}><span className={s.dot} />每 30 秒刷新状态 · 固定截止 {time(data.window_end)}<span>模拟业务数据 · 规则提炼 · 人工核对</span></div>
      {error && <p className={s.error} role="alert">更新失败，当前为上次结果：{error} <button className={s.textButton} onClick={() => void loadRef.current()}>重试</button></p>}
      {process.env.NEXT_PUBLIC_S1_FIXTURE === "1" && <p className={s.notice}>本地隔离合成验证：旧模拟发送与产品管理直接接收分开记录。本机技术回执不代表真实企业业务、伙伴接收或部署完成。</p>}<WindowInfo start={data.window_start} end={data.window_end} days={days} /><p className={s.window}>消费者试验后切回本标签。普通“刷新”只读取固定截止内的数据；要查看新交流，请点“更新查询范围”，原核对进度清除，开始新一轮核对。</p></section>
      {adminAccess && <><AdminActionStatus action={logoutAction} onRestart={() => { void (async () => { try { await adminAccess.validate(); logoutAction.archive(); } catch (reason) { handleError(reason); } })(); }} restartLabel="明确结束原退出请求并重新核对身份" /><AdminOperationRecovery access={adminAccess} /></>}
      <section className={s.metrics} aria-label="管理概览">{[{ label: "交流记录", value: data.counts.turns, hint: "每次沟通分别保存", target: "turns" }, { label: "有效需求次数", value: data.counts.occurrences, hint: "表达次数，不代表销量", target: "heat" }, { label: "待审核证据", value: data.counts.pending, hint: "需逐条核对来源", target: "heat" }, { label: "旧链路待接收", value: data.counts.pending_handoffs, hint: "不含新直连台账", target: "handoffs" }].map(m => <button key={m.label} className={s.metric} onClick={() => changeTab(m.target as Tab)}><span>{m.label}</span><strong>{m.value}</strong><small>{m.hint}</small></button>)}</section>
      {tab === "heat" && <section className={s.panel} aria-busy={refreshing}><div className={s.panelHeader}><div><h2>需求热度榜单</h2><p>有效表达次数降序；独立会话另列，不能等同真实人数。未知属性保持未知。</p></div><span className={s.pill}>人工审核后交接</span></div><div className={s.filters}><label>品类<select value={category} disabled={busy} onChange={e => { setCategory(e.target.value); resetRange(); }}><option value="">全部品类</option>{["上衣", "裤子", "裙子", "鞋履"].map(v => <option key={v}>{v}</option>)}</select></label><label>审核状态<select value={reviewState} disabled={busy} onChange={e => { setReviewState(e.target.value); resetRange(); }}><option value="">全部有效证据</option><option value="pending">待审核</option><option value="approved">已批准</option></select></label>{(category || reviewState) && <button onClick={() => { setCategory(""); setReviewState(""); resetRange(); }}>清除筛选</button>}</div>{refreshing && <p className={s.loading} role="status">正在查询榜单…</p>}{data.groups.length ? <><div className={s.tableWrap}><table><thead><tr><th>排名</th><th>需求 / 关键词</th><th>出现次数</th><th>独立会话</th><th>审核与交接</th><th>操作</th></tr></thead><tbody>{displayedGroups.map((g: Group, i) => <tr key={g.key}><td className={s.rank} data-label="排名">{String((data.page - 1) * data.page_size + i + 1).padStart(2, "0")}</td><td data-label="需求"><strong>{g.title}</strong><div className={s.tags}>{Object.values(g.attributes).filter(Boolean).map((v, j) => <span key={j}>{v}</span>)}</div><small>{g.data_origins.map(origin).join(" / ")}</small></td><td data-label="出现次数"><b className={s.number}>{g.count}</b></td><td data-label="独立会话">{g.session_count}</td><td data-label="审核与交接"><span className={s.pill}>{g.pending ? `${g.pending} 条待审核` : "已核对"}</span>{g.handoff && <small>v{g.handoff.version} · {stateLabel(g.handoff.status)}</small>}<small>最近表达 {time(g.last_seen)}</small></td><td data-label="操作"><button className={s.textButton} disabled={busy || refreshing || !!error} onClick={event => open({ kind: "group", id: g.key, title: g.title }, event.currentTarget)}>查看与审核 <ArrowUpRight size={15} /></button></td></tr>)}</tbody></table></div><Pager label="热度榜分页" page={data.page} total={data.groups_total} size={data.page_size} busy={refreshing} onChange={p => { setRefreshing(true); setHeatPage(p); }} /></> : !refreshing && <div className={s.empty}><BarChart3 size={30} /><h3>当前范围没有有效需求</h3><p>可调整时间或品类筛选；已排除记录仍可从交流台账追溯。</p></div>}</section>}
      {tab === "turns" && <section className={s.panel}><div className={s.panelHeader}><div><h2>逐轮交流台账</h2><p>无明确需求、否定、待复核与提炼失败分别保留。</p></div></div><div className={s.filters}><label>提炼状态<select value={turnState} onChange={e => { setTurnState(e.target.value); setTurnPage(1); setTurns(null); }}><option value="">全部状态</option>{["extracted", "no_explicit_demand", "negative_preference", "needs_review", "extraction_failed", "extracting"].map(v => <option key={v} value={v}>{stateLabel(v)}</option>)}</select></label><form onSubmit={e => { e.preventDefault(); setSession(sessionDraft.trim()); setTurnPage(1); setTurns(null); }}><label htmlFor="session-filter">会话编号</label><input id="session-filter" value={sessionDraft} onChange={e => setSessionDraft(e.target.value)} placeholder="输入完整会话编号" /><button disabled={listLoading}>筛选</button></form>{(session || turnState) && <button onClick={() => { setTurnState(""); setSession(""); setSessionDraft(""); setTurnPage(1); setTurns(null); }}>清除筛选</button>}</div>{listError && <p className={s.error} role="alert">{listError}{turns ? " · 以下已加载数据可能过期" : " · 可重试当前页"} <button onClick={() => void loadList()}>重试</button></p>}{listLoading && <p className={s.loading} role="status">正在查询交流记录…</p>}{turns && <><WindowInfo start={turns.window_start ?? null} end={turns.window_end ?? null} days={days} />{turns.items.length ? turns.items.map(t => <article className={s.record} key={t.id}><div><span className={s.pill}>{stateLabel(t.status)}</span><time>{time(t.created_at)}</time></div><p className={s.quote}>{t.text}</p><small>{origin(t.data_origin)} · {t.extractor} · 提炼尝试 {t.extraction_attempts} 次</small><small className={s.block}>交流 {t.id} · 会话 {t.session_id} · 关联需求 {t.occurrences.length} 条</small>{t.error_code && <p className={s.error}>提炼错误：{t.error_code}</p>}<button className={s.textButton} disabled={busy || listLoading} onClick={event => open({ kind: "turn", id: t.id, title: "交流与字段出处" }, event.currentTarget)}>查看原话与需求关联 ↗</button></article>) : !listLoading && <div className={s.empty}>当前筛选没有交流记录，可清除筛选或切换时间范围。</div>}<Pager page={turns.page} total={turns.total} size={turns.page_size} busy={listLoading} onChange={p => { setTurnPage(p); setTurns(null); }} /></>}</section>}
      {tab === "handoffs" && <section className={s.panel}><div className={s.panelHeader}><div><h2>审批历史与交接</h2><p>所有历史版本 · 列表状态为旧发送口径；新直连状态请打开详情查看。此列表不受交流时间窗口筛选。</p></div></div><div className={s.filters}><label>交接状态<select value={handoffState} onChange={e => { setHandoffState(e.target.value); setHandoffPage(1); setHandoffs(null); }}><option value="">全部状态</option>{["approved", "sending", "failed", "received"].map(v => <option key={v} value={v}>{stateLabel(v)}</option>)}</select></label><span className={s.muted}>{data.receiver_configured ? "旧发送接口已配置；新直连状态请打开详情查看" : "旧发送接口未配置；新直连状态请打开详情查看"}</span></div>{listError && <p className={s.error} role="alert">{listError} <button onClick={() => void loadList()}>重试</button></p>}{listLoading && <p className={s.loading} role="status">正在查询审批记录…</p>}{handoffs && <><div className={s.records}>{handoffs.items.length ? handoffs.items.map(renderHandoff) : !listLoading && <div className={s.empty}>当前状态没有审批记录。核对有效需求后可创建批准快照。</div>}</div><Pager page={handoffs.page} total={handoffs.total} size={handoffs.page_size} busy={listLoading} onChange={p => { setHandoffPage(p); setHandoffs(null); }} /></>}</section>}
      {tab === "images" && <section className={s.panel}><div className={s.panelHeader}><div><h2>生成任务与结果图片</h2><p>保留原有基础查询；展示最近60条。完整调用与费用监控属于S2。</p></div></div>{data.images.length ? <div className={s.imageGrid}>{data.images.map(img => <article className={s.imageCard} key={img.id}>{img.result_url ? <Image src={appPath(img.result_url)} alt={`${img.scene}生成结果`} width={360} height={480} unoptimized /> : <div className={s.imagePlaceholder}><ImageIcon size={30} /><span>{stateLabel(img.status)}{img.status === "succeeded" && !img.file_exists ? " · 文件缺失" : ""}</span></div>}<div><span className={s.pill}>{stateLabel(img.status)}</span><strong>{img.scene || "未标场景"}</strong><p>SKU {img.product_ids.join(" / ") || "未记录"}</p><small>{time(img.created_at)} · {img.bytes == null ? "无结果文件" : `${Math.round(img.bytes / 1024)} KB`}</small><small>任务 {img.id}</small><small>会话 {img.session_id || "未记录"}</small>{img.error && <p className={s.error}>{img.error}</p>}</div></article>)}</div> : <div className={s.empty}>当前范围暂无生成任务；本轮模拟需求不调用图片模型。</div>}</section>}
      {tab === "storage" && <section className={s.panel}><div className={s.panelHeader}><div><h2>数据存储与追溯</h2><p>当前单服务空间；完整多空间授权与监控另行实施。</p></div></div><dl className={s.storage}>{[["业务数据库", data.storage.database], ["结果图片目录", data.storage.results], ["原图临时目录", data.storage.uploads], ["原图处理规则", data.storage.raw_photo_policy], ["费用与用量", "历史Token、重试及实际费用未记录，不按零费用处理。"], ["撤回与恢复", "D3传播后续另定，自动撤回、属性修正和排除恢复保持关闭。"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>}
      <footer className={s.footer}>表达 → 提炼 → 人工核对 → 产品部门 <span>热度反映表达次数，经营效果需真实业务验证。</span></footer>
    </main>
    {modal && <dialog ref={dialogRef} className={s.overlay} aria-labelledby="detail-title" onCancel={e => { e.preventDefault(); close(); }}><section className={s.drawer}><header><span className={s.eyebrow}>EVIDENCE / REVIEW</span><button aria-label="关闭详情" onClick={close} disabled={busy}>关闭 ×</button></header><h2 id="detail-title">{modal.title}</h2><a className={s.textButton} href={appPath("/")} target="_blank" rel="noopener noreferrer" title="试验后切回本标签，保留当前核对" aria-label="消费者窗口（新标签页打开）">消费者窗口（新标签页） ↗</a>{modal.kind !== "group" && <button className={s.textButton} disabled={busy || detailLoading} onClick={() => { setMessage(""); void fetchDetail(modal); }}>重新查询当前记录</button>}{review && modal.kind !== "group" && <button className={s.textButton} disabled={busy} onClick={() => { detailSeq.current++; setDetailLoading(false); restoreReviewFocus.current = true; setModal(review.target); setDetailError(""); setMessage(""); }}>返回需求核对</button>}{frozenReturn && modal.kind === "turn" && <button className={s.textButton} disabled={busy} onClick={returnToFrozen}>返回批准时出处</button>}{detailLoading && <p className={s.loading} role="status">正在加载详情…</p>}{busy && <p className={s.loading} role="status">正在提交操作，请等待服务端确认；不要重复提交。</p>}{detailError && <p className={s.error} role="alert">{detailError}</p>}{message && <p className={s.success} role="status">{message}</p>}
      {review && <DemandReview adminAccess={adminAccess} key={review.serial} groupKey={review.target.id} days={review.days} window={review.bounds} hidden={modal.kind !== "group" || modal.id !== review.target.id} busy={busy} sourceTurns={sourceTurns} onBusy={setBusy} onError={handleError} onChanged={() => { void loadRef.current(); void loadList(); }} onResetSources={() => setSourceTurns({})} onOpenTurn={(id, opener) => open({ kind: "turn", id, title: "交流与字段出处" }, opener)} renderHandoff={renderHandoff} />}
      {modal.kind === "turn" && turn && <><p className={s.notice}>当前出处 · 本次查询的交流与修订状态。{frozenReturn ? "与批准当时的冻结出处分别展示，不回填历史；请点“返回批准时出处”对照。" : "此处显示当前记录，不代表历史批准时状态。"}</p><span className={s.pill}>{stateLabel(turn.status)}</span><p className={s.quote}>{turn.text || "原话未记录"}</p><p>{origin(turn.data_origin)} · {time(turn.created_at)} · {turn.extractor}</p><small className={s.block}>交流 {turn.id} · 会话 {turn.session_id} · 提炼尝试 {turn.extraction_attempts} 次</small>{turn.error_code && <p className={s.error}>提炼错误：{turn.error_code}</p>}{turn.negative_preferences.length > 0 && <div className={s.notice}>否定偏好（不计正向热度）：<pre>{JSON.stringify(turn.negative_preferences, null, 2)}</pre></div>}{adminAccess && turn.status === "extraction_failed" && turn.occurrences.length === 0 && <section className={s.confirm}><h3>重新提炼当前交流</h3><p>先重新读取当前交流，再明确确认。不会自动新建审批或恢复已排除证据。</p><AdminActionStatus action={retryAction} onRestart={() => void prepareRetry()} restartLabel="明确结束原动作并重新读取交流" /><button disabled={busy || detailLoading || !retryAction.ready || !!retryAction.pending || retryAction.blocked} onClick={() => void prepareRetry()}>重新读取后核对提炼</button>{retryConfirm?.id === turn.id && <><label><input type="checkbox" checked={retryConfirm.checked} onChange={event => setRetryConfirm({ id: turn.id, checked: event.target.checked })} />我已核对当前交流，确认发起新的提炼操作</label><button disabled={busy || !retryConfirm.checked} onClick={() => void retryExtraction()}>确认重新提炼</button></>}</section>}<h3>本轮需求关联 · {turn.occurrences.length} 条</h3>{turn.occurrences.map(o => <article className={s.evidence} key={o.id}><strong>{o.title}</strong><p>{stateLabel(o.review_state)} · {stateLabel(o.lifecycle)} · 修订 {o.revision}</p><Attributes values={o.attributes} /><h4>每个字段的用户出处</h4>{Object.entries(o.field_sources).length ? <dl className={s.sources}>{Object.entries(o.field_sources).map(([key, ids]) => <div key={key}><dt>{fields[key] || key}：{o.attributes[key as keyof DemandAttributes] || "未明确"}</dt><dd>{ids.map(id => { const source = id === turn.id ? turn : sourceTurns[id] || turn.context_turns.find(t => t.id === id); return <div key={id}><small>{id === turn.id ? "当前交流" : "此前用户交流"} · {id}</small><p>{source?.text || "此出处未返回，需后端核对"}</p>{id !== turn.id && sourceTurns[id] && <small>来源需求记录：{sourceTurns[id].occurrences.length ? sourceTurns[id].occurrences.map(o => `${stateLabel(o.review_state)} / ${stateLabel(o.lifecycle)} / 修订 ${o.revision}`).join("；") : "此交流未计入正向需求"}</small>}</div>; })}</dd></div>)}</dl> : <p className={s.muted}>历史记录未保存字段出处，不补猜来源。</p>}{o.context_turn_ids.length > 0 && <p>跨轮引用 {o.context_turn_ids.length} 条；仅同会话已发生的用户表达。</p>}{o.reason && <p>审核说明：{o.reason}</p>}<button className={s.textButton} disabled={busy} onClick={event => open({ kind: "group", id: o.group_key, title: o.title }, event.currentTarget)}>打开需求与审核 ↗</button></article>)}{!turn.occurrences.length && <p>本轮未计入正向需求热度，交流记录保留。</p>}<h3>证据修订历史</h3>{turn.revision_history.length ? turn.revision_history.map((r, i) => <article className={s.evidence} key={`${r.occurrence_id}-${r.revision}-${i}`}><p>修订 {r.revision} · {r.action} · {r.actor}</p><small>{time(r.created_at)} · {r.occurrence_id}</small><details><summary>查看此修订内容</summary><pre>{JSON.stringify(r.snapshot, null, 2)}</pre></details></article>) : <p className={s.muted}>暂无修订历史。</p>}<p className={s.notice}>自动撤回和恢复操作保持关闭；冲突、失败与否定表达保留原状态供复核。</p></>}
      {modal.kind === "handoff" && handoff && <><span className={s.pill}>{stateLabel(handoff.status)}</span><h3>{handoff.payload.demand.title}</h3><p>{handoff.payload.demand.description}</p><Attributes values={handoff.payload.demand.attributes} /><p>v{handoff.version} · {handoff.occurrences} 条证据 · {origin(handoff.payload.data_origin)}</p><p>批准说明：{handoff.payload.review_note}</p><small className={s.block}>{handoff.id}</small><p>批准人：{handoff.metadata?.approved_by || "历史未记录"} · {time(handoff.created_at)}</p><WindowInfo start={handoff.metadata?.window_start ?? null} end={handoff.metadata?.window_end ?? null} /><p className={s.muted}>本地元数据用于追溯；跨产品载荷仍为 schema 1.4；新直连接收见独立台账，伙伴真实接收另行处理。</p><FrozenSources metadata={handoff.metadata ?? {}} onOpenCurrent={openCurrentSource} busy={busy || detailLoading} />{directSession && <DirectDelivery adminAccess={adminAccess} handoff={handoff} sessionNamespace={directSession} onAuthError={handleError} />}<h3>旧发送记录 · CMS / 本机模拟接收</h3>{adminAccess && <p className={s.notice}>此管理上下文模式关闭旧发送入口；保留旧链路历史事实。新操作使用上方独立直连区域。</p>}<p className={s.muted}>以下状态、操作与审计属于旧发送链路，不计为产品管理直接接收。</p>{handoff.needs_review && <p className={s.error}>当前需复核：{handoff.review_reasons.map(r => reasons[r] || r).join("、")}；历史{stateLabel(handoff.status)}事实保留。</p>}{handoff.last_error && <p className={s.error}>{handoff.last_error}</p>}<div className={s.inlineActions}><button disabled={busy || detailLoading || !!detailError} onClick={() => void download(handoff.id)}>导出冻结交接包</button><button disabled={!!adminAccess || busy || detailLoading || !!detailError || !data.receiver_configured || !handoff.send_eligible} onClick={() => setConfirmSend(true)}>{handoff.status === "failed" || handoff.status === "sending" ? "重试同一交接" : "上传产品部门"}</button></div>{handoff.status === "received" ? <p className={s.success}>服务端已有匹配接收回执，不重复发送。{time(handoff.received_at)}</p> : handoff.send_in_progress ? <p className={s.notice}>交接正在发送；约 {handoff.retry_after_seconds} 秒后可再次查询。不要重复发送。</p> : !data.receiver_configured ? <p className={s.notice}>接收接口未配置。当前可导出核对；伙伴真实发送另行联调。</p> : !handoff.send_eligible && <p className={s.notice}>当前版本不具备发送资格，请先核对复核原因。</p>}{confirmSend && !adminAccess && <section className={s.confirm}><h3>核对后发送此冻结版本？</h3><p>快照 {handoff.id} · v{handoff.version}。失败或中断后查询原编号，由人决定重试；不会自动更换版本。</p><div className={s.inlineActions}><button disabled={busy} onClick={() => void mutate(`handoffs/${encodeURIComponent(handoff.id)}/send`, {}, "服务端收到匹配接收回执；请在下方核对发送尝试和接收编号。")}>确认发送同一交接</button><button disabled={busy} onClick={() => setConfirmSend(false)}>暂不发送</button></div></section>}<h3>发送尝试 · {handoff.send_attempts.length} 次</h3>{handoff.send_attempts.length ? handoff.send_attempts.map(a => <article className={s.evidence} key={a.id}><p>{stateLabel(a.status)} · {time(a.attempted_at)}</p><small className={s.block}>尝试 {a.id}</small>{a.error_code && <p className={s.error}>{reasons[a.error_code] || a.error_code}</p>}<small>结束 {time(a.finished_at)}</small>{Object.keys(a.receipt).length > 0 && <details><summary>查看接收回执（以原编号匹配）</summary><pre>{JSON.stringify(a.receipt, null, 2)}</pre></details>}</article>) : <p>尚未发送。导出不会创建发送尝试。</p>}<h3>审批 / 导出 / 发送审计</h3>{handoff.audit.length ? handoff.audit.map(a => <article className={s.evidence} key={a.id}><p>{({ approve: "人工批准", export: "导出文件", send_attempt: "人工发送", send_failed: "发送失败", received: "匹配接收" } as Record<string, string>)[a.action] || a.action} · {a.actor}</p><p>{a.note}</p><small>{time(a.created_at)}</small></article>) : <p>暂无审计记录。</p>}<details className={s.snapshot}><summary>查看冻结交接包内容</summary><pre>{JSON.stringify(handoff.payload, null, 2)}</pre></details></>}
    </section></dialog>}
  </div>;
}
