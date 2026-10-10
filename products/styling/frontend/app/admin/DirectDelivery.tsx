"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AdminError, formatAdminTime as time, type Handoff } from "../lib/admin-api";
import { appPath } from "../lib/app-path";
import { appendDirectSupplement, directErrorMessage, downloadEvidenceExport, getDirectDelivery, parseDirectDelivery, parseEvidenceExport, reconcileDirectHandoff, registerEvidenceExport, sendDirectHandoff } from "../lib/admin-direct-api";
import type { DirectActionBody, DirectDelivery as Delivery, DirectHandoffBinding, DirectSendBody, EvidenceExport } from "../lib/admin-direct-api";
import type { AdminContextAccess } from "./AdminContextBoundary";
import { useAdminAction } from "./use-admin-action";
import s from "./direct-delivery.module.css";

const sessionKey = () => `styling.admin-direct-session.v1:${appPath("/")}`;
export function adminDirectSession(fresh = false): string {
  try {
    const old = sessionStorage.getItem(sessionKey());
    if (!fresh && old && /^[a-zA-Z0-9-]{1,100}$/.test(old)) return old;
    const id = crypto.randomUUID();
    sessionStorage.setItem(sessionKey(), id);
    return id;
  } catch { return crypto.randomUUID(); }
}
export function forgetAdminDirectSession(): void {
  try { sessionStorage.removeItem(sessionKey()); } catch { /* No private values are exposed. */ }
}

type Pending = { operation: "send"; body: DirectSendBody } | { operation: "reconcile" | "supplement"; body: DirectActionBody };
type Props = { handoff: Handoff; sessionNamespace: string; onAuthError?: (error: AdminError) => void; adminAccess?: AdminContextAccess };
const operationLabel = { send: "直接发送", reconcile: "查询对账", supplement: "追加冻结证据" };
const stateLabel = { not_started: "尚未开始直接交接", sending: "直接交接发送中", unconfirmed: "产品管理接收待确认", received: "产品管理直接接收已确认" };
const errorMessage = (error: unknown) => error instanceof AdminError ? `${error.message}（${error.code}）` : "操作未完成，请读取原交接状态后再核对。";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const sameValue = (left: unknown, right: unknown): boolean => object(left) && object(right)
  ? Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => sameValue(left[key], right[key])) : left === right;
const abort = (error: unknown) => object(error) && error.name === "AbortError";
const pendingKey = (namespace: string, binding: DirectHandoffBinding) => `styling.admin-direct-pending.v1:${appPath("/")}:${namespace}:${binding.id}:${binding.version}:${binding.source_approval_ref?.approval_record_id ?? "legacy"}`;
function readPending(key: string, revision: number): Pending | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!object(value) || Object.keys(value).length !== 2 || !object(value.body) || !["send", "reconcile", "supplement"].includes(String(value.operation))) return null;
    const body = value.body;
    if (typeof body.request_id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.request_id) || body.expected_revision !== revision) return null;
    const fields = value.operation === "send" ? ["request_id", "expected_revision", "include_supplement"] : ["request_id", "expected_revision"];
    if (Object.keys(body).length !== fields.length || !fields.every(field => Object.hasOwn(body, field)) || (value.operation === "send" && typeof body.include_supplement !== "boolean")) return null;
    return value as unknown as Pending;
  } catch { return null; }
}

export default function DirectDelivery(props: Props) {
  // A different approved identity/session must never reuse the previous component's private state.
  const identity = JSON.stringify([props.sessionNamespace, props.adminAccess?.identity.source_instance_id, props.adminAccess?.identity.scope, props.adminAccess?.identity.subject,
    props.adminAccess?.identity.authorization_context.context_id, props.handoff.id, props.handoff.version, props.handoff.metadata.payload_digest, props.handoff.approval_identity_kind, props.handoff.source_approval_ref]);
  return props.adminAccess ? <ContextDirectDeliveryView key={identity} {...props} adminAccess={props.adminAccess} /> : <DirectDeliveryView key={identity} {...props} />;
}

function ContextDirectDeliveryView({ handoff, adminAccess }: Props & { adminAccess: AdminContextAccess }) {
  const action = useAdminAction({ access: adminAccess, slot: `direct:${handoff.id}:${handoff.version}` });
  const binding = handoff;
  const accountBound = handoff.approval_identity_kind === "account_bound" && !!handoff.source_approval_ref?.approval_record_id;
  const [current, setCurrent] = useState<Delivery | null>(null), [loading, setLoading] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [prepared, setPrepared] = useState(false), [consent, setConsent] = useState(false), [include, setInclude] = useState(true);
  const [registered, setRegistered] = useState<EvidenceExport | null>(null);
  const alive = useRef(true), sequence = useRef(0), lock = useRef(false);
  const confirmed = useRef<Extract<Delivery, { status: "received" }> | null>(null);
  const currentRef = useRef<Delivery | null>(null);
  const controllers = useRef(new Set<AbortController>());
  function parseBoundDelivery(value: unknown): Delivery {
    const dto = parseDirectDelivery(value, binding);
    if (dto.status !== "not_started" && (dto.source_instance_id !== adminAccess.identity.source_instance_id || dto.authorized_scope !== adminAccess.identity.scope)) {
      throw new AdminError(502, "DIRECT_SCOPE_MISMATCH", "返回的直连来源或范围与当前受信身份不一致，不能展示为当前接收。");
    }
    return dto;
  }
  function fail(reason: unknown) {
    if (!alive.current || abort(reason)) return;
    setPrepared(false); setConsent(false); setError(errorMessage(reason));
    if (reason instanceof AdminError && ([401, 403].includes(reason.status) || reason.code.startsWith("ADMIN_AUTH_") || reason.code === "ADMIN_ACTION_CONTEXT_CONFLICT")) {
      setCurrent(null); currentRef.current = null; confirmed.current = null; setRegistered(null);
      adminAccess.onError(reason);
    }
  }
  async function readCurrent(): Promise<Delivery | null> {
    const n = ++sequence.current, controller = new AbortController(); controllers.current.add(controller); setLoading(true);
    try {
      const next = parseBoundDelivery(await adminAccess.read<unknown>(`handoffs/${encodeURIComponent(binding.id)}/direct-delivery`, controller.signal));
      if (!alive.current || n !== sequence.current) return null;
      const before = confirmed.current;
      if (before && (next.status !== "received" || !sameValue(before.receipt, next.receipt)
        || (before.transmission_actor_subject !== undefined && next.transmission_actor_subject !== before.transmission_actor_subject) || (before.supplement_delivery?.status === "received"
        && (next.supplement_delivery?.status !== "received" || !sameValue(before.supplement_delivery.receipt, next.supplement_delivery.receipt))))) {
        throw new AdminError(502, "DIRECT_FROZEN_CONFLICT", "读取与已核对回执不一致，不能回退或改写原接收事实。");
      }
      currentRef.current = next; setCurrent(next);
      if (next.status === "received") confirmed.current = next;
      return next;
    } catch (reason) {
      if (alive.current && n === sequence.current) { currentRef.current = null; setCurrent(null); setRegistered(null); fail(reason); }
      return null;
    } finally { controllers.current.delete(controller); if (alive.current && n === sequence.current) setLoading(false); }
  }
  const readRef = useRef(readCurrent);
  useEffect(() => { readRef.current = readCurrent; });
  useEffect(() => {
    alive.current = true;
    const timer = setTimeout(() => { if (accountBound) void readRef.current(); }, 0), running = controllers.current;
    const currentSequence = sequence;
    return () => { alive.current = false; clearTimeout(timer); currentSequence.current++; running.forEach(c => c.abort()); running.clear(); };
  }, [accountBound]);
  async function prepareIntent() {
    if (lock.current || action.busy) return;
    lock.current = true; setPrepared(false); setConsent(false); setError(""); setNotice(""); setLoading(true);
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      await adminAccess.validate();
      const fresh = await adminAccess.read<Handoff>(`handoffs/${encodeURIComponent(binding.id)}`, controller.signal);
      if (!alive.current) return;
      if (fresh.id !== binding.id || fresh.version !== binding.version || fresh.metadata?.payload_digest !== binding.metadata.payload_digest
        || fresh.approval_identity_kind !== "account_bound" || !sameValue(fresh.source_approval_ref, binding.source_approval_ref)) {
        throw new AdminError(409, "DIRECT_REVISION_CONFLICT", "当前冻结对象与原页面不一致，请回列表重新查看，未更换原动作。");
      }
      const latest = await readCurrent();
      if (alive.current && latest) { setPrepared(true); setNotice("已重新读取当前管理身份与冻结对象。请明确核对本次动作；旧操作不会被改绑。"); }
    } catch (reason) { fail(reason); }
    finally { controllers.current.delete(controller); lock.current = false; if (alive.current) setLoading(false); }
  }
  async function run(operation: "send" | "reconcile" | "supplement" | "evidence-export") {
    const previous = currentRef.current;
    if (!action.ready || action.blocked || action.metadata?.state === "pending" || !prepared || !consent || !previous || action.busy || lock.current || (previous.status !== "not_started" && previous.operation_in_progress)) return;
    lock.current = true; setPrepared(false); setConsent(false); setError(""); setNotice("");
    try {
      const suffix = operation === "evidence-export" ? operation : `direct-${operation}`;
      const business = operation === "send" ? { expected_revision: binding.version, include_supplement: previous.status === "not_started" ? include : previous.first_supplement !== null } : { expected_revision: binding.version };
      if (action.pending && !action.archive()) return;
      const completed = await action.execute(`handoffs/${encodeURIComponent(binding.id)}/${suffix}`, business);
      if (!alive.current || !completed) return;
      if (operation === "evidence-export") setRegistered(parseEvidenceExport(completed.result, binding));
      else parseBoundDelivery(completed.result);
      await readCurrent();
      if (alive.current) setNotice(operation === "evidence-export" ? "本次证据登记已记录；登记不代表发送或接收。" : "已读取当前源台账；操作metadata与模拟接收回执分别展示。");
    } catch (reason) { fail(reason); if (alive.current) await readCurrent(); }
    finally { lock.current = false; }
  }
  async function queryOperation() {
    setPrepared(false); setConsent(false); setNotice("");
    try { await action.query(); } catch (reason) { fail(reason); }
  }
  async function replay() {
    if (lock.current || action.busy || !action.canReplay) return;
    lock.current = true; setPrepared(false); setConsent(false); setNotice("");
    const kind = action.pending?.operation_kind;
    try {
      const completed = await action.replay();
      if (!alive.current || !completed) return;
      if (kind === "evidence_export") setRegistered(parseEvidenceExport(completed.result, binding)); else parseBoundDelivery(completed.result);
      await readCurrent();
      if (alive.current) setNotice("已显式回放同一原上下文、原编号和原正文；展示以重新读取的当前源台账为准。");
    } catch (reason) { fail(reason); }
    finally { lock.current = false; }
  }
  async function download() {
    if (!currentRef.current || lock.current || action.busy) return;
    lock.current = true; setLoading(true); setError("");
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      await adminAccess.validate();
      const file = await downloadEvidenceExport(binding, registered ?? currentRef.current.current_supplement ?? undefined, controller.signal);
      await adminAccess.validate();
      if (!alive.current) return;
      const url = URL.createObjectURL(file.blob), link = document.createElement("a"); link.href = url; link.download = file.fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice("冻结证据原字节与摘要校验完成；只读下载不等于新发送或新接收。");
    } catch (reason) { fail(reason); }
    finally { controllers.current.delete(controller); lock.current = false; if (alive.current) setLoading(false); }
  }
  const inProgress = current?.status !== "not_started" && current?.operation_in_progress === true;
  const busy = loading || action.busy;
  const writeDisabled = busy || !action.ready || action.blocked || action.metadata?.state === "pending" || !prepared || !consent || !current || inProgress;
  const late = current?.supplement_delivery;
  return <section className={s.root} aria-label="直接交给产品管理" aria-busy={busy}>
    <header className={s.header}><div><h3>直接交给产品管理</h3><p>本机演示 · 仅模拟接收；真实产品接收尚未验收</p></div><span className={s.badge}>原会话操作</span></header>
    <dl className={s.facts}><div><dt>原批准人</dt><dd>{handoff.metadata.approved_by ?? "历史未记录"}</dd></div><div><dt>原传输人</dt><dd>{current?.transmission_actor_subject ?? (current?.status === "not_started" && Object.hasOwn(current, "transmission_actor_subject") ? "尚未传输" : "历史未记录")}</dd></div><div><dt>本次操作人</dt><dd>{action.metadata?.actor_subject ?? "尚未读取本次操作记录"}</dd></div><div><dt>当前管理者</dt><dd>{adminAccess.identity.subject}</dd></div><div><dt>批准记录引用</dt><dd>{handoff.source_approval_ref?.approval_record_id ?? "历史未记录"}</dd></div></dl>
    {!accountBound ? <p className={s.notice}>历史批准缺少账户绑定，不能补签或直接发送；原历史保留。</p> : <>
      <div className={s.actions}><button disabled={busy} onClick={() => { setPrepared(false); setConsent(false); setError(""); void readCurrent(); }}>读取当前状态</button><button disabled={busy} onClick={() => void prepareIntent()}>重新读取身份和冻结对象</button></div>
      <p className={s.small}>当前状态与个人操作查询均为只读。404不证明目标未收到；对账是另一个明确管理动作，不会自动执行。</p>
      {(error || action.error) && <p className={s.error} role="alert">{error || action.error}</p>}{notice && <p className={s.notice} role="status">{notice}</p>}
      {action.blocked && <button disabled={busy} onClick={() => { action.archive(); setPrepared(false); setConsent(false); }}>明确结束损坏的本地记录（不发送）</button>}
      {current && <>
        <p className={current.status === "received" ? s.success : s.notice}><strong>{current.status === "received" ? "本机模拟直接接收回执已确认" : stateLabel[current.status]}</strong></p>
        {current.status !== "not_started" && <><dl className={s.facts}><div><dt>直接交接记录</dt><dd>{current.delivery_id}</dd></div><div><dt>源 → 目标</dt><dd>{current.source_instance_id} → {current.target_instance_id}</dd></div></dl><p>首次冻结证据：{current.first_supplement?.supplement_id ?? "首次未附带冻结证据（null）"}</p>{current.last_error && <p className={s.error}>{directErrorMessage(current.last_error)}（{current.last_error}）</p>}</>}
        {current.status === "received" && <details><summary>查看首次模拟接收回执</summary><pre>{JSON.stringify(current.receipt, null, 2)}</pre></details>}
        {inProgress && <p className={s.notice}>原传输仍在途，仅可查询，不能重复执行。</p>}
        {current.status === "not_started" && <label className={s.check}><input type="checkbox" checked={include} disabled={busy} onChange={e => { setInclude(e.target.checked); setConsent(false); }} />首次发送附带批准时的冻结证据</label>}
        <label className={s.check}><input type="checkbox" checked={consent} disabled={!prepared || busy} onChange={e => setConsent(e.target.checked)} />我已核对当前身份、冻结版本和本次动作，明确提出新操作</label>
        {current.status === "unconfirmed" && <p className={s.notice}>目标可能已经接收。请先查询原操作；如需核实目标，请重新核对并明确新建对账动作，不重新发送。</p>}
        <div className={s.actions}>{current.status === "not_started" && <button className={s.primary} disabled={writeDisabled} onClick={() => void run("send")}>明确发送此冻结版本</button>}{current.status !== "not_started" && <button disabled={writeDisabled} onClick={() => void run("reconcile")}>以当前上下文新建对账动作</button>}<button disabled={writeDisabled} onClick={() => void run("evidence-export")}>登记冻结证据补充</button><button disabled={busy} onClick={() => void download()}>下载原始冻结证据</button>{current.status === "received" && current.first_supplement === null && late?.status !== "received" && <button disabled={writeDisabled} onClick={() => void run("supplement")}>明确追加冻结证据</button>}</div>
        {registered && <p>已登记 {registered.supplement_id}；原批准事实不变。</p>}
        {late && <div className={late.status === "received" ? s.success : s.notice}><strong>{late.status === "received" ? "本机模拟晚补回执已确认" : "晚补接收尚未确认"}</strong><p>首次回执保持null；独立补充 {late.supplement_id}</p>{late.status === "received" && <details><summary>查看独立模拟补充回执</summary><pre>{JSON.stringify(late.receipt, null, 2)}</pre></details>}</div>}
        <details><summary>直接交接尝试 · {current.attempts.length} 次</summary>{current.attempts.map(item => <article className={s.attempt} key={item.attempt_id}>{item.operation} · {item.status === "not_sent" ? "出网前停止，未发出" : item.status} {item.error_code && `（${item.error_code}）`}</article>)}</details>
      </>}
      {action.pending && <section className={s.pending}><strong>原会话操作</strong><p>{action.pending.request_id}</p><p>原编号、原会话与正文保持。查不到、历史未绑定或仍在处理的操作只能查询；新操作必须重新核对并明确同意。</p><div className={s.actions}><button disabled={busy} onClick={() => void queryOperation()}>只读查询原操作</button><button disabled={busy || !action.canReplay} onClick={() => void replay()}>明确回放原上下文原动作</button></div></section>}
      {action.metadata && <section className={s.notice}><p>原操作 {action.metadata.request_id} · {action.metadata.state} · {action.metadata.actor_subject}</p><p>{action.metadata.outcome === "reused_frozen" ? "本次仅复用既有冻结批准，不是当前管理者重新批准。" : "操作完成状态不代替首次或晚补的严格接收回执。"}</p><p>{action.metadata.context_binding === "legacy_unbound" ? "历史动作未绑定新上下文，仅可只读恢复。" : "原上下文归属由服务端metadata提供。"}</p></section>}
    </>}
  </section>;
}

function DirectDeliveryView({ handoff, sessionNamespace, onAuthError }: Props) {
  const binding = useMemo<DirectHandoffBinding>(() => ({ id: handoff.id, version: handoff.version, metadata: handoff.metadata,
    approval_identity_kind: handoff.approval_identity_kind, source_approval_ref: handoff.source_approval_ref }),
  // The outer identity key remounts on every immutable binding change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []);
  const key = pendingKey(sessionNamespace, binding);
  const accountBound = handoff.approval_identity_kind === "account_bound" && !!handoff.source_approval_ref?.approval_record_id;
  const [current, setCurrent] = useState<Delivery | null>(null);
  const [loading, setLoading] = useState(accountBound), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [includeSupplement, setIncludeSupplement] = useState(true);
  const [registered, setRegistered] = useState<EvidenceExport | null>(null);
  const [blocked, setBlocked] = useState(false);
  const active = useRef(true), lock = useRef(false), readSequence = useRef(0);
  const currentRef = useRef<Delivery | null>(null), pendingRef = useRef<Pending | null>(null);
  // A failed read hides the visible state, but cannot erase immutable facts already verified for this identity.
  const confirmedRef = useRef<Extract<Delivery, { status: "received" }> | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const setPendingAction = (value: Pending | null) => { pendingRef.current = value; setPending(value); };
  const signal = () => { const controller = new AbortController(); controllers.current.add(controller); return controller; };
  function showError(reason: unknown) {
    if (!active.current || abort(reason)) return;
    setError(errorMessage(reason));
    if (reason instanceof AdminError && (reason.status === 401 || reason.status === 403)) {
      setCurrent(null); currentRef.current = null; confirmedRef.current = null; setRegistered(null); setPendingAction(null); setBlocked(true);
      onAuthError?.(reason);
    }
  }
  async function readCurrent(): Promise<Delivery | null> {
    const sequence = ++readSequence.current;
    const controller = signal();
    setLoading(true);
    try {
      const next = await getDirectDelivery(binding, controller.signal);
      if (!active.current || sequence !== readSequence.current) return null;
      const before = confirmedRef.current;
      if (before?.status === "received" && (next.status !== "received" || !sameValue(before.receipt, next.receipt)
        || (before.supplement_delivery?.status === "received" && (next.supplement_delivery?.status !== "received"
          || !sameValue(before.supplement_delivery.receipt, next.supplement_delivery.receipt))))) {
        throw new AdminError(502, "DIRECT_FROZEN_CONFLICT", "当前读取与已确认回执不一致，暂停展示接收结论，请联系后端核对。");
      }
      currentRef.current = next; setCurrent(next); setBlocked(false);
      if (next.status === "received") confirmedRef.current = next;
      // Pending IDs are only exposed after the server authorizes the current frozen identity.
      const saved = pendingRef.current ?? readPending(key, binding.version);
      setPendingAction(saved);
      if (saved?.operation === "send") setIncludeSupplement(saved.body.include_supplement);
      return next;
    } catch (reason) {
      if (active.current && sequence === readSequence.current && !abort(reason)) {
        currentRef.current = null; setCurrent(null); setRegistered(null); setPendingAction(null);
        showError(reason);
      }
      return null;
    } finally {
      controllers.current.delete(controller);
      if (active.current && sequence === readSequence.current) setLoading(false);
    }
  }
  const readRef = useRef(readCurrent);
  useEffect(() => { readRef.current = readCurrent; });
  useEffect(() => {
    active.current = true;
    const timer = setTimeout(() => { if (accountBound) void readRef.current(); }, 0);
    const running = controllers.current;
    const sequence = readSequence;
    return () => { active.current = false; clearTimeout(timer); sequence.current++; running.forEach(c => c.abort()); running.clear(); };
  }, [accountBound]);

  function persist(value: Pending): boolean {
    try { sessionStorage.setItem(key, JSON.stringify(value)); setPendingAction(value); return true; }
    catch { setError("浏览器无法保留原动作编号，尚未发出请求。请恢复会话存储后再试。"); return false; }
  }
  function finish() {
    try { sessionStorage.removeItem(key); } catch { /* An explicit replay remains idempotent. */ }
    setPendingAction(null);
  }
  async function perform(operation: Pending["operation"], retry = false) {
    if (lock.current || blocked || !currentRef.current) return;
    if ((!retry && pendingRef.current) || (currentRef.current.status !== "not_started" && currentRef.current.operation_in_progress)) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    const controller = signal();
    try {
      // Even an explicit retry first reads the original ledger. It never changes the frozen body.
      if (retry) {
        const latest = await readCurrent();
        if (!latest || (latest.status !== "not_started" && latest.operation_in_progress)) return;
      }
      if (!active.current) return;
      const latest = currentRef.current;
      if (!latest) return;
      const value = retry ? pendingRef.current : operation === "send"
        ? { operation, body: { request_id: crypto.randomUUID(), expected_revision: binding.version,
          include_supplement: latest.status === "not_started" ? includeSupplement : latest.first_supplement !== null } } satisfies Pending
        : { operation, body: { request_id: crypto.randomUUID(), expected_revision: binding.version } } satisfies Pending;
      if (!value || !persist(value)) return;
      if (value.operation === "send") await sendDirectHandoff(binding, value.body, controller.signal);
      else if (value.operation === "reconcile") await reconcileDirectHandoff(binding, value.body, controller.signal);
      else await appendDirectSupplement(binding, value.body, controller.signal);
      if (!active.current) return;
      // An idempotent action result can be old; only a fresh ledger GET may update the visible state.
      const after = await readCurrent();
      if (after) { finish(); setNotice("动作已完成，已重新读取当前台账；接收结论以下方当前回执为准。"); }
    } catch (reason) {
      if (!active.current || abort(reason)) return;
      showError(reason);
      if (!(reason instanceof AdminError && [401, 403].includes(reason.status))) {
        await readCurrent();
        if (active.current) setNotice("原动作编号与内容已保留。已尝试只读查询；请核对当前状态后再明确重试。");
      }
    } finally {
      controllers.current.delete(controller);
      if (active.current) { setBusy(false); lock.current = false; }
    }
  }
  async function evidence(download: boolean) {
    if (lock.current || blocked || !currentRef.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    const controller = signal();
    try {
      if (download) {
        const expected = registered ?? currentRef.current.current_supplement ?? (currentRef.current.status !== "not_started" ? currentRef.current.first_supplement ?? undefined : undefined);
        const file = await downloadEvidenceExport(binding, expected, controller.signal);
        if (!active.current) return;
        const url = URL.createObjectURL(file.blob), link = document.createElement("a");
        link.href = url; link.download = file.fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
        setNotice("已下载并校验原始冻结证据文件；下载不代表发送或接收。");
      } else {
        const result = await registerEvidenceExport(binding, controller.signal);
        if (!active.current) return;
        setRegistered(result); setNotice("冻结证据已登记；尚未因此发送或追加。请核对后明确操作。");
        await readCurrent();
      }
    } catch (reason) { showError(reason); }
    finally { controllers.current.delete(controller); if (active.current) { setBusy(false); lock.current = false; } }
  }
  function archivePending() {
    if (!pending || !current || loading || busy || blocked) return;
    try {
      sessionStorage.setItem(`${key}:archive:${pending.body.request_id}`, JSON.stringify(pending));
      finish(); setNotice("原动作已留档。请人工核对后重新选择；新动作不会修复冻结身份或修订冲突。");
    } catch { setError("原动作未能留档，仍保留当前动作，请勿重复创建。"); }
  }
  const inProgress = current?.status !== "not_started" && current?.operation_in_progress === true;
  const disabled = busy || loading || blocked || !current || inProgress;
  const firstMissing = current?.status === "received" && current.first_supplement === null;
  const late = current?.supplement_delivery;
  const canAppend = firstMissing && late?.status !== "received";
  const first = current?.status !== "not_started" ? current?.first_supplement : undefined;

  return <section className={s.root} aria-label="直接交给产品管理" aria-busy={loading || busy}>
    <header className={s.header}><div><h3>直接交给产品管理</h3><p>本机隔离技术验证 · 合成需求 · 非伙伴真实接收</p></div><span className={s.badge}>独立直连台账</span></header>
    <dl className={s.facts}><div><dt>批准身份</dt><dd>{handoff.approval_identity_kind === "account_bound" ? "账户绑定（account_bound）" : handoff.approval_identity_kind === "legacy_shared_role" ? "历史共享角色（legacy_shared_role）" : "历史未记录"}</dd></div><div><dt>批准记录引用</dt><dd>{handoff.source_approval_ref?.approval_record_id ?? "历史未记录"}</dd></div></dl>
    {!accountBound ? <p className={s.notice}>历史批准缺少账户绑定来源，不能补造引用或直接发送。原冻结包和旧发送记录保留。</p> : <>
      <div className={s.actions}><button disabled={busy || loading} onClick={() => { setError(""); setNotice(""); void readCurrent(); }}>读取当前状态</button><span>直连状态需点此读取；不会向产品管理发送。</span></div>
      {loading && <p role="status">正在读取直接交接台账…</p>}
      {error && <p className={s.error} role="alert">{error}</p>}
      {notice && <p className={s.notice} role="status">{notice}</p>}
      {current && <>
        <div className={current.status === "received" ? s.success : s.notice}><strong>{stateLabel[current.status]}</strong>{current.status === "unconfirmed" && <p>尚无已核对的产品管理回执。HTTP 成功或旧发送已接收均不能替代直接接收确认。</p>}</div>
        {current.status !== "not_started" && <>
          <dl className={s.facts}><div><dt>直接交接记录</dt><dd>{current.delivery_id}</dd></div><div><dt>源 → 目标</dt><dd>{current.source_instance_id} → {current.target_instance_id}</dd></div><div><dt>授权范围</dt><dd>{current.authorized_scope}</dd></div></dl>
          <p>首次冻结证据：{first ? first.supplement_id : "首次未附带冻结证据（null）"}</p>
          {current.last_error && <p className={s.error}>{directErrorMessage(current.last_error)}（{current.last_error}）</p>}
          {inProgress && <p className={s.notice}>操作仍在途，请约 {current.retry_after_seconds} 秒后读取当前状态。当前禁用重复操作。</p>}
        </>}
        {current.status === "received" && <details><summary>查看首次直接接收回执</summary><p>接收时间 {time(current.receipt.received_at)} · {current.receipt.direct_receive_id}</p><pre>{JSON.stringify(current.receipt, null, 2)}</pre></details>}
        {current.status === "not_started" && <label className={s.check}><input type="checkbox" checked={includeSupplement} disabled={disabled || !!pending} onChange={event => setIncludeSupplement(event.target.checked)} />首次发送附带批准时的冻结证据</label>}
        <div className={s.actions}>
          {(current.status === "not_started" || current.status === "unconfirmed") && <button className={s.primary} disabled={disabled || !!pending} onClick={() => void perform("send")}>{current.status === "not_started" ? "发送此冻结版本" : "显式重试原冻结交接"}</button>}
          {current.status !== "not_started" && <button disabled={disabled || !!pending} onClick={() => void perform("reconcile")}>查询产品管理对账</button>}
        </div>
        <p className={s.small}>查询对账只查询原身份。后端查不到仍为待确认；重试不会新建交接包或改写首次信封。</p>
        {pending && <div className={s.pending}><strong>待核对原动作：{operationLabel[pending.operation]}</strong><p>动作编号 {pending.body.request_id} · 固定修订 v{pending.body.expected_revision}</p>{pending.operation === "send" && <p>原选择：{pending.body.include_supplement ? "首次附带冻结证据" : "首次不附带冻结证据"}</p>}<div className={s.actions}><button disabled={disabled} onClick={() => void perform(pending.operation, true)}>按原编号重试此动作</button><button disabled={disabled} onClick={archivePending}>存档原动作并重新选择</button></div></div>}
        <section className={s.supplement} aria-label="冻结证据补充"><h4>冻结证据补充</h4><p>只从批准当时的冻结出处登记与下载，不用当前来源补历史。</p>
          <div className={s.actions}><button disabled={disabled || !!pending} onClick={() => void evidence(false)}>登记冻结证据补充</button><button disabled={disabled} onClick={() => void evidence(true)}>下载原始冻结证据</button>{canAppend && <button disabled={disabled || !!pending} onClick={() => void perform("supplement")}>{late?.status === "unconfirmed" ? "显式重试原补充" : "明确追加冻结证据"}</button>}</div>
          {registered && <p>已登记 {registered.supplement_id} · {registered.rule_version}</p>}
          {current.current_supplement && <p>台账当前补充引用：{current.current_supplement.supplement_id}</p>}
          {firstMissing && <p className={s.small}>首次回执中的补充仍为 null；后补采用独立接收回执，不改首次接收事实。</p>}
          {late && <div className={late.status === "received" ? s.success : s.notice}><strong>{late.status === "received" ? "后补冻结证据接收已确认" : late.status === "sending" ? "后补冻结证据发送中" : "后补冻结证据接收待确认"}</strong><p>{late.supplement_id}</p>{late.last_error && <p>{directErrorMessage(late.last_error)}（{late.last_error}）</p>}{late.status === "received" && <details><summary>查看独立补充回执</summary><pre>{JSON.stringify(late.receipt, null, 2)}</pre></details>}</div>}
        </section>
        <details><summary>直接交接尝试 · {current.attempts.length} 次</summary>{current.attempts.length ? current.attempts.map(item => <article className={s.attempt} key={item.attempt_id}><strong>{item.operation === "lookup" ? "原身份查询" : item.operation === "supplement" ? "冻结证据补充" : "直接发送"} · {item.status === "received" ? "回执已确认" : item.status === "sending" ? "在途" : "待确认"}</strong><p>{time(item.started_at)} → {time(item.finished_at)}</p><small>{item.attempt_id}</small>{item.error_code && <p>{directErrorMessage(item.error_code)}（{item.error_code}）</p>}</article>) : <p>暂无直接交接尝试。读取和下载不会创建发送尝试。</p>}</details>
      </>}
    </>}
  </section>;
}
