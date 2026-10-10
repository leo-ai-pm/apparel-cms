import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { readPagePerson, demoRole, demoAccessEnabled } from "@/lib/auth";
import { listRegisteredUsers } from "@/lib/users-db";
import { InvitePanel } from "./invite-panel";
import s from "./team.module.css";

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ demo_role?: string }> }) {
  const role = demoRole((await searchParams).demo_role), person = readPagePerson(await cookies(), role);
  if (!person) redirect(demoAccessEnabled() ? `/demo/${role}` : "/login");
  const user = person.user;
  if (user.role !== "manager") notFound();
  const members = listRegisteredUsers();
  return <main className={s.page}>
    <div className={s.header}><div><span>知需 · 产品团队</span><h1>成员管理</h1><p>{person.access?.mode === "demo" ? "演示访问 · 负责人（合成身份）。当前无需注册，既有成员与任务保留。" : "负责人创建一次邀请码，员工注册后再按任务分派；注册不能获得负责人权限。"}</p></div><Link href={person.access?.mode === "demo" ? "/workbench?demo_role=manager" : "/workbench"}>返回工作台</Link></div>
    <section className={s.card}><h2>添加产品人员</h2><InvitePanel username={user.username} access={person.access} /></section>
    <section className={s.card}><h2>已注册成员</h2>{members.length ? <ul>{members.map((member) => <li key={member.username}><strong>{member.display_name}</strong><span>{member.username}</span><small>产品人员 · {new Date(member.created_at).toLocaleDateString("zh-CN")}</small></li>)}</ul> : <p className={s.empty}>还没有注册的产品人员。</p>}</section>
    <p className={s.note}>成员与任务以本机后台记录为准；合成来源属性在每条任务中标注。</p>
  </main>;
}
