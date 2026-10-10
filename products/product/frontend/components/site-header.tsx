"use client";
import {useSyncExternalStore} from "react";
import {appPath} from "@/lib/app-path";
const subscribe=(changed:()=>void)=>{window.addEventListener("popstate",changed);return()=>window.removeEventListener("popstate",changed);};
const currentProductPath=()=>new URLSearchParams(window.location.search).get("demo_role")==="manager"?"/workbench?demo_role=manager":new URLSearchParams(window.location.search).get("demo_role")==="staff"?"/workbench?demo_role=staff":"/workbench";
const appLinks = () => [
  { id: "outfit", label: "穿搭", href: process.env.NEXT_PUBLIC_LINK_OUTFIT || (process.env.NEXT_PUBLIC_BASE_PATH==="/v2/product"?"/v2/styling/":"http://personal-preview.localhost:3084"), current: false },
  { id: "product", label: "产品", href: "/workbench", current: true },
  { id: "design", label: "设计", href: process.env.NEXT_PUBLIC_LINK_DESIGN || (process.env.NEXT_PUBLIC_BASE_PATH==="/v2/product"?"/v2/design":"http://design-partner-20261010.localhost:3092"), current: false },
] as const;

export function SiteHeader({initialRole}:{initialRole?:"staff"|"manager"}={}) {
  const productPath=useSyncExternalStore(subscribe,currentProductPath,()=>initialRole?`/workbench?demo_role=${initialRole}`:"/workbench");
  return (
    <header className="site-bar">
      <div className="site-brand">
        <a className="wordmark" href={appPath(productPath)}><span className="series-mark" aria-hidden="true">P</span>知需</a>
        <span className="site-divider" aria-hidden="true" />
        <span className="app-name">产品需求工作台</span>
      </div>
      <nav className="site-nav" aria-label="平台应用">
        {appLinks().map((link, index) => (
          <span className="site-nav-slot" key={link.id}>
            {index > 0 ? <span className="site-nav-sep" aria-hidden="true">·</span> : null}
            <a href={link.current?appPath(productPath):link.href} className={link.current ? "is-current" : undefined} aria-current={link.current ? "page" : undefined}>{link.label}</a>
          </span>
        ))}
      </nav>
    </header>
  );
}
