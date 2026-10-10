"use client";

import { useEffect, useRef, useState } from "react";
import { AdminError } from "../lib/admin-api";
import { getAdminOperation, type AdminOperation } from "../lib/admin-context";
import type { AdminContextAccess } from "./AdminContextBoundary";
import { readAdminSafeReferences, type useAdminAction } from "./use-admin-action";
import s from "./admin.module.css";

const states = { pending: "处理中，只能继续查询", completed: "处理完成", failed: "处理失败", unconfirmed: "结果尚未确认" };
export function AdminOperationFact({ value }: { value: AdminOperation }) {
  return <div className={s.notice}><p>原操作 {value.request_id} · {states[value.state]}</p><p>记录中的执行身份：{value.actor_subject}</p>{value.outcome === "reused_frozen" && <p>复用原有冻结审批，未创建当前管理员的新审批；原批准人与来源批准记录保持原样。</p>}{value.context_binding === "legacy_unbound" && <p>历史未绑定管理上下文，仅可查询，不补绑定或重放。</p>}{!value.result_ref && value.operation_kind !== "logout" && <p>服务端未提供结果引用；请读取当前对象核对，不补造历史引用。</p>}{value.result_ref && <p>原结果引用：{value.result_ref.id}{value.result_ref.revision !== null ? ` · 修订 ${value.result_ref.revision}` : ""}</p>}</div>;
}
export function AdminActionStatus({ action, onRestart, restartLabel = "明确结束原动作并重新核对" }: { action: ReturnType<typeof useAdminAction>; onRestart?: () => void; restartLabel?: string }) {
  if (!action.pending && !action.error && !action.blocked) return null;
  return <section aria-label="原管理操作状态" className={s.confirm}>{action.pending && <p>原请求编号：{action.pending.request_id}。原内容与管理上下文保持不变。</p>}{action.error && <p role="alert" className={s.error}>{action.error}</p>}{action.metadata && <AdminOperationFact value={action.metadata} />}<p className={s.muted}>断线或 404 不能证明未执行。先查询原事实；不会自动提交、换编号或换管理上下文。</p><div className={s.inlineActions}>{action.pending && <button disabled={action.busy || !action.ready} onClick={() => void action.query()}>查询原操作状态</button>}{action.canReplay && <button disabled={action.busy} onClick={() => void action.replay().catch(() => undefined)}>按原编号回放处理结果</button>}{onRestart && <button disabled={action.busy || !action.ready || action.metadata?.state === "pending"} onClick={onRestart}>{restartLabel}</button>}</div></section>;
}
export function AdminOperationRecovery({ access }: { access: AdminContextAccess }) {
  const [requestId, setRequestId] = useState("");
  const [result, setResult] = useState<AdminOperation | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(false), sequence = useRef(0);
  useEffect(() => { live.current = true; const version = sequence; return () => { live.current = false; version.current++; }; }, []);
  async function query() {
    const id = requestId.trim(); if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id) || busy) return;
    const version = ++sequence.current; setBusy(true); setResult(null); setError("");
    try {
      const identity = await access.validate();
      const operation = await getAdminOperation(id, identity);
      await access.validate();
      if (live.current && version === sequence.current) setResult(operation);
    } catch (reason) {
      if (!live.current || version !== sequence.current) return;
      access.onError(reason);
      setError(reason instanceof AdminError && reason.status === 404 ? "当前本人未查到此操作；这不代表远端未执行，也不允许重发。请核对原编号。" : reason instanceof Error ? reason.message : "原操作读取失败。");
    } finally { if (live.current && version === sequence.current) setBusy(false); }
  }
  const references = readAdminSafeReferences(access.identity);
  return <details className={s.snapshot}><summary>查询本人原管理操作（只读恢复）</summary><p>仅查询原处理事实，不恢复旧请求正文、审核说明或同意勾选，也不会重新发送。</p><label>原请求编号<input list="admin-safe-references" value={requestId} onChange={event => { sequence.current++; setBusy(false); setRequestId(event.target.value); setResult(null); setError(""); }} maxLength={160} /></label><datalist id="admin-safe-references">{references.map(value => <option key={value.request_id} value={value.request_id}>{value.operation_kind}</option>)}</datalist><button disabled={busy || !/^[A-Za-z0-9_.:-]{1,160}$/.test(requestId.trim())} onClick={() => void query()}>只读查询原事实</button>{error && <p className={s.error} role="alert">{error}</p>}{result && <AdminOperationFact value={result} />}</details>;
}
