import { getPlatformLinks } from "@/app/lib/platform-links";
import { appPath } from "@/app/lib/app-path";
import styles from "./platform-bar.module.css";

export function PlatformBar() {
  const links = getPlatformLinks().filter(item => item.id !== "cms");
  return (
    <div className={styles.bar}>
      <a className={styles.brand} href={appPath("/platform")} aria-label="鞋服 AI 协作平台">
        <span className={styles.mark} aria-hidden="true">S</span>
        <span>鞋服 AI 协作平台</span>
      </a>
      <nav className={styles.nav} aria-label="公开产品导航">
        {links.map(item => <a key={item.id} href={item.href} aria-current={item.current ? "page" : undefined}
          {...(item.id === "outfit" ? {} : { target: "_blank", rel: "noopener noreferrer", title: `${item.label}现有页面（新标签页）` })}>{item.label}</a>)}
      </nav>
    </div>
  );
}
