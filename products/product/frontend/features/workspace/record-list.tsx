"use client";

import { useState } from "react";
import { Archive, FileText, Search } from "lucide-react";
import { Button, EmptyState, Tag } from "@/components/ui";
import type { EvidenceRecord } from "./types";

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "approved" || status === "filed" || status === "success") return "success";
  if (status === "rejected" || status === "error") return "danger";
  if (status === "draft" || status === "pending") return "warning";
  return "neutral";
}

export function RecordList({ drafts, packages, tab, onTab, busy, loading, unavailable, onOpen, onRework }: {
  drafts: EvidenceRecord[]; packages: EvidenceRecord[]; tab: "drafts" | "packages";
  onTab: (tab: "drafts" | "packages") => void; busy: boolean; loading: boolean; unavailable: boolean;
  onOpen: (record: EvidenceRecord) => void; onRework: (record: EvidenceRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const records = (tab === "drafts" ? drafts : packages).filter((record) =>
    `${record.package_id || record.id} ${record.dedup_key} ${record.requirement_desc || ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  ).sort((a, b) => (rank[a.priority || "P3"] - rank[b.priority || "P3"]) || (b.id - a.id));
  return <section className="panel records" id="records" aria-labelledby="records-heading">
    <div className="panel-heading"><div><div className="eyebrow">工作记录</div><h2 id="records-heading">每份需求，都有据可查</h2></div><label className="search-box"><Search size={16} aria-hidden="true" /><input aria-label="搜索工作记录" placeholder="搜索描述或编号" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    <div className="record-tabs" aria-label="工作记录分类"><button aria-pressed={tab === "drafts"} onClick={() => onTab("drafts")}><FileText size={15} aria-hidden="true" />待整理草稿<span>{drafts.length}</span></button><button aria-pressed={tab === "packages"} onClick={() => onTab("packages")}><Archive size={15} aria-hidden="true" />已回传证据包<span>{packages.length}</span></button></div>
    {tab === "packages" && <p className="list-note">这里保留回传时的记录；最新审批结果请以数据后台为准。</p>}
    {loading ? <div className="list-loading" role="status">正在读取工作记录…</div> : unavailable && records.length === 0 ? <div className="list-loading">记录暂时无法读取，请使用上方的重试按钮恢复。</div> : records.length === 0 ? <EmptyState title={query ? "未找到匹配记录" : tab === "drafts" ? "目前没有待整理的草稿" : "还没有回传的证据包"} icon={tab === "drafts" ? <FileText size={24} /> : <Archive size={24} />}>{query ? "试试其他描述或编号。" : tab === "drafts" ? "拉取新信号后，草稿会保存在这里。" : "确认并回传需求后，可以在这里查看详情。"}</EmptyState> : <div className="record-list">{records.map((record) => <article className="record-item" key={record.id}>
      <div className="record-main"><div className="record-icon" aria-hidden="true">{tab === "drafts" ? <FileText size={19} /> : <Archive size={19} />}</div><div className="record-copy"><div className="record-title"><h3>{record.dedup_key}</h3><Tag tone={statusTone(record.status)}>{record.status === "draft" ? "待确认" : record.status === "pending" ? "已回传 · 待审批快照" : "状态待核对"}</Tag><Tag>{record.priority || "待评估"}</Tag></div><p>{record.requirement_desc || "尚未填写需求描述"}</p><div className="record-meta"><code className="mono">{record.package_id || `草稿 #${record.id}`}</code><span>{record.version}</span><span>{record.signal_ids.length} 条信号</span><time>{(record.published_at || record.created_at).replace("T", " ").slice(0, 16)}</time></div><p>{record.priority_basis || "尚无优先级依据"}</p></div>{tab === "drafts" && <Button onClick={() => onOpen(record)} disabled={busy}>继续整理</Button>}</div>
      <details className="record-details"><summary>查看证据详情</summary><div className="detail-content"><dl className="detail-counts"><div><dt>意向 / 加购 / 成交</dt><dd>{record.sample_count.intent} / {record.sample_count.simulated_cart} / {record.sample_count.real_purchase}</dd></div><div><dt>设计约束</dt><dd>{record.constraints.join("；") || "未填写"}</dd></div><div><dt>关联信号</dt><dd className="id-list">{record.signal_ids.map((id) => <code className="mono" key={id}>{id}</code>)}</dd></div></dl><details className="json-details"><summary>查看完整记录 JSON</summary><pre>{JSON.stringify(record, null, 2)}</pre></details>{tab === "packages" && <div className="rework-row"><p>已在数据后台被退回？确认后创建 {`v${Number(record.version.slice(1)) + 1 || 2}`} 草稿，旧记录会保留。</p><Button onClick={() => onRework(record)} disabled={busy}>确认退回并返工</Button></div>}</div></details>
    </article>)}</div>}
  </section>;
}
