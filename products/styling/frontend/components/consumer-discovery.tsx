"use client";

import Image from "next/image";
import { ChevronRight, Pause, Play, Shirt } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { appPath } from "@/app/lib/app-path";
import { fetchProducts, type Product } from "@/app/lib/api";
import { SHOWCASE_CHIPS, SHOWCASE_GROUPS, SHOWCASE_PRODUCT_IDS } from "@/app/lib/showcase-catalog";
import styles from "./consumer-discovery.module.css";
import { useHeroMotion } from "./use-hero-motion";
import { ConsumerObservedImage, useConsumerEvents } from "./consumer-events";

type Props = { onPrefill: (prompt: string) => void; disabled: boolean; compact?: boolean; active?: boolean };

const floatingProducts = [
  { id: "P015", kind: "card", position: "leftCard" },
  { id: "P002", kind: "floating", position: "jacket" },
  { id: "P011", kind: "floating", position: "sneaker" },
  { id: "P009", kind: "floating", position: "trousers" },
  { id: "P003", kind: "card", position: "rightCard" },
  { id: "P017", kind: "floating", position: "shoe" },
] as const;

export function ConsumerDiscovery({ onPrefill, disabled, compact = false, active = true }: Props) {
  const events = useConsumerEvents();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [imageFailures, setImageFailures] = useState<Record<string, boolean>>({});
  const scrollerRef = useRef<HTMLDivElement>(null);
  const collageRef = useRef<HTMLDivElement>(null);
  const [motionPaused, setMotionPaused] = useState(false);
  useHeroMotion(collageRef, active && !compact && !disabled, motionPaused);

  useEffect(() => {
    let active = true;
    fetchProducts([...SHOWCASE_PRODUCT_IDS]).then(items => {
      if (!active) return;
      setProducts(items.filter(item => SHOWCASE_PRODUCT_IDS.includes(item.product_id) && typeof item.name === "string" && item.name.trim() && Number.isFinite(item.price) && item.price >= 0));
      setError(false); setLoading(false);
    }).catch(() => { if (active) { setError(true); setLoading(false); } });
    return () => { active = false; };
  }, [attempt]);

  const byId = useMemo(() => new Map(products.map(product => [product.product_id, product])), [products]);
  const chooseProduct = (product: Product, sourceSlot: string) => {
    events?.emit({ event_name: "draft_prefill", source_slot: sourceSlot, product_id: product.product_id });
    onPrefill(`我想看看「${product.name}」（商品编号${product.product_id}），请结合我的场景和预算，帮我搭配。`);
  };
  const chooseScene = (prompt: string, sourceSlot: string) => {
    events?.emit({ event_name: "draft_prefill", source_slot: sourceSlot });
    onPrefill(prompt);
  };
  const failedImage = (id: string) => setImageFailures(values => ({ ...values, [id]: true }));

  function productImage(product: Product | undefined, id: string, sizes: string, sourceSlot: string, className?: string) {
    if (!product || imageFailures[id]) return <span className={styles.imageMissing}>{product ? "商品图片暂缺" : loading ? "读取中" : "商品资料暂缺"}</span>;
    return <ConsumerObservedImage src={appPath(`/showcase-products/${id}.png`)} alt={product.name} fill sizes={sizes} className={className} onError={() => failedImage(id)} observationActive={active} observation={{ event_name: "product_impression", source_slot: sourceSlot, product_id: id }} />;
  }

  return <div className={styles.discovery} data-compact={compact || undefined}>
    {!compact && <>
      <div className={styles.collage} ref={collageRef} aria-label="已有鞋服示例商品展示">
        <div className={styles.collageStage}>
          {floatingProducts.map(item => {
            const product = byId.get(item.id);
            return <div key={item.id} className={`${styles.heroPosition} ${styles[item.position]}`} data-hero-sku={item.id}>
              <div className={styles.floatLayer}>
              <button type="button" className={`${styles.heroProduct} ${item.kind === "card" ? styles.whiteCard : styles.floating}`}
              disabled={disabled || !product} onClick={() => product && chooseProduct(product, "home_hero")} aria-label={product ? `把${product.name}加入穿搭需求草稿` : `${item.id}：商品资料暂缺`}>
              <span className={styles.heroImage}>{productImage(product, item.id, "160px", "home_hero")}</span>
              {item.kind === "card" && <span className={styles.heroCaption}>{product ? <><span>{product.name}</span><span>¥{product.price} · 模拟商品</span></> : <span>{loading ? "读取示例商品" : "商品资料暂缺"}</span>}</span>}
              </button>
              </div>
            </div>;
          })}
          <div className={styles.miniModel}><Image src={appPath("/images/editorial-styling.png")} alt="AI风格意向图，非本次推荐商品" fill sizes="64px" /></div>
        </div>
        <button type="button" className={styles.motionToggle} aria-label={motionPaused ? "继续首页动效" : "暂停首页动效"} aria-pressed={motionPaused} onClick={() => setMotionPaused(value => !value)}>
          {motionPaused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}<span>{motionPaused ? "继续动效" : "暂停动效"}</span>
        </button>
      </div>
      <h1 className={styles.brand}>穿搭<span aria-hidden="true">·</span><span className={styles.srOnly}>顾问：今天想怎么穿？</span></h1>
    </>}

    <div className={styles.chips} aria-label="选择穿搭场景">
      {SHOWCASE_CHIPS.map(chip => <button key={chip.id} type="button" disabled={disabled} onClick={() => chooseScene(chip.prompt, `scene_${chip.id}`)}>
        <span className={styles.chipImage} style={{ background: chip.background }} aria-hidden="true">{imageFailures[chip.productId] ? <Shirt size={16} /> : <Image src={appPath(`/showcase-products/${chip.productId}.png`)} alt="" fill sizes="24px" onError={() => failedImage(chip.productId)} />}</span>
        {chip.title}
      </button>)}
    </div>

    <section id={compact ? undefined : "showcase"} className={styles.showcase} aria-label="穿搭场景与示例商品">
      <div className={styles.groupScroller} ref={scrollerRef}>
        {SHOWCASE_GROUPS.map(group => <div key={group.id} className={styles.group}>
          <h2><button type="button" disabled={disabled} onClick={() => chooseScene(group.prompt, `group_${group.id}`)}>{group.title}<ChevronRight size={16} aria-hidden="true" /></button></h2>
          <div className={styles.mosaic}>
            {group.tiles.map(tile => {
              const product = byId.get(tile.productId);
              return <button key={tile.productId} type="button" className={styles.tile} style={{ background: tile.background }} disabled={disabled || !product}
                onClick={() => product && chooseProduct(product, `mosaic_${group.id}`)} aria-label={product ? `把${product.name}加入穿搭需求草稿` : `${tile.label}：商品资料暂缺`}>
                <span className={styles.tileImage}>{productImage(product, tile.productId, "135px", `mosaic_${group.id}`)}</span>
                <span className={styles.tileCaption}>{product ? <><span>{product.name}</span><span>¥{product.price}</span></> : <span>{loading ? "读取中" : "商品资料暂缺"}</span>}</span>
              </button>;
            })}
          </div>
        </div>)}
      </div>
      <button className={styles.nextGroup} type="button" aria-label="下一组示例商品" onClick={() => scrollerRef.current?.scrollBy({ left: 280, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}><ChevronRight size={20} aria-hidden="true" /></button>
    </section>

    <div className={styles.catalogNotice}>
      {loading ? <p role="status">正在读取示例商品…</p> : error ? <div role="alert"><p>示例商品暂时无法读取，仍可直接描述需求。</p><button type="button" onClick={() => { setLoading(true); setError(false); setImageFailures({}); setAttempt(value => value + 1); }}>重试读取示例商品</button></div> : <p>示例商品与场景提示 · 不是本次推荐结果。选择只填入草稿，可修改后发送。</p>}
    </div>
  </div>;
}
