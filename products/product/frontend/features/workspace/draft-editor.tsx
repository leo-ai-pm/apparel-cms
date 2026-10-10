"use client";

import { useState } from "react";
import { ArrowUpRight, Save, ShieldCheck } from "lucide-react";
import { Button, Tag } from "@/components/ui";
import type { DraftInput, EvidenceRecord } from "./types";

export function DraftEditor({ draft, busy, onSave, onPublish, onDirty }: {
  draft: EvidenceRecord;
  busy: string | null;
  onSave: (body: DraftInput) => Promise<boolean>;
  onPublish: (body: DraftInput) => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
}) {
  const [description, setDescription] = useState(draft.requirement_desc || "");
  const [constraints, setConstraints] = useState(draft.constraints.join("\n"));
  const [styleDemand, setStyleDemand] = useState(draft.attribution.style_demand);
  const [priority, setPriority] = useState<DraftInput["priority"]>(draft.priority || "P3");
  const [priorityBasis, setPriorityBasis] = useState(draft.priority_basis || "");
  const [saved, setSaved] = useState(JSON.stringify({ description: draft.requirement_desc || "", constraints: draft.constraints.join("\n"), styleDemand: draft.attribution.style_demand, priority: draft.priority || "P3", priorityBasis: draft.priority_basis || "" }));
  const [invalid, setInvalid] = useState(false);
  const dirty = JSON.stringify({ description, constraints, styleDemand, priority, priorityBasis }) !== saved;

  function change(next: { description?: string; constraints?: string; styleDemand?: boolean; priority?: DraftInput["priority"]; priorityBasis?: string }) {
    const value = { description, constraints, styleDemand, priority, priorityBasis, ...next };
    setDescription(value.description);
    setConstraints(value.constraints);
    setStyleDemand(value.styleDemand);
    setPriority(value.priority);
    setPriorityBasis(value.priorityBasis);
    onDirty(JSON.stringify(value) !== saved);
  }

  async function submit(publish: boolean) {
    if (publish && (!description.trim() || priorityBasis.trim().length < 4)) { setInvalid(true); document.getElementById(!description.trim() ? "requirement-desc" : "priority-basis")?.focus(); return; }
    setInvalid(false);
    const input: DraftInput = {
      requirement_desc: description.trim(),
      constraints: constraints.split("\n").map((line) => line.trim()).filter(Boolean),
      style_demand: styleDemand,
      priority,
      priority_basis: priorityBasis.trim(),
    };
    if (await (publish ? onPublish(input) : onSave(input))) {
      setSaved(JSON.stringify({ description, constraints, styleDemand, priority, priorityBasis }));
      onDirty(false);
    }
  }

  return <section className="panel editor" aria-labelledby="editor-heading">
    <div className="panel-heading"><div><div className="eyebrow">整理与确认</div><h2 id="editor-heading">把信号整理成一份需求</h2></div><Tag tone="warning">草稿 #{draft.id} · {draft.version}</Tag></div>
    <div className="editor-body">
      <div className="batch-heading"><span>{draft.dedup_key}</span><span className="muted">{draft.signal_ids.length} 条关联信号</span></div>
      <div className="count-grid">
        <div><span>表达意向</span><strong>{draft.sample_count.intent}</strong><small>弱信号</small></div>
        <div><span>模拟加购</span><strong>{draft.sample_count.simulated_cart}</strong><small>辅助参考</small></div>
        <div className="strong-count"><span>真实成交</span><strong>{draft.sample_count.real_purchase}</strong><small>强设计信号</small></div>
      </div>
      <div className="attribution-row"><span className="muted">独立归因</span><Tag tone={draft.attribution.supply_gap ? "warning" : "neutral"}>{draft.attribution.supply_gap ? "存在缺货" : "无缺货信号"}</Tag><Tag tone={draft.attribution.image_gap ? "warning" : "neutral"}>{draft.attribution.image_gap ? "存在缺图" : "无缺图信号"}</Tag></div>
      <p className="field-hint">缺货、缺图单独标记，不计入以上三项样本数。</p>
      <form onSubmit={(event) => { event.preventDefault(); void submit(true); }} noValidate>
        <fieldset disabled={!!busy}>
          <label htmlFor="requirement-desc">需求描述 <span className="required">*</span><span className="label-aside">一句话说明场景、缺口与期望</span></label>
          <textarea id="requirement-desc" rows={3} value={description} onChange={(event) => change({ description: event.target.value })} placeholder="例如：通勤场景下缺少高腰直筒西裤，希望新增兼顾舒适与显高的秋季款式。" aria-invalid={invalid} aria-describedby={invalid ? "description-error" : undefined} required />
          {invalid && <p className="field-error" id="description-error" role="alert">请填写需求描述后再回传。</p>}
          <label htmlFor="constraints">设计约束<span className="label-aside">可选，每行一项</span></label>
          <textarea id="constraints" rows={3} value={constraints} onChange={(event) => change({ constraints: event.target.value })} placeholder={"预算 ≤ 500 元\n适合秋季通勤"} />
          <label className="checkbox-card" htmlFor="style-demand"><input id="style-demand" type="checkbox" checked={styleDemand} onChange={(event) => change({ styleDemand: event.target.checked })} /><span><strong>认定为真实款式需求</strong><small>有真实成交时默认勾选；仅意向或加购，需由你判断。</small></span></label>
          <label htmlFor="priority">需求优先级<span className="label-aside">规则只提供建议，回传前由你核对；P0 必须人工指定</span></label>
          <select id="priority" value={priority} onChange={(event) => change({ priority: event.target.value as DraftInput["priority"], priorityBasis: "" })}><option value="P0">P0 · 最优先</option><option value="P1">P1 · 高</option><option value="P2">P2 · 中</option><option value="P3">P3 · 待收集</option></select>
          <label htmlFor="priority-basis">优先级依据 <span className="required">*</span></label>
          <textarea id="priority-basis" rows={2} maxLength={500} value={priorityBasis} onChange={(event) => change({ priorityBasis: event.target.value })} aria-invalid={invalid && priorityBasis.trim().length < 4} placeholder="说明成交、重复需求或业务时效等依据（至少4字）" />
          {invalid && priorityBasis.trim().length < 4 && <p className="field-error" role="alert">请填写至少4个字的判断依据。</p>}
        </fieldset>
        <div className="confirm-note"><ShieldCheck size={17} aria-hidden="true" /><span>回传后提交给产品负责人审批。请先核对描述、约束和归因。</span></div>
        <div className="editor-actions"><span className="save-indicator">{dirty ? "有未保存的修改" : "草稿已保存"}</span><Button onClick={() => void submit(false)} disabled={!!busy || !dirty} busy={busy === "save"}><Save size={15} aria-hidden="true" />保存草稿</Button><Button type="submit" variant="primary" disabled={!!busy} busy={busy === "publish"}>确认并回传<ArrowUpRight size={16} aria-hidden="true" /></Button></div>
      </form>
      <details className="source-details"><summary>查看去重口径与关联信号</summary><p>{draft.dedup_rule}</p><div className="id-list">{draft.signal_ids.map((id) => <code className="mono" key={id}>{id}</code>)}</div></details>
    </div>
  </section>;
}
