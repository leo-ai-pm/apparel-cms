"use client";

import { ConsumerObservedImage } from "./consumer-events";
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { appPath } from "@/app/lib/app-path";
import type { FixedOutfit, FixedSession, FixedActionRequest, FixedSlot } from "@/app/lib/fixed-outfits";
import { fetchVerifiedProductImage, getFrozenProductImage } from "@/app/lib/product-images";
import styles from "./fixed-outfit-panel.module.css";

export const fixedMoney = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const slots = ["top", "bottom", "shoes"] as const;
const labels = { top: "上装", bottom: "下装", shoes: "鞋履" };
type ActionInput<T> = T extends unknown ? Omit<T, "action_id" | "expected_state_revision" | "expected_conversation_revision"> : never;
export type FixedActionInput = ActionInput<FixedActionRequest>;
type Props = { outfit: FixedOutfit; current: boolean; disabled: boolean; onAction: (action: FixedActionInput) => void; onReturnCurrent: () => void };

function FixedProductImage({ outfit, slot }: { outfit: FixedOutfit; slot: FixedSlot }) {
  const image = useMemo(() => getFrozenProductImage(outfit, slot), [outfit, slot]);
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!image.ref) return;
    const controller = new AbortController();
    let url: string | null = null;
    fetchVerifiedProductImage(image.ref, { signal: controller.signal }).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setLoaded({ key: image.key, url });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ key: image.key, url: null });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [image]);
  const current = loaded?.key === image.key ? loaded : null;
  const unavailable = image.status === "unavailable" || !!image.ref && current?.url === null;
  const label = image.status === "history_unrecorded" ? "生成当时未记录单品图" : unavailable ? "单品参考图暂不可用" : image.ref ? "正在核验单品图" : "此单品暂无参考图";
  return <>
    <div className={styles.productImage}>
      {image.ref && current?.url ? <Image src={current.url} alt={`${outfit.items[slot].name}，生成当时的单品参考图`} fill unoptimized sizes="48px" onError={() => setLoaded({ key: image.key, url: null })} /> : <span role="img" aria-label={label}>{label}</span>}
    </div>
    {image.ref && <span className={styles.productImageNote}>{image.ref.disclaimer}</span>}
  </>;
}

export function FixedOutfitPanel({ outfit, current, disabled, onAction, onReturnCurrent }: Props) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const snapshot = outfit.inventory_snapshot;
  const profile = outfit.profile_snapshot;
  return <div className={styles.panel}>
    <header className={styles.heading}><div><span>YOUR LOOK</span><h2>你的完整搭配</h2></div><span className={styles.badge}>{current ? "当前方案" : "仅查看历史"} · 版本 {outfit.version_no}</span></header>
    <div className={styles.layout}>
      <figure className={styles.figure}>
        <div className={styles.canvas}>
          {failed ? <div role="alert" className={styles.imageError}><p>搭配图片暂时无法读取，版本和单品资料已保留。</p><button onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重试读取搭配图片</button></div> :
            <ConsumerObservedImage key={attempt} observation={{ event_name: "outfit_displayed", source_slot: "fixed_canvas", look_version_id: outfit.look_version_id, sku_ids: outfit.sku_ids }} minimumFraction={1} src={appPath(outfit.image_url)} alt={`固定模特完整搭配，版本${outfit.version_no}，${outfit.look_id}`} fill unoptimized sizes="(max-width: 1100px) 45vw, 40vw" onError={() => setFailed(true)} />}
        </div>
        <figcaption><strong>{outfit.look_id} · {outfit.look_version_id}</strong><span>已接受的预生成固定图 · 模拟商品</span><span>{outfit.disclaimer || "AI搭配示意图，不代表用户本人实际试穿或尺码效果"}</span></figcaption>
      </figure>
      <aside className={styles.items} aria-label="固定搭配三件单品">
        {slots.map(slot => { const item = outfit.items[slot]; return <article key={item.sku_id} className={styles.item}>
          <FixedProductImage outfit={outfit} slot={slot} />
          <span className={styles.slot}>{labels[slot]} · {item.size.value}</span><h3>{item.name}</h3><small>{item.sku_id}</small><strong>{fixedMoney(item.price_fen)}</strong>
          <button disabled={disabled} onClick={() => onAction({ operation: "add_item_to_cart", sku_id: item.sku_id, quantity: 1 })}>模拟加购这件</button>
        </article>; })}
        <div className={styles.total}><span>三件合计</span><strong>{fixedMoney(outfit.total_price_fen)}</strong></div>
        {current ? <button className={styles.primary} disabled={disabled} onClick={() => onAction({ operation: "add_bundle_to_cart", target_look_version_id: outfit.look_version_id })}>整套模拟加购</button> : <p className={styles.note}>正在查看历史版本。恢复为当前方案后，可整套模拟加购。<button onClick={onReturnCurrent}>回到当前方案继续对话</button></p>}
        <p className={styles.note}>模拟加购不产生订单或真实收入。</p>
      </aside>
    </div>
    <details className={styles.provenance}><summary>查看版本与商品资料</summary><dl>
      <dt>父版本</dt><dd>{outfit.parent_look_version_id || "首个版本"}</dd><dt>恢复自</dt><dd>{outfit.restored_from_look_version_id || "非历史恢复"}</dd>
      <dt>接受状态</dt><dd>{outfit.acceptance_status}</dd><dt>原图摘要</dt><dd>{outfit.image_sha256}</dd>
      <dt>该版本库存快照</dt><dd>{snapshot?.recorded ? `${snapshot.inventory_snapshot_id} · 模拟库存` : "历史未记录"}</dd>
      <dt>快照采集时间</dt><dd>{snapshot?.recorded ? snapshot.captured_at : "历史未记录"}</dd><dt>快照有效期至</dt><dd>{snapshot?.recorded ? snapshot.valid_until : "历史未记录"}</dd>
      <dt>快照摘要</dt><dd>{snapshot?.recorded ? snapshot.sha256 : "历史未记录"}</dd>
      <dt>生成当时的资料快照</dt><dd>{profile ? profile.snapshot_id : "历史未记录"}</dd>
      <dt>当时资料修订</dt><dd>{profile ? profile.profile_version : "历史未记录"}</dd>
      <dt>当时资料绑定摘要</dt><dd>{profile ? profile.snapshot_digest : "历史未记录"}</dd>
      <dt>当时条件来源</dt><dd>{profile ? Object.entries(profile.field_sources).map(([field, source]) => {
        const fields: Record<string, string> = { "usual_sizes.top": "上衣尺码", "usual_sizes.bottom": "下装尺码", "usual_sizes.shoes": "鞋码", scene: "场景", budget_max_fen: "整套预算" };
        const sources: Record<string, string> = { saved_profile: "已保存资料", current_request: "当前对话条件", explicit_selection: "本次明确选择", explicit_text: "本次明确原话" };
        return `${fields[field] ?? field}：${sources[source] ?? source}`;
      }).join("；") || "当时没有已记录条件" : "历史未记录"}</dd>
      {Object.entries(outfit.resources).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
    </dl></details>
  </div>;
}

export function FixedHistory({ session, viewedId, disabled, onView, onAction }: { session: FixedSession; viewedId: string | null; disabled: boolean; onView: (id: string) => void; onAction: (input: FixedActionInput) => void }) {
  return <section className={styles.history} aria-label="固定搭配版本历史"><h2>这次对话的搭配版本</h2><p>查看历史不会改变当前方案。明确恢复时会重新检查商品，并保存为新版本。</p><div className={styles.historyList}>
    {session.history.map(outfit => <article key={outfit.look_version_id}><div><strong>版本 {outfit.version_no} · {fixedMoney(outfit.total_price_fen)}</strong><span>{outfit.look_id}</span><small>{outfit.look_version_id === session.state.current_look_version_id ? "当前方案" : outfit.restored_from_look_version_id ? `恢复自 ${outfit.restored_from_look_version_id}` : `父版本 ${outfit.parent_look_version_id || "无"}`}</small></div><button disabled={disabled} aria-pressed={viewedId === outfit.look_version_id} onClick={() => onView(outfit.look_version_id)}>查看版本 {outfit.version_no}</button><button disabled={disabled || outfit.look_version_id === session.state.current_look_version_id} onClick={() => onAction({ operation: "restore_history", target_look_version_id: outfit.look_version_id })}>恢复版本 {outfit.version_no} 为当前方案</button></article>)}
  </div></section>;
}

export function FixedBag({ session, disabled, onAction }: { session: FixedSession; disabled: boolean; onAction: (input: FixedActionInput) => void }) {
  const total = session.cart_items.reduce((sum, item) => sum + item.line_price_fen, 0);
  return <section className={styles.bag} aria-label="固定搭配模拟购物袋"><h2>固定搭配购物袋</h2><p>以下为当时加购的 SKU、数量和价格；全部为模拟商品。</p>{session.cart_items.length === 0 ? <p>固定搭配购物袋还是空的，可从当前搭配添加单件或整套。</p> : <>
    {session.cart_items.map(item => <article key={`${item.cart_action_id}-${item.sku_id}`}><div><h3>{item.name}</h3><p>{item.sku_id} · 尺码 {item.size.value} · 数量 {item.quantity}</p><small>加购版本：{item.look_version_id || "独立单件"} · 加购行：{item.cart_action_id}</small><details><summary>查看加购时的资源版本</summary>{Object.entries(item.resources).map(([key, value]) => <p key={key}>{key}：{String(value)}</p>)}</details></div><div><p>单价 {fixedMoney(item.unit_price_fen)}</p><strong>{fixedMoney(item.line_price_fen)}</strong><button disabled={disabled} onClick={() => onAction({ operation: "remove_item_from_cart", sku_id: item.sku_id, target_cart_action_id: item.cart_action_id })}>取消这条加购</button></div></article>)}
    <div className={styles.total}><span>模拟合计</span><strong>{fixedMoney(total)}</strong></div></>}
  </section>;
}
