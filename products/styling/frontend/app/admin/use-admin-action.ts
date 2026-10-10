"use client";

import { useEffect, useRef, useState } from "react";
import { AdminError } from "../lib/admin-api";
import { adminIdentityNamespace, adminOperationMatchesAction, canReplayAdminAction, createAdminAction, executeAdminAction, getAdminOperation, parseStoredAdminAction, serializeAdminAction, type AdminAction, type AdminIdentity, type AdminOperation } from "../lib/admin-context";
import type { AdminContextAccess } from "./AdminContextBoundary";

const prefix = (identity: AdminIdentity) => `styling.admin-context.private.v1:${encodeURIComponent(adminIdentityNamespace(identity))}:`;
const refsKey = (identity: AdminIdentity) => `styling.admin-context.references.v1:${encodeURIComponent(JSON.stringify([identity.source_instance_id, identity.scope, identity.subject]))}`;
export type AdminSafeReference = { request_id: string; operation_kind: AdminOperation["operation_kind"] };
export function clearAdminPrivateCache(identity: AdminIdentity | null): void {
  const ownerPrefix = identity ? prefix(identity) : "styling.admin-context.private.v1:";
  try { Object.keys(sessionStorage).filter(key => key.startsWith(ownerPrefix)).forEach(key => sessionStorage.removeItem(key)); } catch { /* The private UI is cleared regardless of storage availability. */ }
}
export function readAdminSafeReferences(identity: AdminIdentity): AdminSafeReference[] {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(refsKey(identity)) ?? "[]");
    return Array.isArray(data) ? data.filter((value): value is AdminSafeReference => value !== null && typeof value === "object"
      && Object.keys(value).length === 2 && typeof value.request_id === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value.request_id)
      && ["approve", "reject", "retry", "logout", "evidence_export", "direct_send", "direct_reconcile", "direct_supplement"].includes(value.operation_kind)).slice(-30) : [];
  } catch { return []; }
}
function rememberReference(identity: AdminIdentity, action: AdminAction) {
  const old = readAdminSafeReferences(identity).filter(value => value.request_id !== action.request_id);
  sessionStorage.setItem(refsKey(identity), JSON.stringify([...old, { request_id: action.request_id, operation_kind: action.kind }].slice(-30)));
}
export function readAdminNote(identity: AdminIdentity, slot: string): string {
  try { const value = sessionStorage.getItem(`${prefix(identity)}note:${slot}`); return value && value.length <= 500 ? value : ""; } catch { return ""; }
}
export function saveAdminNote(identity: AdminIdentity, slot: string, note: string) {
  try { if (note) sessionStorage.setItem(`${prefix(identity)}note:${slot}`, note); else sessionStorage.removeItem(`${prefix(identity)}note:${slot}`); } catch { /* Unsaved text stays visible in this authorized view. */ }
}

export type AdminActionResult = { result: Record<string, unknown>; operation: AdminOperation | null };
export function useAdminAction({ access, slot }: { access: AdminContextAccess | null; slot: string }) {
  const [pending, setPending] = useState<AdminAction | null>(null);
  const [metadata, setMetadata] = useState<AdminOperation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [replayAllowed, setReplayAllowed] = useState(false);
  const [ready, setReady] = useState(false), [blocked, setBlocked] = useState(false);
  const readyRef = useRef(false), blockedRef = useRef(false), metadataRef = useRef<AdminOperation | null>(null), queriedRef = useRef(false);
  const active = useRef(false), locked = useRef(false), pendingRef = useRef<AdminAction | null>(null), revision = useRef(0);
  const key = access ? `${prefix(access.identity)}action:${slot}` : null;
  const accessRef = useRef(access);
  useEffect(() => { accessRef.current = access; });
  useEffect(() => {
    active.current = true; readyRef.current = false; pendingRef.current = null; queriedRef.current = false;
    const sequence = ++revision.current;
    const timer = setTimeout(() => {
      if (sequence !== revision.current) return;
      if (!key || !accessRef.current) { readyRef.current = true; setReady(true); return; }
      try {
        const stored = sessionStorage.getItem(key);
        const action = stored ? parseStoredAdminAction(stored, accessRef.current.identity) : null;
        if (stored && !action) throw new Error("Invalid stored action");
        pendingRef.current = action; setPending(action); metadataRef.current = null; setMetadata(null); setReplayAllowed(false);
        blockedRef.current = false; setBlocked(false);
      } catch { blockedRef.current = true; setBlocked(true); setError("原动作读取失败，不能自动新建或重新发送。请通过安全引用查询，再明确结束本地记录并重新核对。"); }
      finally { readyRef.current = true; setReady(true); }
    }, 0);
    const current = revision;
    return () => { active.current = false; clearTimeout(timer); current.current++; };
  }, [key]);
  const stillHere = (sequence: number) => active.current && sequence === revision.current;
  function report(reason: unknown, sequence: number) {
    if (!stillHere(sequence) || (reason instanceof DOMException && reason.name === "AbortError")) return;
    setError(reason instanceof Error ? reason.message : "管理操作未确认，请先查询原操作。");
    setReplayAllowed(false);
    if (reason instanceof AdminError && [401, 403].includes(reason.status)) { pendingRef.current = null; setPending(null); metadataRef.current = null; setMetadata(null); }
    accessRef.current?.onError(reason);
  }
  async function inspect(action: AdminAction, sequence: number): Promise<AdminOperation> {
    const current = accessRef.current;
    if (!current) throw new AdminError(503, "ADMIN_AUTH_UNAVAILABLE", "可信管理身份尚未就绪。");
    const identity = await current.validate();
    const operation = await getAdminOperation(action.request_id, identity);
    await current.validate();
    if (!stillHere(sequence)) throw new DOMException("Inactive management view", "AbortError");
    if (!await adminOperationMatchesAction(action, identity, operation)) throw new AdminError(200, "INVALID_ADMIN_RESPONSE", "原操作元数据与保存的内容或管理范围不一致，不能判断成功或重放，请查询原事实。 ");
    const allowed = await canReplayAdminAction(action, identity, operation);
    if (!stillHere(sequence)) throw new DOMException("Inactive management view", "AbortError");
    queriedRef.current = true; metadataRef.current = operation; setMetadata(operation); setReplayAllowed(allowed);
    return operation;
  }
  async function execute(path: string, businessBody: Record<string, unknown> = {}): Promise<AdminActionResult> {
    if (!readyRef.current || blockedRef.current || locked.current || pendingRef.current || !accessRef.current || !key) throw new AdminError(409, "ADMIN_ACTION_IN_PROGRESS", "请先查询并明确结束原动作，再重新核对当前操作。");
    locked.current = true; setBusy(true); setError(""); metadataRef.current = null; setMetadata(null); setReplayAllowed(false);
    const sequence = revision.current;
    try {
      const current = accessRef.current;
      const identity = await current.validate();
      if (!stillHere(sequence)) throw new DOMException("Inactive management view", "AbortError");
      const action = createAdminAction(identity, path, businessBody);
      try { sessionStorage.setItem(key, serializeAdminAction(action)); rememberReference(identity, action); }
      catch { throw new AdminError(503, "ADMIN_LOCAL_STORAGE_UNAVAILABLE", "浏览器无法保留原动作，尚未提交；请恢复会话存储后重试。"); }
      pendingRef.current = action; setPending(action);
      const result = await executeAdminAction(action);
      if (action.kind === "logout") {
        if (stillHere(sequence)) { current.logout(); }
        // Logout revokes its own session; never perform a protected post-success lookup with the revoked cookie.
        return { result, operation: null };
      }
      const operation = await inspect(action, sequence);
      requireCompleted(operation, action, result);
      return { result, operation };
    } catch (reason) { report(reason, sequence); throw reason; }
    finally { if (stillHere(sequence)) { locked.current = false; setBusy(false); } }
  }
  async function query(): Promise<AdminOperation | null> {
    if (locked.current || !pendingRef.current) return null;
    locked.current = true; setBusy(true); setError(""); setReplayAllowed(false); const sequence = revision.current;
    try { return await inspect(pendingRef.current, sequence); }
    catch (reason) { if (stillHere(sequence)) { setMetadata(null); if (reason instanceof AdminError && reason.status === 404) queriedRef.current = true; } report(reason, sequence); return null; }
    finally { if (stillHere(sequence)) { locked.current = false; setBusy(false); } }
  }
  async function replay(): Promise<AdminActionResult> {
    if (locked.current || !pendingRef.current || !accessRef.current) throw new AdminError(409, "ADMIN_ACTION_IN_PROGRESS", "请先查询原动作。");
    locked.current = true; setBusy(true); setError(""); const sequence = revision.current;
    try {
      const action = pendingRef.current, current = accessRef.current;
      const operation = await inspect(action, sequence);
      const identity = await current.validate();
      if (!await canReplayAdminAction(action, identity, operation) || !stillHere(sequence)) throw new AdminError(409, "ADMIN_ACTION_CONTEXT_CONFLICT", "此原动作只能查询；请明确重新核对后再提出新操作。");
      const result = await executeAdminAction(action);
      const after = await inspect(action, sequence);
      requireCompleted(after, action, result);
      return { result, operation: after };
    } catch (reason) { report(reason, sequence); throw reason; }
    finally { if (stillHere(sequence)) { locked.current = false; setBusy(false); } }
  }
  function requireCompleted(operation: AdminOperation, action: AdminAction, result: Record<string, unknown>) {
    if (operation.state !== "completed") throw new AdminError(409, "ADMIN_ACTION_NOT_COMPLETED", operation.state === "pending" ? "原操作仍在处理中，只能继续查询。" : "原操作未确认成功，请查询原事实和当前对象，不会自动再次提交。");
    if (action.kind === "approve" && (!["created", "reused_frozen"].includes(operation.outcome ?? "") || (operation.result_ref !== null && (operation.result_ref.kind !== "handoff" || operation.result_ref.id !== result.id || (operation.result_ref.revision !== null && operation.result_ref.revision !== result.version))))) throw new AdminError(200, "INVALID_ADMIN_RESPONSE", "批准结果与原操作引用不一致，不能显示为批准成功，请查询原事实。 ");
    const ref = operation.result_ref;
    const expected = action.kind === "reject" ? { kind: "demand_occurrence", id: decodeURIComponent(action.path.split("/")[1]), revision: result.revision }
      : action.kind === "retry" ? { kind: "demand_turn", id: result.id, revision: null }
      : action.kind === "evidence_export" ? { kind: "frozen_evidence", id: result.supplement_id, revision: result.revision }
      : action.kind.startsWith("direct_") ? { kind: "direct_delivery", id: result.delivery_id, revision: result.revision } : null;
    if (expected && ref && (ref.kind !== expected.kind || ref.id !== expected.id || (typeof expected.revision === "number" && ref.revision !== null && ref.revision !== expected.revision))) throw new AdminError(200, "INVALID_ADMIN_RESPONSE", "业务结果与原操作引用不一致，不能显示为操作成功，请查询原事实。");
  }
  function archive() {
    if (locked.current || !key) return false;
    if (metadataRef.current?.state === "pending" || (pendingRef.current && !queriedRef.current)) { setError("请先查询原操作状态；原操作处理中只能继续查询，不能开启替代动作。"); return false; }
    if (!pendingRef.current && !blockedRef.current) return true;
    // The immutable body stays in its original private namespace, while the safe ID remains queryable by its owner.
    try {
      const original = sessionStorage.getItem(key);
      if (original) sessionStorage.setItem(`${key}:archive:${pendingRef.current?.request_id ?? "unverified"}`, original);
      sessionStorage.removeItem(key); queriedRef.current = false; blockedRef.current = false; setBlocked(false); pendingRef.current = null; setPending(null); metadataRef.current = null; setMetadata(null); setReplayAllowed(false); setError(""); return true;
    } catch { setError("原动作未能留档，不能开始新操作。"); return false; }
  }
  return { pending, metadata, busy, error, ready, blocked, execute, query, replay, archive, canReplay: replayAllowed };
}
