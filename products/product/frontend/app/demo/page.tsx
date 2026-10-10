import type { Metadata } from "next";
import { RoleFlowDemo } from "@/features/demo/role-flow-demo";

export const metadata: Metadata = {
  title: "产品需求工作台 · 流程演示",
  description: "用模拟数据体验产品负责人派单、产品人员整理与需求终审。",
};

export default function DemoPage() {
  return <RoleFlowDemo />;
}
