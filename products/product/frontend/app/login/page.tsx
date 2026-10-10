import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { authConfigured, readSession, SESSION_COOKIE, demoAccessEnabled } from "@/lib/auth";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { FileCheck2, ListChecks, ShieldCheck } from "lucide-react";
import s from "./login.module.css";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string;demo_role?:string|string[] }> }) {
  const demoParams=await searchParams;
  if(demoAccessEnabled())redirect(`/api/auth/demo?demo_role=${encodeURIComponent(demoParams.demo_role===undefined?"staff":String(demoParams.demo_role))}`);
  if (readSession((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/workbench");
  const { error } = await searchParams;
  const configured = authConfigured();
  return <main className={s.page}>
    <section className={s.introduction} aria-labelledby="product-intro"><div className={s.identity}><span className={s.symbol}>P</span><div><strong>知需</strong><small>鞋服 AI 协作 · 产品工作台</small></div></div><h2 id="product-intro">把需求核清楚，<br />再交给设计。</h2><p>从穿搭来源到产品任务，在同一个工作区核对证据、整理需求并跟进审阅。</p><ul><li><ListChecks size={22} aria-hidden="true" /><div><strong>专注自己的任务</strong><span>员工处理分派事项，保留草稿与修改。</span></div></li><li><FileCheck2 size={22} aria-hidden="true" /><div><strong>审批有明确对象</strong><span>负责人核对来源、内容与处理理由。</span></div></li><li><ShieldCheck size={22} aria-hidden="true" /><div><strong>权限由后台核验</strong><span>产品员工和负责人使用各自账号。</span></div></li></ul></section>
    <section className={s.card} aria-labelledby="login-title"><div className={s.eyebrow}>团队账号登录</div><h1 id="login-title">进入你的工作区</h1><p>产品人员核验需求，负责人审批与分派。使用各自账号进入对应工作区。</p>
      {!configured && <div id="auth-error" className={s.error} role="alert">本机账号尚未配置，请联系工作台维护人员。</div>}
      {configured && error && <div id="auth-error" className={s.error} role="alert">{error === "invalid" ? "账号或密码不正确，请核对后重试。还没有账号请向负责人领取邀请码。" : "暂时无法登录，请联系工作台维护人员。"}</div>}
      <AuthForm mode="login" configured={configured} hasError={Boolean(error) || !configured} />
      <div className={s.registerEntry}><p>还没有账号？向负责人领取一次邀请码后注册，再由负责人分派任务。</p><Link className={s.registerButton} href="/register">注册产品人员账号</Link></div>
      <div className={s.foot}>本机验证工作区 · 记录来源与模拟属性在任务中单独标注。</div>
    </section>
  </main>;
}
