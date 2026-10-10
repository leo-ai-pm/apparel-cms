import {headers} from "next/headers";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: "知需 · 产品需求工作台",
  description: "汇集需求信号，整理证据，提交产品审批。",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const selectedRole=(await headers()).get("x-workbench-demo-role");
  return <html lang="zh-CN"><body><SiteHeader initialRole={selectedRole==="staff"||selectedRole==="manager"?selectedRole:undefined} />{children}</body></html>;
}
