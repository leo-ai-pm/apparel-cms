"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { activeEvidence, adminApi, adminQuery, AdminError, approvalBody, approvalSetsEqual, checkedCoverage, formatAdminTime as time, parseApprovalEligibility, sourceReviewWitness, sourceTurnFingerprint, windowQuery } from "../lib/admin-api";
import type { ApprovalEligibility, ApprovalSet, DemandAttributes, Evidence, GroupDetail, Handoff, TurnDetail } from "../lib/admin-api";
import { isAdminContextConflict, type AdminContextAccess } from "./AdminContextBoundary";
import { useAdminAction, readAdminNote, saveAdminNote } from "./use-admin-action";
import { AdminActionStatus } from "./AdminActionStatus";
import EligibilityNotice from "./EligibilityNotice";
import s from "./admin.module.css";

const fields: Record<string, string> = { season: "季节", scene: "场景", category: "品类", fit: "松紧", silhouette: "廓形" };
const PAGE_SIZE = 40;
type Props = {
  adminAccess?: AdminContextAccess;
  groupKey: string;
  days: 0 | 7;
  window: { window_start: string | null; window_end: string };
  hidden: boolean;
  busy: boolean;
  sourceTurns: Record<string, TurnDetail>;
  onBusy: (busy: boolean) => void;
  onError: (error: unknown) => void;
  onChanged: () => void;
  onResetSources: () => void;
  onOpenTurn: (id: string, opener: HTMLElement) => void;
  renderHandoff: (handoff: Handoff) => React.ReactNode;
};

function availableSources(e: Evidence, sourceTurns: Props["sourceTurns"]): boolean {
  if (!e.text?.trim()) return false;
  // Older rules did not persist provenance. Preserve that limitation visibly.
  if (e.normalizer_version === "rules-v1") return true;
  const ids = Object.entries(e.attributes).filter(([, value]) => value).flatMap(([key]) => e.field_sources?.[key as keyof DemandAttributes] ?? []);
  if (Object.entries(e.attributes).some(([key, value]) => value && !e.field_sources?.[key as keyof DemandAttributes]?.length)) return false;
  if (ids.every(id => id === e.turn_id)) return true;
  const turn = sourceTurns[e.turn_id];
  if (!turn || turn.text !== e.text || !turn.occurrences.some(o => o.id === e.id && o.revision === e.revision)) return false;
  return ids.every(id => id === turn.id ? !!turn.text.trim() : !!turn.context_turns.find(t => t.id === id)?.text?.trim());
}

export default function DemandReview(props: Props) {
  const { adminAccess, groupKey, days, window: bounds, hidden, busy, sourceTurns, onBusy, onError, onChanged, onResetSources, onOpenTurn, renderHandoff } = props;
  const action = useAdminAction({ access: adminAccess ?? null, slot: `review:${groupKey}:${bounds.window_start}:${bounds.window_end}` });
  const noteSlot = `review:${groupKey}:${bounds.window_start}:${bounds.window_end}`;
  const [savedNote, setSavedNote] = useState(() => adminAccess ? readAdminNote(adminAccess.identity, noteSlot) : "");
  const writeLocked = !!adminAccess && (!action.ready || action.blocked || !!action.pending);
  const read = <T,>(path: string) => adminAccess ? adminAccess.read<T>(path) : adminApi<T>(path);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [baseline, setBaseline] = useState<ApprovalSet | null>(null);
  const baselineRef = useRef<ApprovalSet | null>(null);
  const [eligibility, setEligibility] = useState<ApprovalEligibility | null>(null);
  const eligibilityRef = useRef<ApprovalEligibility | null>(null);
  const [checked, setChecked] = useState<Record<string, number>>({});
  const witnesses = useRef<Record<string, Record<string, string>>>({});
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [success, setSuccess] = useState("");
  const seq = useRef(0);
  const wantedPage = useRef(1);
  const operation = useRef(false);
  const query = adminQuery({ days, ...windowQuery(bounds) });
  const setPath = `groups/${encodeURIComponent(groupKey)}/approval-set${query}`;

  function invalidate(message: string) {
    baselineRef.current = null;
    setBaseline(null);
    setChecked({});
    witnesses.current = {};
    onResetSources();
    setNotice(message);
  }

  function observeEligibility(value: unknown) {
    const next = parseApprovalEligibility(value);
    eligibilityRef.current = next;
    setEligibility(next);
    if (!next || !next.eligible) {
      invalidate("");
      setSuccess("");
    }
    return next;
  }

  function sourceBlocked(e: unknown): e is AdminError {
    return e instanceof AdminError && e.status === 409 && e.code === "SOURCE_APPROVAL_BLOCKED";
  }

  async function getSet(): Promise<ApprovalSet> {
    const result = await read<ApprovalSet>(setPath);
    if (!parseApprovalEligibility(result.approval_eligibility)) {
      throw new AdminError(200, "INVALID_APPROVAL_ELIGIBILITY", "审批资格缺失或不符合已确认政策，当前不能批准。请联系后端核对。");
    }
    if (!approvalSetsEqual(result, result) || result.group_key !== groupKey || result.days !== days || result.window_start !== bounds.window_start || result.window_end !== bounds.window_end) {
      throw new AdminError(200, "INVALID_RESPONSE", "完整证据集合或查询窗口不符合契约，当前不能批准。请联系后端核对。");
    }
    return result;
  }

  async function loadPage(page: number, restart = false) {
    const id = ++seq.current;
    wantedPage.current = page;
    setLoading(true); setError("");
    try {
      // A must precede reading the page. A fresh B after reading also detects
      // changes between these requests; fetching A and the page in parallel can
      // otherwise associate an old displayed text with a later digest.
      let basis = baselineRef.current;
      if (restart) {
        basis = await getSet();
        if (id !== seq.current) return;
        observeEligibility(basis.approval_eligibility);
      }
      const result = await read<GroupDetail>(`groups/${encodeURIComponent(groupKey)}${adminQuery({ days, ...windowQuery(bounds), page, page_size: PAGE_SIZE })}`);
      const after = await getSet();
      if (id !== seq.current) return;
      if (result.pagination_mode !== "paged" || result.window_start !== bounds.window_start || result.window_end !== bounds.window_end || result.page !== page || result.page_size !== PAGE_SIZE) {
        throw new AdminError(200, "INVALID_RESPONSE", "来源分页或查询窗口不符合契约，当前不能批准。请联系后端核对。");
      }
      setDetail(result);
      const currentEligibility = observeEligibility(after.approval_eligibility);
      if (!currentEligibility?.eligible || (basis && !basis.approval_eligibility.eligible)) return;
      const pageMatches = !basis || activeEvidence(result).every(e => basis.expected_revisions[e.id] === e.revision);
      if (basis && (!approvalSetsEqual(basis, after) || !pageMatches)) {
        invalidate("证据集合或内容已变化，已清除旧核对进度。说明已保留，请重新开始全部核对。");
      } else if (restart && basis) {
        baselineRef.current = basis; setBaseline(basis); setChecked({}); witnesses.current = {}; setNotice(""); setSuccess("");
      }
    } catch (e) {
      if (id !== seq.current) return;
      onError(e);
      setError(e instanceof Error ? e.message : "来源查询失败，请重试。");
      if (sourceBlocked(e)) observeEligibility(e.approval_eligibility);
      else if (e instanceof AdminError && e.code === "INVALID_APPROVAL_ELIGIBILITY") observeEligibility(null);
      else if (adminAccess || restart || (e instanceof AdminError && e.status === 409)) invalidate(eligibilityRef.current?.eligible
        ? "完整核对基准不可用，旧核对已清除，说明已保留。请点“重新开始全部核对”，再阅读所有证据与出处；刷新查询不会建立新核对。"
        : "完整核对基准不可用，旧核对已清除，说明已保留。当前不能批准，请查询资格并核对出处。");
    } finally { if (id === seq.current) setLoading(false); }
  }

  // The parent keeps this component mounted when opening a turn's provenance.
  // Its key changes only for a new group/window/review, never for page changes.
  const initialLoad = useRef(loadPage);
  useEffect(() => {
    const sequence = seq;
    const timer = setTimeout(() => { void initialLoad.current(1, true); }, 0);
    return () => { clearTimeout(timer); sequence.current++; };
  }, []);

  async function reject(e: Evidence) {
    if (operation.current || writeLocked || busy || loading || error || note.trim().length < 2) return;
    operation.current = true; onBusy(true); setError(""); setSuccess("");
    // A write changes the reviewed set even if a network result is uncertain.
    invalidate("排除操作后需重新核对全部有效证据。说明已保留。");
    try {
      if (adminAccess) {
        await adminAccess.validate();
        const current = await read<TurnDetail>(`turns/${encodeURIComponent(e.turn_id)}`);
        if (!current.occurrences.some(item => item.id === e.id && item.revision === e.revision && item.lifecycle === "active" && item.review_state !== "rejected")) throw new AdminError(409, "CONFLICT", "待排除记录已变化，请重新核对。");
        await action.execute(`occurrences/${encodeURIComponent(e.id)}/reject`, { note, expected_revision: e.revision });
      } else await adminApi(`occurrences/${encodeURIComponent(e.id)}/reject`, { note, expected_revision: e.revision });
      await loadPage(1, !adminAccess);
      setSuccess("记录已排除；原快照和批准历史保留，请重新核对有效证据。");
      onChanged();
    } catch (e) {
      onError(e);
      if (adminAccess && isAdminContextConflict(e)) { invalidate("管理上下文或原操作发生冲突。说明保留在原范围，旧勾选已清除；请先查询原事实，再明确重新核对。"); setError(e instanceof Error ? e.message : "原管理操作冲突。"); return; }
      await loadPage(detail?.page ?? 1);
      setError((e instanceof Error ? e.message : "排除未确认") + " 已重新查询，说明已保留，请重新开始全部核对。");
    } finally { operation.current = false; onBusy(false); }
  }

  const covered = baseline ? checkedCoverage(baseline, checked) : false;
  async function approve() {
    if (operation.current || writeLocked || busy || loading || error || !eligibilityRef.current?.eligible || !baseline || !covered || note.trim().length < 2) return;
    const basis = baseline;
    operation.current = true; onBusy(true); setError(""); setSuccess("");
    try {
      // Keep the already-read source witness as an early UX check. The backend
      // resolved-sources digest and final transaction provide the authoritative
      // consistency guarantee; never compute a digest from source_snapshot.
      const expectedSources: Record<string, string> = {};
      for (const occurrenceId of basis.expected_occurrence_ids) {
        const witness = witnesses.current[occurrenceId];
        if (!witness) { invalidate("出处核对记录缺失，未提交批准，请重新开始全部核对。"); return; }
        for (const [id, fingerprint] of Object.entries(witness)) {
          if (expectedSources[id] && expectedSources[id] !== fingerprint) { invalidate("来源原话或修订在核对期间已变化，未提交批准。说明已保留，请重新开始全部核对。"); return; }
          expectedSources[id] = fingerprint;
        }
      }
      const currentSources = await Promise.all(Object.keys(expectedSources).map(id => read<TurnDetail>(`turns/${encodeURIComponent(id)}`)));
      const after = await getSet();
      if (!observeEligibility(after.approval_eligibility)?.eligible) return;
      if (currentSources.some(turn => sourceTurnFingerprint(turn) !== expectedSources[turn.id])) {
        invalidate("来源原话或修订在核对期间已变化，未提交批准。说明已保留，请重新开始全部核对。");
        return;
      }
      if (!approvalSetsEqual(basis, after)) {
        invalidate("证据集合或内容已变化，未提交批准。说明已保留，请重新开始全部核对。");
        await loadPage(detail?.page ?? 1);
        return;
      }
      // Only the original, fully reviewed A is submitted. Never replace A with B.
      const outcome = adminAccess
        ? await action.execute(`groups/${encodeURIComponent(groupKey)}/approve`, { ...approvalBody(basis, note) })
        : (await adminApi(`groups/${encodeURIComponent(groupKey)}/approve`, approvalBody(basis, note)), null);
      invalidate("本次核对已完成并批准。若要再次批准，请重新开始全部核对。");
      await loadPage(detail?.page ?? 1);
      setSuccess(outcome?.operation?.outcome === "reused_frozen" ? "已复用原有冻结审批；不是当前管理员的新批准，原批准人与来源批准记录保持原样。" : "当前证据快照已批准并保存；请查看冻结版本，导出不代表接收。");
      onChanged();
    } catch (e) {
      onError(e);
      if (adminAccess && isAdminContextConflict(e)) { invalidate("管理上下文或原操作发生冲突。说明保留在原范围，旧勾选已清除；不会替换上下文或重新批准。请先查询原操作事实。"); setError(e instanceof Error ? e.message : "原管理操作冲突。"); return; }
      // A failed POST may have committed. Query history, never automatically
      // approve again or reuse the old review after a conflict/uncertain write.
      const conflict = e instanceof AdminError && e.status === 409;
      const paused = sourceBlocked(e);
      if (paused) observeEligibility(e.approval_eligibility);
      else if (e instanceof AdminError && e.code === "INVALID_APPROVAL_ELIGIBILITY") observeEligibility(null);
      else invalidate(conflict
        ? "审批冲突：旧核对已清除，说明已保留。请点“重新开始全部核对”，再逐条阅读全部证据与出处；不会自动替换摘要或重新批准。"
        : "批准未确认，旧核对已清除，说明已保留。请先查批准历史，再点“重新开始全部核对”；不会自动重新提交。");
      await loadPage(detail?.page ?? 1);
      setError((e instanceof Error ? e.message : "批准未确认") + (paused || !eligibilityRef.current?.eligible
        ? " 说明已保留，旧核对已清除，批准保持关闭。请等待人工复核；重新核对不会解除暂停。"
        : " 说明已保留，请点“重新开始全部核对”后再操作。"));
    } finally { operation.current = false; onBusy(false); }
  }

  async function restartReview() {
    invalidate(""); setSuccess("");
    try {
      if (adminAccess) { await adminAccess.validate(); if (!action.archive()) return; }
      await loadPage(1, true);
    } catch (reason) { onError(reason); setError(reason instanceof Error ? reason.message : "重新核对失败。"); }
  }

  const totalPages = Math.max(1, Math.ceil((detail?.total ?? 0) / PAGE_SIZE));
  const page = detail?.page ?? 1;
  const count = baseline ? baseline.expected_occurrence_ids.filter(id => checked[id] === baseline.expected_revisions[id]).length : 0;
  return <div hidden={hidden} className={s.reviewRoot}>
    <p className={s.notice}>逐页阅读用户原话与字段出处，再逐条确认。分页加载不代表已核对；批准包含所选窗口的全部有效证据，包含此前已批准记录。</p>
    <p className={s.window}>固定查询窗口（北京时间）：{bounds.window_start ? time(bounds.window_start) : "最早记录"} ≤ 交流时间 &lt; {time(bounds.window_end)}。{days === 7 ? "滚动7天（168小时）" : "累计记录"}，UTC[start,end)，含起点、不含截止；普通刷新沿用此截止。</p>
    {loading && <p className={s.loading} role="status">正在加载来源与完整核对基准…</p>}
    {error && <p className={s.error} role="alert">{error}{detail ? " · 以下为上次已加载来源" : ""} <button disabled={busy || loading} onClick={() => void loadPage(wantedPage.current)}>重试来源查询</button></p>}
    {notice && <p className={s.notice} role="status">{notice}</p>}
    {success && <p className={s.success} role="status">{success}</p>}
    <div className={s.reviewLayout}>
      <aside className={s.reviewSummary} aria-label="核对状态与审核说明">
        <span className={s.sectionLabel}>审核工作区</span>
    {!loading && <EligibilityNotice eligibility={eligibility} busy={busy} onOpenSource={(id, opener) => onOpenTurn(id, opener)} />}
    {loading && eligibility?.eligible === false && <EligibilityNotice eligibility={eligibility} busy={busy} onOpenSource={(id, opener) => onOpenTurn(id, opener)} />}
    <div className={s.inlineActions}>
      <button disabled={busy || loading} onClick={() => void loadPage(wantedPage.current)}>刷新核对数据</button>
      <button disabled={busy || loading || (!!adminAccess && (!action.ready || !!action.pending || action.blocked))} onClick={() => void restartReview()}>重新开始全部核对</button>
    </div>
    {adminAccess && <AdminActionStatus action={action} onRestart={() => void restartReview()} restartLabel="明确结束原动作并重新开始全部核对" />}
    {savedNote && !note && <button disabled={busy} onClick={() => { setNote(savedNote); setSavedNote(""); }}>恢复本管理会话暂存说明</button>}
    <div className={s.reviewProgress} role="status">
      <strong>已核对 {count} / {baseline?.active_count ?? "待取得"} 条有效证据</strong>
      <span>来源共 {detail?.total ?? "待取得"} 条记录，包含已排除记录；已排除记录不计入批准。</span>
      {!covered && <span>完整有效集合核对完成前，批准保持关闭。</span>}
    </div>
    <label className={s.note}>审核 / 排除说明（至少2字）<textarea rows={3} value={note} onChange={e => { setNote(e.target.value); if (adminAccess) saveAdminNote(adminAccess.identity, noteSlot, e.target.value); }} maxLength={500} placeholder="先核对原话与出处，再填写结论或排除原因" disabled={busy} /></label>
      </aside>
      <section className={s.reviewEvidence} aria-label="完整来源证据">
    <h3>来源证据 · 第 {page} / {totalPages} 页</h3>
    {detail?.evidence.map(e => {
      const active = e.lifecycle === "active" && e.review_state !== "rejected";
      const matches = baseline?.expected_revisions[e.id] === e.revision;
      const witness = sourceReviewWitness(e, sourceTurns);
      const sources = availableSources(e, sourceTurns) && witness !== null;
      return <article className={s.evidence} key={e.id}>
        <div><time>{time(e.created_at)}</time><span>{active ? e.review_state === "approved" ? "已批准" : "待审核" : "已排除或撤回"} · 修订 {e.revision}</span></div>
        <p className={s.quote}>{e.text || "原话未记录"}</p>
        <small>{e.data_origin === "simulation_fixture" ? "合成演示样本" : "实际程序交流 · 模拟业务"} · {e.extractor} / {e.normalizer_version}</small>
        <small>证据 {e.id} · 交流 {e.turn_id} · 会话 {e.session_id}</small>
        <dl className={s.attributes}>{Object.entries(fields).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{e.attributes[key as keyof DemandAttributes] || "未明确"}</dd></div>)}</dl>
        <p className={s.muted}>{e.context_turn_ids.length ? "此条含跨轮出处，请打开下方来源阅读后再核对。" : "字段来源为当前原话；可打开下方查看逐字段出处。"}{e.normalizer_version === "rules-v1" && " 历史规则未记录逐字段出处，不补猜来源。"}</p>
        <div className={s.inlineActions}>
          <button className={s.textButton} disabled={busy || loading} onClick={event => onOpenTurn(e.turn_id, event.currentTarget)}>查看原话与跨轮出处 ↗</button>
          {active && <button className={s.textButton} disabled={writeLocked || busy || loading || !!error || note.trim().length < 2} onClick={() => void reject(e)}>排除这条记录</button>}
        </div>
        {active && <label className={s.reviewCheck}><input type="checkbox" aria-label={`已核对原话与出处：${e.id}`} checked={checked[e.id] === e.revision} disabled={writeLocked || busy || loading || !!error || !eligibility?.eligible || !baseline || !matches || !sources} onChange={event => { const isChecked = event.target.checked; if (isChecked && witness) witnesses.current[e.id] = witness; else delete witnesses.current[e.id]; setChecked(old => { const next = { ...old }; if (isChecked) next[e.id] = e.revision; else delete next[e.id]; return next; }); }} />已核对这条原话与出处</label>}
        {active && !sources && <p className={s.notice}>来源缺失或跨轮原话尚未查阅，当前不能勾选或批准。请打开出处核对。</p>}
        {e.reason && <p>排除说明：{e.reason}</p>}
      </article>;
    })}
    {detail && !detail.evidence.length && !loading && <p>当前页没有来源记录，可返回上一页；历史批准记录保留。</p>}
    <nav className={s.pager} aria-label="来源证据分页"><span>共 {detail?.total ?? 0} 条 · 第 {page} / {totalPages} 页</span><button disabled={busy || loading || page <= 1} onClick={() => void loadPage(page - 1)}>上一页</button><button disabled={busy || loading || !detail?.has_more} onClick={() => void loadPage(page + 1)}>下一页</button></nav>
      </section>
      <div className={s.reviewDecision}>
    <button className={s.primary} disabled={writeLocked || busy || loading || !!error || !eligibility?.eligible || !covered || note.trim().length < 2} onClick={() => void approve()}>{busy ? "正在核验并提交…" : "核验并批准当前证据快照"}<ShieldCheck size={17} /></button>
    <p className={s.muted}>批准前再次核对完整ID、修订与内容摘要；任一变化必须重新阅读。撤回、属性修正与排除恢复保持关闭。</p>
    {baseline && <details><summary>查看完整核对基准</summary><p>有效证据 {baseline.active_count} 条 · 组 {baseline.group_key}</p><pre>证据内容摘要 {baseline.evidence_digest}</pre><p>此摘要用于批准核对，不能替代冻结文件摘要。</p></details>}
      </div>
    </div>
    <h3>历史审批版本</h3>{detail?.handoffs.length ? detail.handoffs.map(renderHandoff) : <p>尚无批准记录。</p>}
  </div>;
}
