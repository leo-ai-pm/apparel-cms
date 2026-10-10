"use client";
import {appPath} from "@/lib/app-path";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, CheckCircle2, ChevronDown, CircleHelp, ClipboardCheck, FileClock, Filter, Globe2, Inbox, Layers3, ListTodo, MessageCircle, PackageSearch, Search, Send, ShieldCheck, Sparkles, UserRound, X } from "lucide-react";
import s from "./product-workbench.module.css";

type Role = "manager" | "staff";
type View = "radar" | "tasks" | "approvals";
type Status = "assigned" | "review" | "new" | "approved" | "returned" | "ignored" | "deferred";
type Signal = {
  id: string; title: string; subtitle: string; category: string; source: string; time: string;
  count: number; status: Status; intent: number; cart: number; sales: number;
  quote: string; diagnosis: string; grouping: string; counter: string; action: string;
  draft: string; color: "sand" | "blue" | "pink";
};
type ToolName = "search_internal_signals" | "search_product_catalog" | "get_product_detail" | "search_knowledge_base" | "search_public_sources";
type ToolTrace = { tool: ToolName; title: string; status: string; summary: string; sources: { label: string; url: string }[] };
type Message = { from: "agent" | "person"; text: string; plan?: string[]; trace?: ToolTrace[] };
type Analysis = Pick<Signal, "diagnosis" | "grouping" | "counter" | "action" | "draft">;

const signals: Signal[] = [
  {
    id: "REQ-018", title: "小个子通勤西裤", subtitle: "裤长与腰臀比例适配", category: "下装 / 西裤", source: "个性化穿搭", time: "10月08日 09:42", count: 12, status: "assigned", intent: 12, cart: 5, sales: 3,
    quote: "腰围合适时裤长总是偏长，希望有适合 160cm 左右身高的通勤版型。",
    diagnosis: "集中指向尺码与版型适配。暂不能直接判定需要开发新款。",
    grouping: "按「秋季通勤 + 下装 + 裤长」归并相近反馈；原始信号编号分别保留。",
    counter: "现有 SKU 可能已有合适裤长；相关成交无法单独证明新款需求。",
    action: "先核对尺码表、在售库存与退换原因；覆盖不足时形成版型设计需求。",
    draft: "核对现有直筒西裤的尺码与裤长覆盖。如果仍无法满足小个子用户的秋季通勤需求，再提出适配版型的设计需求。", color: "sand",
  },
  {
    id: "REQ-014", title: "雨天轻量通勤鞋", subtitle: "防滑与易清洁诉求", category: "鞋履 / 休闲鞋", source: "穿搭反馈", time: "昨天 16:18", count: 9, status: "review", intent: 9, cart: 2, sales: 1,
    quote: "通勤下雨时希望鞋底更稳，鞋面沾水后能方便清洁。",
    diagnosis: "功能诉求明确，但目前样本量与实际使用场景仍需补证。",
    grouping: "按「雨天通勤 + 鞋履 + 防滑／清洁」归并，保留鞋款和天气场景。",
    counter: "鞋底打滑可能与磨损有关；现有防滑款的商品信息可能未充分展示。",
    action: "核对现售鞋款材料、鞋底测试与客服退换原因，再决定设计还是内容优化。",
    draft: "围绕雨天通勤鞋的防滑与易清洁体验，先核验现有鞋款能力和真实使用反馈，再决定是否增加产品开发任务。", color: "blue",
  },
  {
    id: "REQ-009", title: "夏季衬衫透气性", subtitle: "面料闷热与洗护反馈", category: "上装 / 衬衫", source: "个性化穿搭", time: "10月06日", count: 7, status: "new", intent: 7, cart: 1, sales: 0,
    quote: "照片看着轻薄，但实际穿起来闷热，想知道有没有更透气的面料。",
    diagnosis: "可能是商品属性说明不足，也可能是面料体验问题。需要区分咨询与真实穿着反馈。",
    grouping: "按「夏季 + 衬衫 + 透气」归并，咨询与已购买反馈分别计数。",
    counter: "部分记录仅询问面料，不能视为真实的穿着不满意。",
    action: "核对商品材质、详情页说明和已购买评价，再确定是否进入产品团队。",
    draft: "核验夏季衬衫的面料透气体验与商品说明是否一致，分开处理内容缺失和潜在面料改进需求。", color: "pink",
  },
];

const initialMessages: Record<string, Message[]> = {
  "REQ-018": [{ from: "agent", text: "我已归并 12 条相关意向，初判为裤长与版型适配问题。现有尺码覆盖尚未核验，因此没有直接建议开发新款。你可以追问依据，并在“我的任务”中核验与修订草稿。" }],
  "REQ-014": [{ from: "agent", text: "鞋履反馈已经整理成待终审需求。重点仍是核对现售鞋款的防滑能力和实际使用场景。" }],
  "REQ-009": [{ from: "agent", text: "我已完成初步归因，但这组信号还需要负责人决定是否进入产品团队。" }],
};

const statusLabel: Record<Status, string> = { assigned: "分析中", review: "待终审", new: "待筛选", approved: "已批准", returned: "已退回", ignored: "已分流", deferred: "已暂缓" };

function modelContext(signal: Signal) {
  const { id, title, quote, source, category, intent, cart, sales } = signal;
  return { id, title, quote, source, category, intent, cart, sales };
}

function EvidenceTrace({ entries }: { entries?: ToolTrace[] }) {
  if (!entries?.length) return null;
  return <details className={s.evidenceTrace}><summary>查证记录 · {entries.length} 项</summary><div>{entries.map((entry, index) => <div key={`${entry.tool}-${index}`} className={s.evidenceTraceItem}><strong>{entry.title}</strong><span>{entry.status === "ok" ? "已查询" : "未取得资料"}</span><p>{entry.summary}</p>{entry.sources.length > 0 && <small>来源：{entry.sources.map((source, sourceIndex) => <span key={`${source.label}-${sourceIndex}`}>{sourceIndex > 0 ? "、" : ""}{source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a> : source.label}</span>)}</small>}</div>)}</div></details>;
}

function BriefText({ text: value, limit = 88 }: { text: string; limit?: number }) {
  const clean = value.replace(/\s+/g, " ").trim();
  const sentenceEnd = clean.search(/[。！？]/);
  const preview = sentenceEnd >= 0 && sentenceEnd < limit ? clean.slice(0, sentenceEnd + 1) : clean.length > limit ? `${clean.slice(0, limit).replace(/[，、；：\s]+$/, "")}…` : clean;
  return <><p>{preview}</p>{clean !== preview && <details className={s.fullReason}><summary>查看完整说明</summary><p>{value}</p></details>}</>;
}

async function apiPost<T>(url: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(appPath(url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "模型服务请求失败");
  return data as T;
}

function Garment({ variant }: { variant: Signal["color"] }) {
  if (variant === "blue") return <svg viewBox="0 0 180 180" role="img" aria-label="通勤鞋款示意图"><path d="M24 107c23-1 28-14 45-26 10-7 25-9 36-1 6 5 12 13 20 15l25 7c8 2 13 9 13 16v12H20v-14c0-5 1-8 4-9Z" fill="#d4e0df" stroke="#687c7c" strokeWidth="3"/><path d="M21 124h143v11c0 4-3 7-7 7H28c-4 0-7-3-7-7v-11Z" fill="#fbfaf7" stroke="#687c7c" strokeWidth="3"/><path d="M77 86c9 8 19 13 35 14M69 94c10 9 20 14 33 16" fill="none" stroke="#809894" strokeWidth="3" strokeLinecap="round"/><path d="M43 120h43" stroke="#809894" strokeWidth="3" strokeLinecap="round"/></svg>;
  if (variant === "pink") return <svg viewBox="0 0 180 180" role="img" aria-label="衬衫示意图"><path d="m56 28 18-8 16 15 16-15 18 8 25 29-18 20-12-9v88H61V68l-12 9-18-20 25-29Z" fill="#ead6d1" stroke="#a17d79" strokeWidth="3"/><path d="m74 20 16 15-15 25-17-31m48-9L90 35l15 25 17-31" fill="#f8efeb" stroke="#a17d79" strokeWidth="3"/><path d="M90 35v110" stroke="#a17d79" strokeWidth="2"/><circle cx="96" cy="73" r="2.5" fill="#a17d79"/><circle cx="96" cy="92" r="2.5" fill="#a17d79"/><circle cx="96" cy="111" r="2.5" fill="#a17d79"/></svg>;
  return <svg viewBox="0 0 180 180" role="img" aria-label="西裤示意图"><path d="M46 20h88l-6 51-17 89H93L90 83l-3 77H69L52 71l-6-51Z" fill="#d4c2a7" stroke="#826e5a" strokeWidth="3" strokeLinejoin="round"/><path d="M50 35h80M90 36v47M62 59l13 96m43-96-14 96" fill="none" stroke="#9b876f" strokeWidth="2"/><path d="M45 20h90v13H45z" fill="#e4d4bd" stroke="#826e5a" strokeWidth="3"/><circle cx="90" cy="27" r="2" fill="#826e5a"/></svg>;
}

export function ProductWorkbench({ role, username, displayName }: { role: Role; username: string; displayName: string }) {
  const [view, setView] = useState<View>(role === "manager" ? "approvals" : "tasks");
  const [selectedId, setSelectedId] = useState("REQ-018");
  const [statuses, setStatuses] = useState<Record<string, Status>>(() => Object.fromEntries(signals.map((signal) => [signal.id, signal.status])));
  const [assignees, setAssignees] = useState<Record<string, string>>({ "REQ-018": "小林", "REQ-014": "小周" });
  const [assignee, setAssignee] = useState("小林");
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(signals.map((signal) => [signal.id, signal.draft])));
  const [messages, setMessages] = useState(initialMessages);
  const [question, setQuestion] = useState("");
  const [filter, setFilter] = useState<"all" | "todo" | "done">("all");
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [toast, setToast] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({});
  const [agentError, setAgentError] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [selectedTools, setSelectedTools] = useState<ToolName[]>(["search_internal_signals", "search_product_catalog", "get_product_detail", "search_knowledge_base"]);
  const [toolAvailability, setToolAvailability] = useState<Partial<Record<ToolName, boolean>>>({});
  const [analysisTraces, setAnalysisTraces] = useState<Record<string, ToolTrace[]>>({});
  const [taskChecks, setTaskChecks] = useState<Record<string, string[]>>({});
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>({});
  const viewSignals = signals.filter((signal) => {
    const current = statuses[signal.id];
    if (view === "tasks") return assignees[signal.id] === displayName && (filter === "all" ? ["assigned", "returned"].includes(current) : ["review", "approved"].includes(current));
    if (view === "approvals") return filter === "all" ? current === "review" : filter === "todo" ? current === "new" : ["approved", "returned", "ignored", "deferred"].includes(current);
    return filter === "all" || ["new", "assigned", "returned"].includes(current);
  });
  const visibleSignals = viewSignals.filter((signal) => (sourceFilter === "all" || signal.source === sourceFilter) && `${signal.title} ${signal.subtitle} ${signal.id}`.toLowerCase().includes(query.toLowerCase()));
  const hasSelection = visibleSignals.length > 0;
  const selected = visibleSignals.find((signal) => signal.id === selectedId) ?? visibleSignals[0] ?? signals[0];
  const status = statuses[selected.id];
  const analysis = analyses[selected.id] ?? selected;
  const analyzing = configured === true && !analyses[selected.id] && !agentError;
  const viewTitle = view === "radar" ? "需求雷达" : view === "tasks" ? "我的任务" : "审批中心";
  const reviewCount = signals.filter((signal) => statuses[signal.id] === "review").length;
  const assignmentCount = signals.filter((signal) => statuses[signal.id] === "new").length;
  const nextUnassigned = signals.find((signal) => statuses[signal.id] === "new");
  const checked = taskChecks[selected.id] ?? [];
  const tasks = ["核对来源信号与统计口径", "核验现有商品与反例", "修订需求草稿并说明结论"];

  function openView(next: View) {
    if ((next === "tasks" && role !== "staff") || (next === "approvals" && role !== "manager")) return;
    setView(next);
    setFilter("all");
    setQuery("");
    setShowFilters(false);
    setSourceFilter("all");
    setSelectedId(next === "approvals" ? "REQ-014" : "REQ-018");
    setToast("");
    setAgentError("");
  }

  function toggleTool(name: ToolName) {
    if (chatBusy || toolAvailability[name] === false) return;
    const group: ToolName[] = name === "search_product_catalog" ? ["search_product_catalog", "get_product_detail"] : [name];
    const enabled = selectedTools.includes(name);
    const next = enabled ? selectedTools.filter((item) => !group.includes(item)) : [...new Set([...selectedTools, ...group])];
    if (next.length) setSelectedTools(next);
  }

  useEffect(() => {
    let active = true;
    fetch(appPath("/api/agent/status"))
      .then((response) => response.json())
      .then((data) => { if (active) { setConfigured(data.configured === true); setToolAvailability(data.tools ?? {}); } })
      .catch(() => { if (active) { setConfigured(false); setAgentError("模型服务暂不可用，请检查本机后端。"); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!configured || !hasSelection || analyses[selected.id]) return;
    const controller = new AbortController();
    const current = selected;
    apiPost<{ analysis: Analysis; tool_trace: ToolTrace[] }>("/api/agent/analyze", { signal: modelContext(current) }, controller.signal)
      .then(({ analysis: result, tool_trace: trace }) => {
        setAnalyses((previous) => ({ ...previous, [current.id]: result }));
        setAnalysisTraces((previous) => ({ ...previous, [current.id]: trace ?? [] }));
        if (current.status !== "review") setDrafts((previous) => ({ ...previous, [current.id]: previous[current.id] === current.draft ? result.draft : previous[current.id] }));
        setMessages((previous) => ({ ...previous, [current.id]: [{ from: "agent", text: `${result.diagnosis}\n下一步：${result.action}` }, ...previous[current.id].slice(1)] }));
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setAgentError(error instanceof Error ? error.message : "分析失败，请重试"); });
    return () => controller.abort();
  }, [configured, selected, hasSelection, analyses]);

  function updateStatus(next: Status, message: string) { setStatuses((previous) => ({ ...previous, [selected.id]: next })); setToast(message); }
  async function sendQuestion(value: string) {
    const clean = value.trim();
    if (!clean || !configured || chatBusy) return;
    const id = selected.id;
    const history = messages[id].slice(1).slice(-10).map((message) => ({ role: message.from === "person" ? "user" : "assistant", content: message.text }));
    setMessages((previous) => ({ ...previous, [id]: [...previous[id], { from: "person", text: clean }] }));
    setQuestion("");
    setChatBusy(true);
    setAgentError("");
    try {
      const { reply, plan, tool_trace } = await apiPost<{ reply: string; plan: string[]; tool_trace: ToolTrace[] }>("/api/agent/chat", { signal: modelContext(selected), question: clean, history, mode: planMode ? "plan" : "answer", allowed_tools: selectedTools });
      setMessages((previous) => ({ ...previous, [id]: [...previous[id], { from: "agent", text: reply, plan, trace: tool_trace }] }));
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "对话失败，请重试");
    } finally {
      setChatBusy(false);
    }
  }
  function assign() {
    setAssignees((previous) => ({ ...previous, [selected.id]: assignee }));
    updateStatus("assigned", `已将 ${selected.id} 分派给${assignee}`);
  }
  function reassign() {
    setAssignees((previous) => ({ ...previous, [selected.id]: assignee }));
    updateStatus("assigned", `已将 ${selected.id} 改派给${assignee}重新核验`);
  }

  return <div className={s.app}>
    <aside className={s.sidebar} aria-label="工作台导航">
      <div className={s.brand}><span className={s.brandSymbol}><Layers3 size={21} strokeWidth={1.8} /></span><div><b>产品需求</b><small>INSIGHT WORKSPACE</small></div></div>
      <div className={s.sideLabel}>工作空间</div>
      <nav className={s.nav} aria-label="主导航">
        <button className={view === "radar" ? s.navActive : ""} type="button" aria-current={view === "radar" ? "page" : undefined} onClick={() => openView("radar")}><Inbox size={18} />需求雷达<span>{signals.length}</span></button>
        {role === "staff" && <button className={view === "tasks" ? s.navActive : ""} type="button" aria-current={view === "tasks" ? "page" : undefined} onClick={() => openView("tasks")}><UserRound size={18} />我的任务<span>{signals.filter((signal) => assignees[signal.id] === displayName && ["assigned", "returned"].includes(statuses[signal.id])).length}</span></button>}
        {role === "manager" && <button className={view === "approvals" ? s.navActive : ""} type="button" aria-current={view === "approvals" ? "page" : undefined} onClick={() => openView("approvals")}><ClipboardCheck size={18} />审批中心<span>{signals.filter((signal) => ["review", "new"].includes(statuses[signal.id])).length}</span></button>}
      </nav>
      <div className={s.sideLabel}>数据来源</div>
      <div className={s.sourceNav}><span><i className={s.liveDot} />穿搭型号 <b>已展示</b></span><span><i />客服反馈 <b>待接入</b></span><span><i />门店反馈 <b>待接入</b></span></div>
      <div className={s.sideBottom}><div className={s.avatar}>{role === "manager" ? "负" : "产"}</div><div><strong>{role === "manager" ? "产品负责人" : `${displayName} · 产品人员`}</strong><small>账号：{username}</small></div><ChevronDown size={15} /></div>
    </aside>

    <div className={s.mainArea}>
      <header className={s.topbar}><div className={s.breadcrumb}>产品需求 <span>/</span> {viewTitle}</div><div className={s.topRight}><span className={s.mockBadge}>示例数据</span><span className={s.signedInAs}>{role === "manager" ? "产品负责人" : "产品人员"} · {username}</span>{role === "manager" && <a className={s.logoutButton} href="/team">成员管理</a>}<form action="/api/auth/logout" method="post"><button className={s.logoutButton} type="submit">退出登录</button></form></div></header>
      <main className={s.main}>
        <div className={s.heading}><div><p className={s.date}>产品团队 · {view === "radar" ? "发现线索" : view === "tasks" ? "产品人员工作区" : "负责人工作区"}</p><h1>{view === "radar" ? "发现值得跟进的需求。" : view === "tasks" ? "把分派的需求核实清楚。" : "逐项审阅，再做决定。"}</h1><p>{view === "radar" ? "查看信号来源、规模与知需的初步研判，再决定是否进入产品流程。" : view === "tasks" ? "核验来源与反例，和知需讨论，修订草稿后提交负责人。" : "查看产品人员提交的证据与草稿；批准、退回或分派新线索。"}</p></div><div className={s.headingStat}><span>{view === "radar" ? "收集线索" : view === "tasks" ? "我的待办" : "待审批/待分派"}</span><strong>{view === "radar" ? signals.length : view === "tasks" ? signals.filter((signal) => assignees[signal.id] === displayName && ["assigned", "returned"].includes(statuses[signal.id])).length : signals.filter((signal) => ["review", "new"].includes(statuses[signal.id])).length}<small>项</small></strong><span>{view === "radar" ? "来自示例穿搭型号" : view === "tasks" ? "待核验或待修改" : "等待负责人处理"}</span></div></div>
        {toast && <div className={s.toast} role="status"><CheckCircle2 size={18} />{toast}<button type="button" aria-label="关闭通知" onClick={() => setToast("")}><X size={15} /></button></div>}
        <div className={s.workspace}>
          <section className={`${s.queue} ${!hasSelection ? s.queueEmpty : ""}`} aria-label={view === "radar" ? "需求信号队列" : view === "tasks" ? "我的任务队列" : "审批队列"}><div className={s.queueHeader}><div><h2>{view === "radar" ? "需求信号" : view === "tasks" ? "我的任务" : "待我处理"}</h2><p>{view === "radar" ? "来自穿搭端的待研判问题" : view === "tasks" ? `分派给${displayName}的需求` : "终审与新线索分派"}</p></div></div>
            <div className={s.search}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索需求或编号" aria-label="搜索需求或编号" /></div>
            <div className={s.tabs}><button type="button" className={filter === "all" ? s.tabActive : ""} onClick={() => setFilter("all")}>{view === "radar" ? "全部信号" : view === "tasks" ? "待处理" : "待终审"}</button><button type="button" className={filter === "todo" ? s.tabActive : ""} onClick={() => setFilter("todo")}>{view === "radar" ? "待研判" : view === "tasks" ? "已提交" : "待分派"}</button>{view === "approvals" && <button type="button" className={filter === "done" ? s.tabActive : ""} onClick={() => setFilter("done")}>已处理</button>}<button type="button" className={s.filterButton} aria-expanded={showFilters} onClick={() => setShowFilters((current) => !current)}><Filter size={15} />筛选</button></div>
            {showFilters && <div className={s.filterPanel}><label htmlFor="signal-source">信号来源</label><select id="signal-source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">全部来源</option><option value="个性化穿搭">个性化穿搭</option><option value="穿搭反馈">穿搭反馈</option></select><button type="button" onClick={() => { setSourceFilter("all"); setQuery(""); }}>重置筛选</button></div>}
            <div className={s.signalList}>{visibleSignals.length ? visibleSignals.map((signal) => <button type="button" key={signal.id} className={`${s.signalCard} ${signal.id === selected.id ? s.signalSelected : ""}`} onClick={() => { setSelectedId(signal.id); setToast(""); setAgentError(""); }}><span className={s.signalTop}><span>需求编号 · {signal.id}</span><span className={`${s.status} ${s[`status_${statuses[signal.id]}`]}`}>{statusLabel[statuses[signal.id]]}</span></span><strong>{signal.title}</strong><span className={s.signalSub}>{signal.subtitle}</span><span className={s.signalMeta}><span>{view === "tasks" ? `经办：${assignees[signal.id]}` : view === "approvals" ? `提交：${assignees[signal.id] ?? "待分派"}` : signal.source}</span><span>{signal.time}</span></span><span className={s.signalFoot}><span><MessageCircle size={14} /> {signal.count} 条相关信号</span><ArrowUpRight size={16} /></span></button>) : <div className={s.noSignals} role="status"><div className={s.emptyIcon}><ClipboardCheck size={27} strokeWidth={1.5} /></div><h2>{query || sourceFilter !== "all" ? "没有找到匹配的需求" : view === "approvals" ? filter === "all" ? "待终审已处理完" : filter === "todo" ? "新线索已分派完" : "还没有处理记录" : view === "tasks" ? filter === "all" ? "目前没有待办任务" : "还没有已提交的任务" : "当前没有待研判的信号"}</h2><p>{query || sourceFilter !== "all" ? "试试其他关键词或来源，查看完整需求列表。" : view === "approvals" && filter === "all" && assignmentCount > 0 ? `还有 ${assignmentCount} 条新线索等待分派。` : view === "approvals" && filter === "todo" && reviewCount > 0 ? `还有 ${reviewCount} 条需求等待终审。` : "新需求出现后，会在这里显示。"}</p>{query || sourceFilter !== "all" ? <button type="button" className={s.emptyAction} onClick={() => { setQuery(""); setSourceFilter("all"); }}>清除筛选 <ArrowRight size={15} /></button> : view === "approvals" && filter === "all" && assignmentCount > 0 ? <button type="button" className={s.emptyAction} onClick={() => { setFilter("todo"); setSelectedId(nextUnassigned?.id ?? "REQ-009"); }}>查看待分派 · {assignmentCount} <ArrowRight size={15} /></button> : view === "approvals" && filter === "todo" && reviewCount > 0 ? <button type="button" className={s.emptyAction} onClick={() => setFilter("all")}>查看待终审 · {reviewCount} <ArrowRight size={15} /></button> : <button type="button" className={s.emptyAction} onClick={() => openView("radar")}>查看需求雷达 <ArrowRight size={15} /></button>}</div>}</div>
            <div className={s.queueFooter}><ShieldCheck size={15} />仅展示脱敏的示例信号</div>
          </section>

          {hasSelection ? <section className={s.detail} aria-label={`${viewTitle}详情`}><div className={s.detailHeader}><div className={s.detailTitle}><span className={s.detailEyebrow}>{view === "radar" ? "需求线索" : view === "tasks" ? "我的任务" : status === "new" ? "待分派线索" : filter === "done" ? "已处理需求" : "待终审需求"} · 需求编号 {selected.id}</span><h2>{selected.title}</h2><p>{selected.subtitle}</p></div><span className={`${s.status} ${s[`status_${status}`]}`}>{statusLabel[status]}</span></div>
            {view === "radar" ? <>
            <div className={s.heroRow}><div className={`${s.garment} ${s[selected.color]}`}><Garment variant={selected.color} /><span>产品意向示意</span></div><div className={s.heroData}><div className={s.heroLabel}><Sparkles size={16} />{analyzing ? "知需正在分析" : analyses[selected.id] ? "知需已完成分析" : "示例分析"} <span>{analyses[selected.id] ? "实时结论" : "示例结论"}</span></div><BriefText text={analysis.diagnosis} limit={92} /><div className={s.statGrid}><div><span>表达意向</span><strong>{selected.intent}</strong><small>次</small></div><div><span>模拟加购</span><strong>{selected.cart}</strong><small>次</small></div><div><span>相关成交</span><strong>{selected.sales}</strong><small>笔</small></div></div></div></div>
            <div className={s.sectionDivider}><h3>知需的初步判断</h3><span>{analyses[selected.id] ? "请人工核对" : "示例内容"}</span></div>
            <div className={s.insightList}><div className={s.insightPrimary}><span>先做什么</span><BriefText text={analysis.action} /></div><div className={s.insightSecondary}><span>还不确定什么</span><BriefText text={analysis.counter} /></div><details className={s.groupingDetails}><summary>这些反馈如何归在一起</summary><p>{analysis.grouping}</p></details></div>
            <div className={s.evidenceBlock}><div><h3>原始反馈摘录</h3><span>示例 · 已脱敏</span></div><blockquote>“{selected.quote}”</blockquote><div className={s.evidenceMeta}><span><FileClock size={14} />来源：{selected.source}</span><span>场景：{selected.category}</span><span>来源编号：{selected.id}</span></div></div>
            </> : view === "tasks" ? <>
              <div className={s.workflowBanner}><span>经办任务</span><strong>{status === "returned" ? "负责人已退回，请补充证据并修订草稿" : status === "assigned" ? "请完成核验，再提交负责人终审" : "已提交，等待负责人处理"}</strong><p>经办人：{assignees[selected.id] ?? displayName}　来源：{selected.source}　相关信号：{selected.count} 条</p>{status === "returned" && <p>退回意见：{approvalNotes[selected.id]?.trim() || "请补充证据并重新核验。"}</p>}</div>
              <div className={s.workflowSection}><h3>这条任务要完成什么</h3><p>先确认现售商品是否能解决问题；把真实需求、信息缺失与反例分开，再修订需求草稿。</p><div className={s.taskChecklist}>{tasks.map((item) => <label key={item}><input type="checkbox" checked={checked.includes(item)} disabled={!["assigned", "returned"].includes(status)} onChange={(event) => setTaskChecks((previous) => ({ ...previous, [selected.id]: event.target.checked ? [...(previous[selected.id] ?? []), item] : (previous[selected.id] ?? []).filter((value) => value !== item) }))} /><span>{item}</span></label>)}</div><small>已完成 {checked.length}/{tasks.length} 项；完成后在右侧提交草稿。</small></div>
              <div className={s.workflowSection}><h3>知需给出的核验线索</h3><div className={s.taskEvidence}><div><b>建议先做</b><BriefText text={analysis.action} /></div><div><b>需要排除</b><BriefText text={analysis.counter} /></div></div><EvidenceTrace entries={analysisTraces[selected.id]} /></div>
              <div className={s.evidenceBlock}><div><h3>原始反馈</h3><span>示例 · 已脱敏</span></div><blockquote>“{selected.quote}”</blockquote><div className={s.evidenceMeta}><span>编号：{selected.id}</span><span>表达意向 {selected.intent}</span><span>模拟加购 {selected.cart}</span><span>相关成交 {selected.sales}</span></div></div>
            </> : <>
              <div className={s.workflowBanner}><span>{status === "new" ? "线索筛选" : filter === "done" ? "处理记录" : "负责人终审"}</span><strong>{status === "new" ? "决定是否进入产品团队，并指定经办人" : filter === "done" ? `处理结果：${statusLabel[status]}` : "检查证据、结论与草稿，再决定是否交设计"}</strong><p>{status === "new" ? "这条线索尚未分派，先判断是否属于产品问题。" : `经办人：${assignees[selected.id] ?? "产品人员"}　版本：V1　状态：${statusLabel[status]}`}</p></div>
              <div className={s.workflowSection}><h3>审批前核对</h3><div className={s.approvalChecks}><div><CheckCircle2 size={16} /><span>来源与原话</span><strong>{selected.source} · {selected.id}</strong></div><div><CheckCircle2 size={16} /><span>表达意向 / 模拟加购 / 相关成交</span><strong>{selected.intent} / {selected.cart} / {selected.sales}</strong></div><div><CircleHelp size={16} /><span>待核验的反例</span><strong>{analysis.counter}</strong></div></div></div>
              <div className={s.workflowSection}><h3>{status === "new" ? "知需初步建议" : "产品人员提交的需求草稿"}</h3><div className={s.reviewDraft}>{status === "new" ? analysis.action : drafts[selected.id]}</div><p className={s.reviewHint}>最终判断由负责人作出。当前审批为本地示例状态，刷新后会重置。</p>{filter === "done" && <p className={s.reviewHint}>处理意见：{approvalNotes[selected.id]?.trim() || "未填写处理意见"}</p>}</div>
              <div className={s.evidenceBlock}><div><h3>原始反馈</h3><span>示例 · 已脱敏</span></div><blockquote>“{selected.quote}”</blockquote></div>
            </>}
          </section> : null}

          {hasSelection && <aside className={s.agentRail} aria-label={view === "approvals" ? "负责人审批操作" : "知需和产品人员工作区"}>
            {view === "approvals" ? <>
              <div className={s.agentHeader}><div className={s.agentMark}><ClipboardCheck size={19} /></div><div><strong>{filter === "done" ? "处理记录" : "审批决定"}</strong><span>负责人工作区</span></div><span className={s.agentStatus}>{statusLabel[status]}</span></div>
              <div className={s.approvalPanel}>
                <h3>{status === "new" ? "确认这条线索的去向" : filter === "done" ? "这条需求的处理结果" : "审阅产品人员的提交"}</h3>
                <p>{status === "new" ? "属于产品问题则指定经办人；若是服务、信息或工具问题，可分流并保留记录。" : filter === "done" ? `当前状态：${statusLabel[status]}。处理记录仅保存在本地页面中。` : "核对原始反馈、反例和需求草稿。证据不足时退回产品人员补充。"}</p>
                {filter === "done" ? <>
                  <div className={s.approvalRecord}><b>处理意见</b><p>{approvalNotes[selected.id]?.trim() || "未填写处理意见"}</p></div>
                  {status === "deferred" && <button className={s.outlineAction} type="button" onClick={() => { updateStatus("review", "已恢复终审，可继续处理这条需求"); setFilter("all"); }}>恢复终审</button>}
                </> : <>
                  <label htmlFor="approval-note">处理意见（暂缓或关闭时必填）</label>
                  <textarea id="approval-note" rows={4} value={approvalNotes[selected.id] ?? ""} onChange={(event) => setApprovalNotes((previous) => ({ ...previous, [selected.id]: event.target.value }))} placeholder="记录判断依据；暂缓或关闭时说明原因" />
                  {status === "new" ? <>
                    <label htmlFor="workbench-assignee">指定产品人员</label><select id="workbench-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}><option>小林</option><option>小周</option><option>小陈</option></select>
                    <button className={s.primaryAction} type="button" onClick={assign}>确认线索并分派 <ArrowRight size={16} /></button>
                    <button className={s.textAction} type="button" onClick={() => updateStatus("ignored", "已分流为非产品问题，保留记录")}>分流为非产品问题</button>
                  </> : <>
                    <button className={s.primaryAction} type="button" onClick={() => updateStatus("approved", "已批准需求，待交设计负责人")}>批准并交设计 <ArrowRight size={16} /></button>
                    <button className={s.outlineAction} type="button" onClick={() => updateStatus("returned", approvalNotes[selected.id]?.trim() ? "已退回产品人员，并记录补证意见" : "已退回产品人员补充证据")}>退回补充证据 <ArrowDownRight size={16} /></button>
                    <details className={s.moreActions}><summary>更多处理方式</summary><div>
                      <button className={s.outlineAction} type="button" disabled={!approvalNotes[selected.id]?.trim()} onClick={() => updateStatus("deferred", "已暂缓，保留线索等待更多证据")}>暂缓决定</button>
                      <button className={s.outlineAction} type="button" disabled={!approvalNotes[selected.id]?.trim()} onClick={() => updateStatus("ignored", "已关闭，不进入产品需求")}>不进入产品需求</button>
                      <label htmlFor="workbench-reassignee">改派核验给</label><select id="workbench-reassignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}><option>小林</option><option>小周</option><option>小陈</option></select>
                      <button className={s.outlineAction} type="button" onClick={reassign}>确认改派</button>
                      {!approvalNotes[selected.id]?.trim() && <small>暂缓或关闭前，请先填写处理原因。</small>}
                    </div></details>
                  </>}
                </>}
              </div>
              <div className={s.approvalAside}><h4>审批边界</h4><p>知需负责整理证据与草稿；产品人员负责核验和修订；负责人保留批准、退回与分派权。</p></div>
            </> : <><div className={s.agentHeader}><div className={s.agentMark}><Sparkles size={19} /></div><div><strong>知需</strong><span>{view === "tasks" ? "协助你核验任务" : "帮你发现需求线索"}</span></div><span className={s.agentStatus}>{configured ? "智能体已连接" : configured === false ? "待配置密钥" : "检查连接中"}</span></div>
            <div className={s.chatArea} role="log" aria-label="产品人员与智能体对话" aria-live="polite">{messages[selected.id].map((message, index) => <div key={`${selected.id}-${index}`} className={message.from === "agent" ? s.agentBubble : s.personBubble}><b>{message.from === "agent" ? index === 0 && !analyses[selected.id] ? "示例说明" : "知需" : "产品人员"}</b>{message.plan && message.plan.length > 0 && <details className={s.planResult}><summary>查看本轮查证计划</summary><ol>{message.plan.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}</ol></details>}{message.from === "agent" ? <BriefText text={message.text.replace(/\*\*/g, "")} limit={190} /> : <p>{message.text}</p>}<EvidenceTrace entries={message.trace} /></div>)}</div>
            {analysisTraces[selected.id]?.length > 0 && <div className={s.analysisEvidence}><EvidenceTrace entries={analysisTraces[selected.id]} /></div>}
            <div className={s.quickQuestions}><button type="button" disabled={!configured || chatBusy} onClick={() => sendQuestion("有哪些反例和证据？")}>有哪些反例和证据？</button><button type="button" disabled={!configured || chatBusy} onClick={() => sendQuestion("以后加入客服反馈怎么处理？")}>客服反馈怎么处理？</button></div>
            <form className={s.chatInput} onSubmit={(event) => { event.preventDefault(); sendQuestion(question); }}><label htmlFor="workbench-question">继续追问智能体</label><div><input id="workbench-question" disabled={!configured || chatBusy} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="让智能体查证、规划或完善这条需求…" /><button type="submit" disabled={!configured || chatBusy} aria-label="发送问题"><Send size={17} /></button></div><div className={s.toolBar} aria-label="智能体能力入口"><button type="button" aria-pressed={planMode} className={planMode ? s.toolSelected : ""} onClick={() => setPlanMode(!planMode)} disabled={chatBusy}><ListTodo size={14} />任务规划</button><button type="button" aria-pressed={selectedTools.includes("search_internal_signals")} className={selectedTools.includes("search_internal_signals") ? s.toolSelected : ""} onClick={() => toggleTool("search_internal_signals")} disabled={chatBusy}><Search size={14} />内部信号</button><button type="button" aria-pressed={selectedTools.includes("search_product_catalog")} className={selectedTools.includes("search_product_catalog") ? s.toolSelected : ""} onClick={() => toggleTool("search_product_catalog")} disabled={chatBusy}><PackageSearch size={14} />商品目录</button><button type="button" aria-pressed={selectedTools.includes("search_knowledge_base")} className={selectedTools.includes("search_knowledge_base") ? s.toolSelected : ""} onClick={() => toggleTool("search_knowledge_base")} disabled={chatBusy || toolAvailability.search_knowledge_base === false}><BookOpen size={14} />知识库</button><button type="button" aria-pressed={selectedTools.includes("search_public_sources")} className={selectedTools.includes("search_public_sources") ? s.toolSelected : ""} onClick={() => toggleTool("search_public_sources")} disabled={chatBusy || !toolAvailability.search_public_sources} title={toolAvailability.search_public_sources ? "检索公开网页" : "需在后端配置公开检索服务"}><Globe2 size={14} />公开检索{!toolAvailability.search_public_sources && " · 待配置"}</button></div><small>{configured ? chatBusy ? "智能体正在规划、查证并生成回答…" : "勾选本轮可用资料；回答下方可查看真实查证记录。" : "配置本机模型服务后即可使用智能对话。"}</small>{agentError && <p className={s.agentError} role="alert">{agentError}</p>}</form>
            {view === "tasks" ? <div className={s.draftArea}><div className={s.draftHead}><div><span>我的需求草稿</span><strong>{analyses[selected.id] ? "知需已建议，请你核验并修订" : "示例草稿，待核验"}</strong></div><span className={s.version}>V1</span></div><label htmlFor="workbench-draft">需求描述</label><textarea id="workbench-draft" value={drafts[selected.id]} onChange={(event) => setDrafts((previous) => ({ ...previous, [selected.id]: event.target.value }))} rows={5} disabled={!["assigned", "returned"].includes(status)} /><div className={s.draftMeta}><span><CircleHelp size={14} />草稿由产品人员确认后提交</span></div>{["assigned", "returned"].includes(status) ? <button className={s.primaryAction} type="button" disabled={analyzing || checked.length < tasks.length || !drafts[selected.id].trim()} onClick={() => updateStatus("review", "需求草稿已提交产品负责人终审")}>提交负责人终审 <ArrowRight size={16} /></button> : <p className={s.actionNote}>已提交，等待负责人审阅。</p>}{["assigned", "returned"].includes(status) && checked.length < tasks.length && <p className={s.actionNote}>先完成左侧的 {tasks.length} 项核验清单，再提交草稿。</p>}</div> : <div className={s.radarNext}><h3>下一步怎么走</h3><p>{role === "manager" ? "需求雷达负责发现和研判线索。进入审批中心后，可以决定分派、暂缓或处理需求。" : "需求雷达负责发现和研判线索。负责人确认进入产品流程后，任务会出现在你的“我的任务”中。"}</p><button type="button" onClick={() => openView(role === "manager" ? "approvals" : "tasks")}>查看{role === "manager" ? "审批中心" : "我的任务"}<ArrowRight size={15} /></button></div>}</>}
          </aside>}
        </div>
      </main>
    </div>
  </div>;
}
