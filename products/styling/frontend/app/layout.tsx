import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "穿搭顾问 · 每一天，都穿得像自己",
  description: "个性化穿搭对话助手：描述场景、体型与预算，获得文字搭配方案并支持多轮调整。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
