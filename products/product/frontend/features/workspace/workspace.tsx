"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArrowDownToLine, ArrowRight, Check, FileText, Layers3, LayoutDashboard, Radio, RefreshCw, ShieldCheck } from "lucide-react";
import { Button, EmptyState, ErrorNotice, MonoText } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { workspaceApi } from "./api";
import { DraftEditor } from "./draft-editor";
import { RecordList } from "./record-list";
import type { DraftInput, EvidenceRecord } from "./types";

export function Workspace() {
  const [drafts, setDrafts] = useState<EvidenceRecord[]>([]);
  const [packages, setPackages] = useState<EvidenceRecord[]>([]);
  const [active, setActive] = useState<EvidenceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"drafts" | "packages">("drafts");
  const locked = useRef(false);
  const requestId = useRef(0);

  const refresh = useCallback((restore = false) => {
    const id = ++requestId.current;
    return Promise.all([workspaceApi.drafts(), workspaceApi.packages()]).then(([nextDrafts, nextPackages]) => {
      if (id !== requestId.current) return;
      setLoadError(""); setDrafts(nextDrafts); setPackages(nextPackages);
      if (restore) {
        const selected = Number(new URLSearchParams(window.location.search).get("draft"));
        if (selected) {
          const restored = nextDrafts.find((item) => item.id === selected);
          if (restored) setActive(restored);
          else setNotice("这份草稿已回传或不存在，请从工作记录中查看。");
        }
      }
    }).catch((error: unknown) => { if (id === requestId.current) setLoadError(errorMessage(error)); })
      .finally(() => { if (id === requestId.current) setLoading(false); });
  }, []);

  useEffect(() => {
    const requests = requestId;
    void refresh(true);
    return () => { requests.current++; };
  }, [refresh]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || locked.current) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function selectDraft(record: EvidenceRecord | null) {
    setActive(record); setDirty(false);
    const url = new URL(window.location.href);
    if (record) url.searchParams.set("draft", String(record.id)); else url.searchParams.delete("draft");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function mayLeave() { return !dirty || window.confirm("当前修改尚未保存。放弃这些修改并切换草稿？"); }

  function reloadRecords() {
    setLoading(true);
    void refresh();
  }

  async function runAction(name: string, action: () => Promise<void>): Promise<boolean> {
    if (locked.current) return false;
    locked.current = true; setBusy(name); setActionError(""); setNotice("");
    try { await action(); return true; }
    catch (error) { setActionError(errorMessage(error)); return false; }
    finally { locked.current = false; setBusy(null); }
  }

  async function pull() {
    if (!mayLeave()) return;
    await runAction("pull", async () => {
      const result = await workspaceApi.pull();
      // 即使详情请求失败，已生成的草稿也可从列表恢复，避免再次拉取。
      await refresh();
      if (!result.new_count) { setNotice("无新信号，当前可读取的信号均已整理。"); return; }
      if (result.draft_id !== undefined) {
        const record = await workspaceApi.draft(result.draft_id);
        selectDraft(record);
        setNotice(`已拉取 ${result.new_count} 条新信号。请核对归因并补充需求描述。`);
        document.getElementById("workspace-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  async function save(body: DraftInput) {
    if (!active) return false;
    return runAction("save", async () => {
      const record = await workspaceApi.save(active.id, body);
      setDrafts((items) => items.map((item) => item.id === record.id ? record : item));
      setNotice("草稿已保存，可以稍后继续整理。");
    });
  }

  async function publish(body: DraftInput) {
    if (!active) return false;
    return runAction("publish", async () => {
      const result = await workspaceApi.publish(active.id, body);
      selectDraft(null); setTab("packages");
      setNotice(`证据包 ${result.package.package_id} 已回传数据后台。${result.cms.status === "pending" ? "状态：pending（待审批）。" : "请到数据后台核对最新审批状态。"}`);
      await refresh();
    });
  }

  async function rework(record: EvidenceRecord) {
    if (!record.package_id || !mayLeave()) return;
    if (!window.confirm("请确认这份证据包已在数据后台被退回。继续将创建一个新版本草稿，旧版本保留；此操作不会回传数据后台。")) return;
    await runAction("rework", async () => {
      const result = await workspaceApi.rework(record.package_id!);
      await refresh();
      selectDraft(await workspaceApi.draft(result.draft_id)); setTab("drafts");
      setNotice(`已创建 ${result.version} 返工草稿，请修改后再次确认回传。`);
      document.getElementById("workspace-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function openDraft(record: EvidenceRecord) {
    if (active?.id === record.id || !mayLeave()) return;
    void runAction("open", async () => {
      selectDraft(await workspaceApi.draft(record.id));
      document.getElementById("workspace-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const uniqueSignals = new Set([...drafts, ...packages].flatMap((item) => item.signal_ids)).size;
  return <div className="app-shell">
    <a className="skip-link" href="#main">跳至工作台</a>
    <aside className="sidebar">
      <a className="brand" href="#main"><span className="brand-icon"><Layers3 size={22} aria-hidden="true" /></span><span>产品 Agent<small>PRODUCT WORKSPACE</small></span></a>
      <div className="sidebar-label">产品协作</div>
      <nav aria-label="工作台导航"><a className="nav-active" href="#main"><LayoutDashboard size={18} aria-hidden="true" />需求工作台<span className="nav-dot" /></a><a href="#records" onClick={() => setTab("drafts")}><FileText size={18} aria-hidden="true" />待整理草稿<span className="nav-count">{drafts.length}</span></a><a href="#records" onClick={() => setTab("packages")}><Archive size={18} aria-hidden="true" />证据包记录<span className="nav-count">{packages.length}</span></a></nav>
      <div className="sidebar-bottom"><div><ShieldCheck size={17} aria-hidden="true" /><strong>每一步，保留依据</strong></div><p>使用脱敏信号整理需求。<br />回传前由你确认，审批在数据后台完成。</p><span>内部产品工作空间</span></div>
    </aside>
    <div className="main-shell">
      <main id="main">
        <div className="page-heading"><div><div className="eyebrow">从用户反馈，到产品决策</div><h1>需求工作台<span className="heading-period">.</span></h1><p>汇集需求信号，整理设计依据，让每一份需求有据可循。</p></div><Button onClick={reloadRecords} disabled={!!busy || loading} busy={loading}><RefreshCw size={15} aria-hidden="true" />刷新记录</Button></div>
        <div className="summary-grid" aria-label="工作概览">{[
          { name: "待整理草稿", value: drafts.length, detail: "等待补充与人工确认", icon: <FileText size={19} /> },
          { name: "已回传证据包", value: packages.length, detail: "提交记录，审批结果见数据后台", icon: <Archive size={19} /> },
          { name: "已关联需求信号", value: uniqueSignals, detail: "草稿与证据包内的去重信号数", icon: <Radio size={19} /> },
        ].map((stat) => <div className="summary-card" key={stat.name}><div><span>{stat.name}</span><strong>{loading || loadError ? "—" : stat.value.toString().padStart(2, "0")}</strong><p>{stat.detail}</p></div><span className="summary-icon" aria-hidden="true">{stat.icon}</span></div>)}</div>
        <section className="pull-panel" aria-labelledby="pull-heading"><div className="pull-intro"><div className="pull-icon"><ArrowDownToLine size={22} aria-hidden="true" /></div><div><h2 id="pull-heading">从新信号开始</h2><p>从穿搭型号拉取尚未整理的需求信号，自动完成计数与归因。</p></div></div><Button variant="primary" onClick={() => void pull()} disabled={!!busy || loading || !!loadError} busy={busy === "pull"}>{busy === "pull" ? "正在拉取信号" : "拉取信号"}<ArrowRight size={16} aria-hidden="true" /></Button></section>
        <div className="workflow" aria-label="整理流程"><span><b>{active ? <Check size={12} aria-hidden="true" /> : "01"}</b>拉取与归因</span><i /><span className={active ? "current" : ""}><b>02</b>整理与确认</span><i /><span><b>03</b>回传审批</span></div>
        {loadError && <ErrorNotice onRetry={reloadRecords}>{loadError} 当前记录可能不是最新。</ErrorNotice>}
        {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
        <div className="notice-region" role="status" aria-live="polite">{notice && <div className="success-notice"><Check size={17} aria-hidden="true" /><span><MonoText text={notice} /></span></div>}</div>
        <div id="workspace-editor" className="workspace-grid"><div>{active ? <DraftEditor key={active.id} draft={active} busy={busy} onSave={save} onPublish={publish} onDirty={setDirty} /> : <section className="panel empty-editor"><div className="panel-heading"><div><div className="eyebrow">整理与确认</div><h2>下一份需求，从这里开始</h2></div><span className="section-number">02</span></div><EmptyState title="先拉取信号，或继续一份草稿" icon={<Layers3 size={30} />}>自动归因后，在这里核对计数、补充需求描述，再确认回传。</EmptyState><div className="empty-footer"><ShieldCheck size={15} aria-hidden="true" />信号与草稿会保留，方便下次继续。</div></section>}</div><aside className="guide-panel"><div className="eyebrow">整理提示</div><h2>什么值得进入设计？</h2><div className="guide-item"><span className="guide-dot green" /><div><h3>真实成交是强信号</h3><p>存在真实成交时，默认认定为款式需求。</p></div></div><div className="guide-item"><span className="guide-dot amber" /><div><h3>意向与加购，留给你判断</h3><p>仅计数，不自动升级为设计需求。</p></div></div><div className="guide-item"><span className="guide-dot gray" /><div><h3>缺货、缺图单独处理</h3><p>属于供给或图片问题，不进入设计需求样本数。</p></div></div><div className="guide-footer">一次拉取，整理为一份证据包。<br />支持保存草稿，确认后再回传。</div></aside></div>
        <RecordList drafts={drafts} packages={packages} tab={tab} onTab={setTab} busy={!!busy} loading={loading} unavailable={!!loadError} onOpen={openDraft} onRework={(record) => void rework(record)} />
        <footer className="page-footer"><span>产品 Agent · 需求整理工作台</span><span>规则归因 · 人工确认 · 后台审批</span></footer>
      </main>
    </div>
  </div>;
}
