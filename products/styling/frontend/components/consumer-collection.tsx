"use client";

import { ArrowUpRight, Search, ShoppingBag, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { appPath } from "@/app/lib/app-path";
import { fetchProducts, removeCart, type Product } from "@/app/lib/api";
import { SHOWCASE_PRODUCT_IDS } from "@/app/lib/showcase-catalog";
import styles from "./consumer-collection.module.css";
import { ConsumerObservedImage, useConsumerEvents } from "./consumer-events";

export type ConsumerCollectionProps = {
  mode: "discover" | "bag";
  sessionId: string;
  cartIds: string[];
  onPrefill: (prompt: string) => void;
  onCartChange: (ids: string[]) => void;
  disabled?: boolean;
};

type ReadState = { key: string; scope: string; products: Product[]; error: boolean };
const authorizedImages = new Set<string>(SHOWCASE_PRODUCT_IDS);
const price = (amount: number) => `¥${amount.toFixed(2)}`;

function validProduct(value: Product): boolean {
  return !!value && typeof value.product_id === "string" && typeof value.name === "string" && !!value.name.trim()
    && typeof value.category === "string" && Number.isFinite(value.price) && value.price >= 0;
}

export function ConsumerCollection({ mode, sessionId, cartIds, onPrefill, onCartChange, disabled = false }: ConsumerCollectionProps) {
  const events = useConsumerEvents();
  const idsKey = JSON.stringify(mode === "discover" ? SHOWCASE_PRODUCT_IDS : [...new Set(cartIds)]);
  const requestedIds: string[] = useMemo(() => JSON.parse(idsKey), [idsKey]);
  const scope = JSON.stringify([mode, sessionId, idsKey]);
  const [attempt, setAttempt] = useState(0);
  const readKey = `${scope}:${attempt}`;
  const [read, setRead] = useState<ReadState>({ key: "", scope: "", products: [], error: false });
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [imageFailures, setImageFailures] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<{ scope: string; product: Product } | null>(null);
  const [pendingIds, setPendingIds] = useState<Record<string, string>>({});
  const [removeError, setRemoveError] = useState<{ sessionId: string; message: string } | null>(null);
  const pending = useRef(new Set<string>());
  const activeSession = useRef<string | null>(sessionId);
  const opener = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const searchId = useId();
  const detailTitleId = useId();
  const loading = read.key !== readKey;
  const error = !loading && read.error;
  const products = useMemo(() => read.scope === scope ? read.products : [], [read.scope, read.products, scope]);
  const byId = useMemo(() => new Map(products.map(product => [product.product_id, product])), [products]);
  const categories = [...new Set(products.map(product => product.category).filter(Boolean))];
  const visibleIds = requestedIds.filter(id => {
    const product = byId.get(id);
    return (!query.trim() || !!product?.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      && (mode === "bag" || category === "全部" || product?.category === category);
  });
  const missingIds = requestedIds.filter(id => !byId.has(id));
  const total = requestedIds.reduce((sum, id) => sum + (byId.get(id)?.price ?? 0), 0);
  const selected = selection?.scope === scope ? selection.product : null;
  const pendingId = pendingIds[sessionId] ?? null;

  useEffect(() => {
    activeSession.current = sessionId;
    return () => { activeSession.current = null; };
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    fetchProducts(requestedIds).then(items => {
      if (!active) return;
      setRead({ key: readKey, scope, products: items.filter(item => validProduct(item) && requestedIds.includes(item.product_id)), error: false });
    }).catch(() => {
      if (!active) return;
      setRead(previous => ({ key: readKey, scope, products: previous.scope === scope ? previous.products : [], error: true }));
    });
    return () => { active = false; };
  }, [requestedIds, readKey, scope]);

  useEffect(() => {
    if (selected && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      if (dialog.current.open) events?.emit({ event_name: "product_detail_open", source_slot: `${mode}_detail`, product_id: selected.product_id });
    }
    if (!selected && dialog.current?.open) dialog.current.close();
  }, [selected, events, mode]);

  function closeDetail() {
    dialog.current?.close();
    setSelection(null);
    const trigger = opener.current;
    opener.current = null;
    if (trigger?.isConnected) trigger.focus();
  }

  function prefill(product: Product) {
    if (disabled) return;
    closeDetail();
    events?.emit({ event_name: "draft_prefill", source_slot: `${mode}_detail`, product_id: product.product_id });
    onPrefill(`我想看看「${product.name}」（商品编号${product.product_id}），请结合我的场景和预算，帮我搭配。`);
  }

  async function remove(id: string) {
    if (disabled || loading || pending.current.has(sessionId) || !cartIds.includes(id)) return;
    pending.current.add(sessionId);
    setPendingIds(previous => ({ ...previous, [sessionId]: id }));
    setRemoveError(null);
    try {
      const ids = await removeCart(sessionId, id);
      if (!ids.every(item => typeof item === "string")) throw new Error("Invalid cart response");
      if (activeSession.current === sessionId) onCartChange(ids);
    } catch {
      if (activeSession.current === sessionId) setRemoveError({ sessionId, message: "移除未成功，商品仍保留在模拟购物袋。请稍后再试。" });
    } finally {
      pending.current.delete(sessionId);
      setPendingIds(previous => { const next = { ...previous }; delete next[sessionId]; return next; });
    }
  }

  function productImage(product: Product | undefined, id: string, large = false) {
    if (!product || !authorizedImages.has(id) || imageFailures[id]) return <span className={styles.imageMissing}>
      <ShoppingBag size={large ? 40 : 28} aria-hidden="true" /><span>{product ? "商品图片暂缺" : "商品明细暂缺"}</span>
    </span>;
    return <ConsumerObservedImage observation={{ event_name: "product_impression", source_slot: `${mode}_${large ? "detail_image" : "grid"}`, product_id: id }} src={appPath(`/showcase-products/${id}.png`)} alt={product.name} fill
      sizes={large ? "(max-width: 640px) 90vw, 420px" : "(max-width: 600px) 44vw, (max-width: 1000px) 28vw, 260px"}
      onError={() => setImageFailures(values => ({ ...values, [id]: true }))} />;
  }

  return <section className={styles.collection} aria-labelledby={titleId} data-mode={mode}>
    <header className={styles.header}>
      <p className={styles.eyebrow}>{mode === "discover" ? "穿搭 · 单品灵感" : "穿搭 · 当前会话"}</p>
      <h1 id={titleId} tabIndex={-1}>{mode === "discover" ? "发现你的下一件" : "模拟购物袋"}</h1>
      <p>{mode === "discover" ? "从一件喜欢的单品开始，让顾问帮你搭配。" : "保留喜欢的单品，继续聊聊如何搭成一套。"}</p>
    </header>

    {mode === "discover" && <div className={styles.filters}>
      <label className={styles.search} htmlFor={searchId}><Search size={19} aria-hidden="true" />
        <span className={styles.srOnly}>搜索商品名称</span><input id={searchId} type="search" value={query} placeholder="寻找你喜欢的单品" onChange={event => setQuery(event.target.value)} />
      </label>
      <div className={styles.categories} aria-label="商品类别筛选">
        {["全部", ...categories].map(item => <button key={item} type="button" aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}
      </div>
    </div>}

    <div className={styles.caption}><span>{mode === "discover" ? "自主 AI 合成模拟商品 · 已授权图片" : `${requestedIds.length} 件模拟商品 · 当前价，未冻结价格或版本`}</span>
      {mode === "discover" && !loading && !error && <span>{visibleIds.length} 件单品</span>}
    </div>

    {loading && <p role="status" className={styles.notice}>{mode === "discover" ? "正在读取商品…" : "正在读取购物袋明细…"}</p>}
    {error && <div role="alert" className={styles.error}><p>商品明细暂时无法加载，{mode === "bag" ? "不能确认完整合计。" : "请稍后重试。"}</p>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>{mode === "discover" ? "重新读取商品" : "重新读取购物袋"}</button>
    </div>}
    {mode === "bag" && removeError?.sessionId === sessionId && <p role="alert" className={styles.error}>{removeError.message}</p>}
    {pendingId && <p role="status" className={styles.notice}>正在移除商品，等待服务端确认…</p>}

    {loading && !products.length && requestedIds.length > 0 ? <div className={styles.grid} aria-hidden="true">
      {requestedIds.slice(0, 8).map(id => <div key={id} className={styles.skeleton} />)}
    </div> : (!error || products.length > 0) && visibleIds.length > 0 && <div className={styles.grid}>
      {visibleIds.map(id => {
        const product = byId.get(id);
        return <article key={id} className={styles.card} aria-label={product?.name ?? `商品 ${id}`}>
          <button className={styles.product} type="button" disabled={!product}
            aria-label={product ? `查看${product.name}详情` : `${id}：商品明细暂缺`}
            onClick={event => { if (product) { opener.current = event.currentTarget; setSelection({ scope, product }); } }}>
            <span className={styles.media}>{productImage(product, id)}<span className={styles.detailHint} aria-hidden="true"><ArrowUpRight size={18} /></span></span>
            <span className={styles.productInfo}><span className={styles.productName}>{product?.name ?? `商品 ${id}`}</span>
              <span className={styles.productMeta}>{product?.category || "明细暂缺"} · {id}</span>
              <span className={styles.productPrice}>{product ? price(product.price) : "价格暂缺"}</span></span>
          </button>
          {mode === "bag" && <button type="button" className={styles.remove} aria-label={`移除${product?.name ?? `商品 ${id}`}`}
            disabled={disabled || loading || !!pendingId} onClick={() => void remove(id)}><Trash2 size={16} aria-hidden="true" />{pendingId === id ? "移除中…" : "移除"}</button>}
        </article>;
      })}
    </div>}

    {!loading && !error && visibleIds.length === 0 && <div className={styles.empty}>
      {mode === "bag" ? <><ShoppingBag size={42} aria-hidden="true" /><h2>购物袋还是空的</h2><p>与顾问聊聊喜欢的穿搭，在当前推荐中选择模拟加购。</p></>
        : <><Search size={38} aria-hidden="true" /><h2>没有找到匹配单品</h2><p>换个名称，或看看其他类别。</p><button type="button" onClick={() => { setQuery(""); setCategory("全部"); }}>查看全部单品</button></>}
    </div>}

    {mode === "bag" && <aside className={styles.summary} aria-label="购物袋价格汇总">
      <div><span>{loading || error || missingIds.length ? "已知单品小计" : "当前价合计"}</span><strong>{products.length || requestedIds.length === 0 ? price(total) : "暂无法确认"}</strong></div>
      {(loading || error || missingIds.length > 0) && requestedIds.length > 0 && <p className={styles.incomplete}>合计暂无法确认。{!loading && !error && missingIds.length > 0 && `缺少 ${missingIds.length} 件商品明细（${missingIds.join("、")}），当前小计不包含缺失商品。`}</p>}
      <p>模拟购物袋仅用于体验，不创建订单，也不代表实时库存或真实成交。</p>
    </aside>}

    <dialog ref={dialog} className={styles.dialog} aria-labelledby={detailTitleId}
      onCancel={event => { event.preventDefault(); closeDetail(); }}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); closeDetail(); } }}
      onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDetail(); } }}>
      <button className={styles.close} type="button" aria-label="关闭商品详情" onClick={closeDetail}><X size={22} aria-hidden="true" /></button>
      {selected && <div className={styles.detailLayout}>
        <div className={styles.detailMedia}>{productImage(selected, selected.product_id, true)}</div>
        <div className={styles.detailInfo}><p className={styles.eyebrow}>{selected.category} · 模拟商品</p><h2 id={detailTitleId}>{selected.name}</h2>
          <p className={styles.detailPrice}>{price(selected.price)}</p><dl><div><dt>商品编号</dt><dd>{selected.product_id}</dd></div><div><dt>颜色</dt><dd>{selected.color || "未提供"}</dd></div></dl>
          <p className={styles.detailNote}>当前商品价，价格与目录版本未冻结。图片为已授权自主 AI 合成示例，不代表真实试穿或尺码效果。</p>
          <button className={styles.primary} type="button" disabled={disabled} onClick={() => prefill(selected)}>和顾问聊这件<ArrowUpRight size={18} aria-hidden="true" /></button>
          <p className={styles.prefillNote}>只填入需求草稿，你确认发送后顾问才开始处理。</p>
        </div>
      </div>}
    </dialog>
  </section>;
}
