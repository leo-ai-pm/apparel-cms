import type { Metadata } from "next";
import Image from "next/image";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, MessageCircle, ShieldCheck } from "lucide-react";
import { appPath, isPrefixedDemoDeployment } from "../lib/app-path";
import { getPlatformLinks } from "../lib/platform-links";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "鞋服 AI 协作平台 · 从穿搭开始",
  description: "体验自然语言穿搭顾问，进入现有产品与设计页面，了解企业需求审核与协作入口。",
};

export default function PlatformPage() {
  const links = getPlatformLinks(null);
  const product = links.find(item => item.id === "product")!;
  const design = links.find(item => item.id === "design")!;
  const cms = links.find(item => item.id === "cms")!;
  const prefixedDemo = isPrefixedDemoDeployment();
  return <div className={styles.page}>
    <a className={styles.skipLink} href="#platform-main">跳到主要内容</a>
    <header className={styles.header}>
      <a className={styles.brand} href={appPath("/platform")} aria-label="鞋服 AI 协作平台">
        <span className={styles.brandMark} aria-hidden="true">S</span><span>鞋服 AI 协作平台</span>
      </a>
      <nav className={styles.headerNav} aria-label="统一入口导航">
        <a href="#products">产品入口 <ArrowDown size={14} aria-hidden="true" /></a>
        <a href={appPath("/")}>体验穿搭 <ArrowUpRight size={16} aria-hidden="true" /></a>
      </nav>
    </header>

    <main id="platform-main" className={styles.main} tabIndex={-1}>
      <section className={styles.hero} aria-labelledby="platform-heading">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>STYLE, WITH A POINT OF VIEW</p>
          <span className={styles.heroLabel}><span aria-hidden="true" /> 消费者体验 · 企业协作</span>
          <h1 id="platform-heading">从穿搭开始，<br />让需求被看见。</h1>
          <p className={styles.heroDescription}>把场景、预算和喜好说出来。用自然语言探索适合自己的搭配，也让鞋服团队更清楚地理解消费者表达。</p>
          <div className={styles.heroActions}>
            <a className={styles.primaryButton} href={appPath("/")}>开始穿搭对话 <ArrowRight size={18} aria-hidden="true" /></a>
            <a className={styles.secondaryButton} href="#products">认识三个产品 <ArrowDown size={16} aria-hidden="true" /></a>
          </div>
          <p className={styles.heroFootnote}><Check size={14} aria-hidden="true" /> 自然语言表达 <span aria-hidden="true">·</span> 多轮调整 <span aria-hidden="true">·</span> 模拟体验</p>
        </div>
        <figure className={styles.editorial}>
          <div className={styles.photo}>
            <Image src={appPath("/images/editorial-styling.png")} width={1536} height={1024}
              alt="暖色街景中的通勤服饰风格意向" sizes="(max-width: 760px) calc(100vw - 32px), (max-width: 1100px) 48vw, 640px" preload />
            <span className={styles.photoIndex}>01 / EVERYDAY STYLE</span>
          </div>
          <figcaption><span>AI 生成风格意向图</span><span>用于视觉氛围，非推荐SKU结果</span></figcaption>
        </figure>
      </section>

      <section className={styles.journey} aria-label="从表达到协作">
        {[
          ["01", "说清你的需要", "从通勤、出游或日常场景开始，表达预算与偏好。"],
          ["02", "查看与调整穿搭", "通过对话查看搭配、继续调整，模拟加购结果有明确标记。"],
          ["03", "让团队理解需求", "交流形成可回查的需求证据，管理者审核后再交接。"],
        ].map(([number, title, description]) => <div key={number} className={styles.journeyStep}>
          <span className={styles.stepNumber}>{number}</span><div><h2>{title}</h2><p>{description}</p></div>
        </div>)}
      </section>

      <section id="products" className={styles.products} aria-labelledby="products-heading">
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>THREE PERSPECTIVES, ONE INDUSTRY</p><h2 id="products-heading">从个人穿搭，到产品与设计</h2></div><p>选择你的任务，进入对应的现有页面。</p></div>
        <div className={styles.productGrid}>
          <article className={`${styles.productCard} ${styles.featuredCard}`}>
            <div className={styles.cardTop}><span className={styles.cardIndex}>01 / STYLING</span><MessageCircle size={23} strokeWidth={1.5} aria-hidden="true" /></div>
            <h3>个性化穿搭</h3><p>用对话表达场景与喜好，查看搭配方案，再继续调整细节。</p>
            <span className={styles.cardAudience}>面向消费者 · 自然语言体验</span>
            <a href={appPath("/")} className={styles.cardLink}>体验穿搭顾问 <ArrowRight size={17} aria-hidden="true" /></a>
          </article>
          {[
            { link: product, index: "02 / PRODUCT", title: "产品需求", description: "进入产品需求工作台，整理需求信息，形成更清晰的产品方向。", audience: "面向产品团队", action: "打开产品现有页面" },
            { link: design, index: "03 / DESIGN", title: "鞋服设计", description: "进入鞋服设计页面，从需求和创意出发，探索设计表达。", audience: "面向设计团队", action: "打开设计现有页面" },
          ].map(item => <article key={item.link.id} className={styles.productCard}>
            <div className={styles.cardTop}><span className={styles.cardIndex}>{item.index}</span><ArrowUpRight size={23} strokeWidth={1.5} aria-hidden="true" /></div>
            <h3>{item.title}</h3><p>{item.description}</p><span className={styles.cardAudience}>{item.audience}</span>
            <span className={styles.existingStatus}>现有页面 · 本轮业务未验收</span>
            <a href={item.link.href} target="_blank" rel="noopener noreferrer" className={styles.cardLink}>{item.action} <ArrowUpRight size={17} aria-hidden="true" /></a>
          </article>)}
        </div>
      </section>

      <section className={styles.team} aria-labelledby="team-heading">
        <div className={styles.teamHeading}><span className={styles.teamIcon}><ShieldCheck size={24} strokeWidth={1.5} aria-hidden="true" /></span><div><p className={styles.eyebrow}>FOR AUTHORIZED TEAMS</p><h2 id="team-heading">团队审核与协作</h2><p>消费者从穿搭对话开始；管理者在独立窗口核对原话、审核需求与追溯交接。</p></div></div>
        <div className={styles.teamActions}>
          <div><a className={styles.secondaryButton} href={appPath("/admin")}>进入穿搭管理 <ArrowRight size={16} aria-hidden="true" /></a><span>{prefixedDemo ? "合成演示身份 · 人工核对与审批" : "需要管理员授权"}</span></div>
          {!prefixedDemo && <div><a className={styles.secondaryButton} href={cms.href} target="_blank" rel="noopener noreferrer">打开CMS现有页面 <ArrowUpRight size={16} aria-hidden="true" /></a><span>现有页面 · 本轮业务未验收</span></div>}
        </div>
      </section>
    </main>

    <footer className={styles.footer}><span>鞋服 AI 协作平台</span><p>{prefixedDemo ? "当前为公开合成演示。" : "当前为本机演示。"}合成样本和模拟加购用于体验，不代表真实销量或伙伴接收。</p><a href={appPath("/")}>回到穿搭体验 <ArrowUpRight size={15} aria-hidden="true" /></a></footer>
  </div>;
}
