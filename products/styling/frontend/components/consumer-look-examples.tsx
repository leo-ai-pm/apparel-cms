"use client";

import Image from "next/image";
import { useId, useState } from "react";
import { appPath } from "@/app/lib/app-path";
import { LOOK_EXAMPLES, LOOK_EXAMPLE_SOURCE } from "@/app/lib/look-examples";
import styles from "./consumer-look-examples.module.css";
import { ConsumerObservedImage } from "./consumer-events";

type Props = { compact?: boolean };

const SLOT_LABELS = { top: "上装", bottom: "下装", shoes: "鞋履" } as const;
const historicalPrice = (fen: number) => `¥${(fen / 100).toFixed(2)}`;

export function ConsumerLookExamples({ compact = false }: Props) {
  const scope = useId();
  const [selectedId, setSelectedId] = useState(LOOK_EXAMPLES[0].lookId);
  const [imageFailures, setImageFailures] = useState<Record<string, boolean>>({});
  const selected = LOOK_EXAMPLES.find(look => look.lookId === selectedId) ?? LOOK_EXAMPLES[0];
  const total = selected.items.reduce((sum, item) => sum + item.historicalPriceFen, 0);
  const imageFailed = (id: string) => setImageFailures(state => ({ ...state, [id]: true }));

  return <section className={styles.examples} aria-label="独立搭配示例" data-compact={compact || undefined}>
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>LOOKBOOK</p>
        <h2>搭配示例</h2>
      </div>
      <p className={styles.disclaimer}>已授权 AI 合成独立示例 · <strong>非当前推荐</strong></p>
    </header>

    <div className={styles.layout}>
      <div className={styles.media}>
        <figure className={styles.figure} aria-labelledby={`${scope}-selected`}>
          <div className={styles.stage} key={selected.lookId}>
            {imageFailures[selected.lookId] ? <p className={styles.imageError} role="alert">示例图片暂时无法显示。此处不会替换为当前推荐图片。</p> :
              <ConsumerObservedImage observation={{ event_name: "example_exposure", source_slot: `lookbook_${selected.lookId}` }} src={appPath(selected.imagePath)} alt={`${selected.title}：固定模特完整上身搭配示意图`} width={selected.imageWidth} height={selected.imageHeight}
                unoptimized loading="eager" className={styles.fullImage} onError={() => imageFailed(selected.lookId)} />}
            <span className={styles.stageTag}>AI 合成示意图</span>
          </div>
          <figcaption><span>{selected.lookId}</span><span>完整上身搭配 · 独立历史示例</span></figcaption>
        </figure>

        <div className={styles.choices} role="group" aria-label="选择独立搭配示例">
          {LOOK_EXAMPLES.map(look => <button key={look.lookId} type="button" className={styles.choice} aria-pressed={selected.lookId === look.lookId}
            aria-label={`查看${look.title} ${look.lookId}`} onClick={() => setSelectedId(look.lookId)}>
            <span className={styles.thumbnail}>
              {imageFailures[look.lookId] ? <span className={styles.thumbnailError}>图片暂缺</span> :
                <Image src={appPath(look.imagePath)} alt="" width={look.imageWidth} height={look.imageHeight} unoptimized className={styles.thumbImage}
                  onError={() => imageFailed(look.lookId)} />}
            </span>
            <span>{look.title}</span>
          </button>)}
        </div>
      </div>

      <div className={styles.details} aria-live="polite" aria-atomic="true">
        <div className={styles.selectedHeading}>
          <span className={styles.badge}>独立示例</span>
          <h3 id={`${scope}-selected`}>{selected.title}</h3>
          <p>这张图对应以下历史模拟 SKU，尺码仅为示例资料。</p>
        </div>
        <ul className={styles.items} aria-label={`${selected.lookId}对应的历史SKU`}>
          {selected.items.map(item => <li key={item.skuId}>
            <span className={styles.slot}>{SLOT_LABELS[item.slot]}</span>
            <div className={styles.itemInfo}>
              <h4>{item.name}</h4>
              <p className={styles.sku}>{item.skuId}</p>
              <p>尺码：{item.size.value}{item.size.system === "cn_shoe" ? "码（中国鞋码）" : "（服装字母码）"}</p>
            </div>
            <p className={styles.itemPrice}><span>历史目录价</span><strong>{historicalPrice(item.historicalPriceFen)}</strong></p>
          </li>)}
        </ul>
        <p className={styles.total}><span>历史目录价合计</span><strong>{historicalPrice(total)}</strong></p>
        <div className={styles.historicalNotice}>
          <p>历史模拟目录，不代表当前库存或可售状态。库存快照已于 2026 年 9 月 6 日 00:00（北京时间）到期，旧目录不可加购。</p>
          <p>AI 搭配示意图，不代表实际试穿或尺码效果；示例仅供浏览，查看与切换不会改变当前推荐。</p>
        </div>
        <details className={styles.provenance}>
          <summary>查看示例资料来源</summary>
          <dl>
            <div><dt>素材验收</dt><dd>2026 年 9 月 5 日已授权并接受的四张固定模特图</dd></div>
            <div><dt>历史目录版本</dt><dd>{LOOK_EXAMPLE_SOURCE.catalogVersion}</dd></div>
            <div><dt>素材版本</dt><dd>{LOOK_EXAMPLE_SOURCE.lookAssetVersion}</dd></div>
            <div><dt>历史库存快照</dt><dd>{LOOK_EXAMPLE_SOURCE.inventorySnapshotId}（已到期）</dd></div>
          </dl>
        </details>
      </div>
    </div>
  </section>;
}
