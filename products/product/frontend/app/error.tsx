"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="fatal-error"><h1>工作台暂时无法显示</h1><p>已保存的草稿和回传记录仍在。请重新加载页面。</p><button className="button button-primary" onClick={reset}>重新加载</button></main>;
}
