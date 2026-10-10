"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { adminApi, AdminError } from "../lib/admin-api";
import { appPath } from "../lib/app-path";
import { fetchAdminMe, readAdminContextResource, adminIdentityNamespace, sameAdminIdentity, type AdminIdentity } from "../lib/admin-context";
import { clearAdminPrivateCache } from "./use-admin-action";
import s from "./admin.module.css";
import { useDemoAccess } from "@/components/demo-access-boundary";

export interface AdminContextAccess {
  identity: AdminIdentity;
  namespace: string;
  validate: () => Promise<AdminIdentity>;
  read: <T>(path: string, signal?: AbortSignal) => Promise<T>;
  onError: (error: unknown) => void;
  logout: () => void;
}
export const isAdminContextConflict = (error: unknown) => error instanceof AdminError && [
  "ADMIN_AUTH_CONTEXT_CHANGED", "ADMIN_ACTION_CONTEXT_CONFLICT", "ADMIN_ACTION_BODY_CONFLICT", "ADMIN_ACTION_LEGACY_UNBOUND",
].includes(error.code);
const aborted = () => new DOMException("The previous management view is no longer active", "AbortError");

export default function AdminContextBoundary({ workspace: Workspace }: { workspace: React.ComponentType<{ adminAccess: AdminContextAccess }> }) {
  const demo = useDemoAccess();
  function assertMode(value: AdminIdentity) {
    if (demo && (demo.capability.mode !== "authenticated"
      ? value.auth_method !== "demo_server" || (demo.capability.mode === "local_demo" && value.subject !== "styling-demo-manager")
      : value.auth_method === "demo_server")) throw new AdminError(403, "ADMIN_AUTH_UNAVAILABLE", "管理身份与服务端访问模式不一致，工作区已关闭。");
  }
  const [identity, setIdentity] = useState<AdminIdentity | null>(null);
  const [phase, setPhase] = useState<"checking" | "ready" | "login" | "unavailable">("checking");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0), live = useRef(false), meSequence = useRef(0);
  const identityRef = useRef<AdminIdentity | null>(null);

  function fail(reason: unknown, identityReadFailed = false) {
    const invalid = reason instanceof AdminError && (reason.status === 401 || reason.status === 403
      || reason.code === "ADMIN_AUTH_CONTEXT_CHANGED" || reason.code === "ADMIN_AUTH_UNAVAILABLE");
    if (!live.current || (!invalid && !identityReadFailed)) return;
    const failure = reason instanceof AdminError ? reason : new AdminError(503, "ADMIN_AUTH_UNAVAILABLE", "可信管理身份读取失败，工作区已关闭，请重新读取。");
    if (failure.status === 401 || failure.status === 403) clearAdminPrivateCache(null);
    epoch.current++; meSequence.current++; identityRef.current = null; setIdentity(null);
    if (demo) { clearAdminPrivateCache(null); demo.invalidate(); return; }
    setPhase(failure.status === 401 ? "login" : "unavailable");
    setError(failure.code === "ADMIN_AUTH_CONTEXT_CHANGED"
      ? "管理会话已变化，原会话操作需重新核对。安全说明与原动作引用保留在原范围；不会带入后来会话或自动提交。"
      : failure.message);
  }
  async function refreshIdentity() {
    const sequence = ++meSequence.current;
    setBusy(true); setError("");
    try {
      const next = await fetchAdminMe();
      if (!live.current || sequence !== meSequence.current) return;
      assertMode(next);
      epoch.current++; identityRef.current = next; setIdentity(next); setPhase("ready");
    } catch (reason) {
      if (!live.current || sequence !== meSequence.current) return;
      epoch.current++; if (reason instanceof AdminError && [401, 403].includes(reason.status)) clearAdminPrivateCache(null); identityRef.current = null; setIdentity(null);
      if (demo && demo.capability.mode !== "authenticated") { demo.invalidate(); return; }
      setPhase(reason instanceof AdminError && (reason.status === 401 || demo && reason.status === 403) ? "login" : "unavailable");
      setError(reason instanceof Error ? reason.message : "可信管理身份读取失败，未打开私有工作区。");
    } finally { if (live.current && sequence === meSequence.current) setBusy(false); }
  }
  const refreshRef = useRef(refreshIdentity);
  useEffect(() => { refreshRef.current = refreshIdentity; });
  useEffect(() => {
    live.current = true;
    const timer = setTimeout(() => { void refreshRef.current(); }, 0);
    const currentEpoch = epoch, sequence = meSequence;
    return () => { live.current = false; clearTimeout(timer); currentEpoch.current++; sequence.current++; };
  }, []);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (demo && demo.capability.mode !== "authenticated") { demo.invalidate(); return; }
    if (busy) return;
    setBusy(true); setError("");
    try {
      await adminApi("login", { password });
      if (!live.current) return;
      setPassword(""); await refreshIdentity();
    } catch (reason) { if (live.current) { setError(reason instanceof Error ? reason.message : "登录失败"); setBusy(false); } }
  }

  if (phase !== "ready" || !identity) return <main className={s.login}><div className={s.loginCard}>
    <span className={s.brand}><ShieldCheck size={22} /> STYLING / ADMIN</span><h1>穿搭需求管理台</h1>
    <p>先核对当前管理身份，再打开需求与审批工作区。</p>
    {phase === "login" ? <form onSubmit={login}><label htmlFor="admin-context-password">管理员密码</label><input id="admin-context-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" maxLength={256} required /><button disabled={busy}>{busy ? "正在核对管理身份…" : "登录并核对管理身份"}</button></form>
      : phase === "checking" ? <p role="status">正在读取可信管理身份…</p> : <button disabled={busy} onClick={() => void refreshIdentity()}>重新读取当前管理身份</button>}
    {error && <p role="alert" className={s.error}>{error}</p>}
    <p className={s.muted}>此入口要求管理上下文契约；读取失败不会降级到旧写入方式。</p>
    <a href={appPath("/")} target="_blank" rel="noopener noreferrer">消费者窗口 ↗</a>
  </div></main>;

  const expected = identity;
  const isCurrent = () => live.current && identityRef.current === expected;
  async function validate(): Promise<AdminIdentity> {
    if (!isCurrent()) throw aborted();
    try {
      const current = await fetchAdminMe();
      if (!isCurrent()) throw aborted();
      assertMode(current);
      if (!sameAdminIdentity(expected, current)) throw new AdminError(409, "ADMIN_AUTH_CONTEXT_CHANGED", "管理会话已变化，原会话操作需重新核对。");
      return current;
    } catch (reason) { if (isCurrent()) fail(reason, true); throw reason; }
  }
  const access: AdminContextAccess = {
    identity, namespace: adminIdentityNamespace(identity), validate,
    read: async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
      await validate();
      try {
        const result = await readAdminContextResource(path, signal);
        await validate();
        return result as T;
      } catch (reason) { if (isCurrent()) fail(reason); throw reason; }
    },
    onError: reason => { if (isCurrent()) fail(reason); },
    logout: () => {
      if (!isCurrent()) return;
      clearAdminPrivateCache(null); epoch.current++; meSequence.current++; identityRef.current = null;
      if (demo && demo.capability.mode !== "authenticated") { demo.end(); return; }
      setIdentity(null); setPhase("login"); setError("");
    },
  };
  return <div key={access.namespace}><Workspace adminAccess={access} /></div>;
}
