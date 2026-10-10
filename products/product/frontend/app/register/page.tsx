import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { ListChecks, ShieldCheck } from "lucide-react";
import { authConfigured, readSession, SESSION_COOKIE, demoAccessEnabled } from "@/lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import s from "../login/login.module.css";
const errors: Record<string, string> = { setup: "本机账号尚未配置，请联系维护人员。", fields: "请核对：账号为3–32位英文小写字母、数字、点、横线或下划线；姓名2–30字；密码至少12位且两次一致。", username: "这个账号已被使用，请换一个。", invite: "邀请码无效、已使用或过期，请向负责人领取有效邀请码。" };
export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ error?: string;demo_role?:string|string[] }> }) {
  const demoParams=await searchParams;
  if(demoAccessEnabled())redirect(`/api/auth/demo?demo_role=${encodeURIComponent(demoParams.demo_role===undefined?"staff":String(demoParams.demo_role))}`);
  if (readSession((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/workbench");
  const params = await searchParams;
  const configured = authConfigured();
  return <main className={s.page}>
    <section className={s.introduction}><div className={s.identity}><span className={s.symbol}>P</span><div><strong>知需</strong><small>鞋服 AI 协作 · 产品工作台</small></div></div><h2>加入团队，<br />核对每一份需求。</h2><p>使用负责人提供的一次邀请码创建产品人员账号，由负责人分派任务。已有来源、草稿和审核状态在工作区内核对。</p><ul><li><ListChecks size={22} aria-hidden="true" /><div><strong>账号与任务分开</strong><span>注册不会自动取得未分派需求。</span></div></li><li><ShieldCheck size={22} aria-hidden="true" /><div><strong>负责人权限单独配置</strong><span>注册只创建产品人员账号。</span></div></li></ul></section>
    <section className={s.card} aria-labelledby="register-title"><div className={s.eyebrow}>加入产品团队</div><h1 id="register-title">创建产品人员账号</h1><p>填写一次邀请码和账号信息后注册。负责人权限与企业范围由后台决定。</p>
      {params.error && <div id="auth-error" className={s.error} role="alert">{errors[params.error] || "注册失败，请重试。"}</div>}
      {!configured && <div id={!params.error ? "auth-error" : undefined} className={s.error} role="alert">本机账号尚未配置，请联系维护人员。</div>}
      <AuthForm mode="register" configured={configured} hasError={Boolean(params.error) || !configured} />
      <div className={s.foot}>已经有账号？<Link href="/login">返回登录</Link></div>
    </section>
  </main>;
}
