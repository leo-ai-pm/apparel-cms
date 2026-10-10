"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { enterDemo, fetchDemoCapability, type DemoCapability, type DemoRole } from "@/app/lib/demo-access";
import styles from "./demo-access-boundary.module.css";
import { clearAdminPrivateCache } from "@/app/admin/use-admin-action";

type Access = { capability: DemoCapability; invalidate: () => void; end: () => void };
const AccessContext = createContext<Access | null>(null);
export const useDemoAccess = () => useContext(AccessContext);
export function DemoAccessBoundary({ role, children }: { role: DemoRole; children: ReactNode }) {
  const [capability, setCapability] = useState<DemoCapability | null>(null);
  const [phase, setPhase] = useState<"checking" | "ready" | "error" | "ended">("checking");
  const [error, setError] = useState(""); const [epoch, setEpoch] = useState(0);
  const serial = useRef(0); const controls = useRef(new Set<AbortController>()); const mounted = useRef(false);
  const currentCapability = useRef<DemoCapability | null>(null);
  const refresh = useCallback(async (enter: boolean) => {
    const sequence = ++serial.current; const control = new AbortController(); controls.current.add(control);
    if (enter) { setPhase("checking"); setError(""); }
    try {
      const caps = await fetchDemoCapability(control.signal);
      if (!mounted.current || sequence !== serial.current) return;
      if (enter && caps.mode !== "authenticated") await enterDemo(role, control.signal);
      if (!mounted.current || sequence !== serial.current) return;
      const changed = currentCapability.current && currentCapability.current.mode !== caps.mode;
      if (changed) { if (role === "styling-manager") clearAdminPrivateCache(null); setEpoch(v => v + 1); }
      currentCapability.current = caps; setCapability(caps);
      if (changed && !enter && caps.mode !== "authenticated") {
        setPhase("error"); setError("服务端已切换演示模式，请明确进入新会话；旧动作不会自动提交。"); return;
      }
      if (enter || caps.mode === "authenticated") setPhase("ready");
    } catch (cause) {
      if (mounted.current && sequence === serial.current) { setPhase("error"); setError(cause instanceof Error ? cause.message : "访问模式未确认，请重新读取。"); }
    } finally { controls.current.delete(control); }
  }, [role]);
  useEffect(() => {
    mounted.current = true; const activeControls = controls.current; const requestSerial = serial;
    const timer = setTimeout(() => { void refresh(true); }, 0);
    return () => { mounted.current = false; requestSerial.current++; clearTimeout(timer); for (const control of activeControls) control.abort(); activeControls.clear(); };
  }, [refresh]);
  useEffect(() => {
    if (phase !== "ready") return;
    const check = () => { void refresh(false); }; const timer = window.setInterval(check, 30000);
    window.addEventListener("focus", check); return () => { clearInterval(timer); window.removeEventListener("focus", check); };
  }, [phase, refresh]);
  const invalidate = () => { setEpoch(v => v + 1); setPhase("error"); setError("当前演示会话已失效，旧动作不会自动重放。请重新核对访问模式。"); void refresh(false); };
  const end = () => { serial.current++; for (const c of controls.current) c.abort(); setEpoch(v => v + 1); setPhase("ended"); setError(""); };
  if (phase !== "ready" || !capability) return <main className={styles.gate}><h1>正在打开{role === "consumer" ? "穿搭" : "管理者"}窗口</h1>
    {phase === "checking" ? <p role="status">正在核对服务端访问模式…</p> : <><p role={phase === "error" ? "alert" : "status"}>{error || "当前演示会话已结束。再次进入会建立当前角色的新会话，旧动作不会自动提交。"}</p><button onClick={() => void refresh(true)}>{phase === "ended" ? "重新进入演示窗口" : "重新读取模式并进入"}</button></>}
  </main>;
  return <AccessContext.Provider value={{ capability, invalidate, end }}>
    {capability.mode !== "authenticated" && <aside className={styles.banner} aria-label="演示访问身份" role="status"><strong>{capability.mode === "public_demo" ? "公开合成演示" : "临时免登录演示"}｜{role === "styling-manager" ? "合成管理者" : "消费者（当前浏览器身份）"}</strong><span>{role === "styling-manager" ? "共享合成身份；核对、批准和发送仍需你明确操作。" : "新访客为合成身份；原合法归属保留，不共享私人资料或照片。"}</span></aside>}
    <div key={`${role}:${capability.mode}:${epoch}`}>{children}</div>
  </AccessContext.Provider>;
}
