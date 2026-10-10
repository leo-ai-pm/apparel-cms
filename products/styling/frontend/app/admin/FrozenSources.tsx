"use client";

import type { DemandAttributes, FieldSources, HandoffMetadata, Occurrence, SourceSnapshot } from "../lib/admin-api";
import { formatAdminTime } from "../lib/admin-api";
import styles from "./FrozenSources.module.css";

type Props = {
  metadata: HandoffMetadata;
  onOpenCurrent: (id: string, opener: HTMLElement) => void;
  busy: boolean;
};
type SourceView = { turn: Partial<SourceSnapshot["turn"]>; occurrences: Partial<Occurrence>[] };
const fields: Record<keyof DemandAttributes, string> = { season: "季节", scene: "场景", category: "品类", fit: "松紧", silhouette: "廓形" };
const states: Record<string, string> = {
  extracted: "已提炼", no_explicit_demand: "无明确需求", negative_preference: "否定偏好",
  needs_review: "待复核", extraction_failed: "提炼失败", extracting: "正在提炼",
  pending: "待审核", approved: "已批准", rejected: "已排除", active: "有效", excluded: "已排除", retracted: "已撤回",
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function optionalStrings(data: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => !Object.hasOwn(data, key) || typeof data[key] === "string");
}
function validAttributes(value: unknown): boolean {
  const data = record(value);
  return !!data && Object.values(data).every(item => item === null || typeof item === "string");
}
function validSources(value: unknown): boolean {
  const data = record(value);
  return !!data && Object.values(data).every(strings);
}
function validOccurrence(value: unknown): boolean {
  const data = record(value);
  if (!data || !optionalStrings(data, ["id", "turn_id", "group_key", "title", "description", "review_state", "reason", "lifecycle", "normalizer_version"])) return false;
  return (!Object.hasOwn(data, "revision") || (Number.isSafeInteger(data.revision) && (data.revision as number) >= 1)) &&
    (!Object.hasOwn(data, "attributes") || validAttributes(data.attributes)) &&
    (!Object.hasOwn(data, "field_sources") || validSources(data.field_sources)) &&
    (!Object.hasOwn(data, "context_turn_ids") || strings(data.context_turn_ids));
}
function validSnapshot(value: unknown): value is SourceView[] {
  if (!Array.isArray(value)) return false;
  return value.every(item => {
    const source = record(item);
    const turn = record(source?.turn);
    if (!source || !turn || !Array.isArray(source.occurrences) || !source.occurrences.every(validOccurrence)) return false;
    if (!optionalStrings(turn, ["id", "session_id", "text", "status", "extractor", "data_origin", "created_at", "error_code"])) return false;
    return !Object.hasOwn(turn, "extraction_attempts") || (Number.isSafeInteger(turn.extraction_attempts) && (turn.extraction_attempts as number) >= 0);
  });
}

function text(value: string | undefined, empty = "未填写"): string {
  return value === undefined ? "历史未记录" : value || empty;
}
function status(value: string | undefined): string {
  return value === undefined ? "历史未记录" : states[value] ?? `未知状态（${value || "空值"}）`;
}
function origin(value: string | undefined): string {
  if (value === undefined) return "历史未记录";
  return value === "simulation_fixture" ? "合成演示样本（simulation_fixture）" : text(value);
}
function Attributes({ values }: { values?: DemandAttributes }) {
  return <dl className={styles.attributes}>{Object.entries(fields).map(([key, label]) => {
    const value = values?.[key as keyof DemandAttributes];
    return <div key={key}><dt>{label}</dt><dd>{value === undefined ? "历史未记录" : value === null ? "未明确" : value || "未填写"}</dd></div>;
  })}</dl>;
}
function FieldReferences({ values }: { values?: FieldSources }) {
  if (values === undefined) return <p>字段出处：历史未记录</p>;
  if (!Object.keys(values).length) return <p>当时未记录字段出处。</p>;
  return <dl className={styles.references}>{Object.entries(values).map(([field, ids]) => <div key={field}>
    <dt>{fields[field as keyof DemandAttributes] ?? field}的出处交流编号</dt><dd>{ids?.length ? ids.join("、") : "当时为空"}</dd>
  </div>)}</dl>;
}

export default function FrozenSources({ metadata, onOpenCurrent, busy }: Props) {
  const snapshot: unknown = metadata.source_snapshot;
  const version: unknown = metadata.evidence_digest_version;
  return <section className={styles.section} aria-label="批准当时的出处">
    <h3>批准当时的出处</h3>
    <p className={styles.hint}>此区展示批准时保存的外部来源。“查看当前出处”会另查当前记录。</p>
    <dl className={styles.info}><div><dt>审批摘要算法版本</dt><dd>{version === undefined ? "历史未记录" : typeof version === "string" ? text(version) : "格式异常，当前不可用"}</dd></div></dl>
    {snapshot === undefined ? <p className={styles.hint}>冻结出处快照：历史未记录。</p>
      : !validSnapshot(snapshot) ? <p className={styles.error} role="alert">冻结出处快照格式异常，当前不可用。请联系后端核对。</p>
      : snapshot.length === 0 ? <p className={styles.hint}>批准当时没有外部出处，冻结来源集合为空。</p>
      : <><p className={styles.hint}>记录了 {snapshot.length} 条外部来源交流及其当时全部需求出现；这些出现不代表目标某字段唯一对应的需求记录。</p>
        {snapshot.map((source, index) => <article className={styles.source} key={`${source.turn.id ?? "missing"}-${index}`}>
          <h4>来源交流 {index + 1}</h4><p className={styles.quote}>{text(source.turn.text)}</p>
          <dl className={styles.info}>
            <div><dt>当时交流编号</dt><dd>{text(source.turn.id)}</dd></div>
            <div><dt>当时会话编号</dt><dd>{text(source.turn.session_id)}</dd></div>
            <div><dt>当时交流时间（北京时间）</dt><dd>{source.turn.created_at === undefined ? "历史未记录" : formatAdminTime(source.turn.created_at)}</dd></div>
            <div><dt>当时提炼状态</dt><dd>{status(source.turn.status)}</dd></div>
            <div><dt>当时提炼版本</dt><dd>{text(source.turn.extractor)}</dd></div>
            <div><dt>当时数据来源</dt><dd>{origin(source.turn.data_origin)}</dd></div>
            <div><dt>当时提炼尝试</dt><dd>{source.turn.extraction_attempts === undefined ? "历史未记录" : `${source.turn.extraction_attempts} 次`}</dd></div>
            <div><dt>当时错误码</dt><dd>{text(source.turn.error_code, "无")}</dd></div>
          </dl>
          <button type="button" className={styles.currentButton} data-current-source={source.turn.id} disabled={busy || !source.turn.id?.trim()} onClick={event => {
            if (source.turn.id) onOpenCurrent(source.turn.id, event.currentTarget);
          }}>查看当前出处</button>
          <h4>该交流当时全部需求出现 · {source.occurrences.length} 条</h4>
          {!source.occurrences.length && <p className={styles.hint}>当时没有需求出现记录。</p>}
          {source.occurrences.map((item, itemIndex) => <div className={styles.occurrence} key={`${item.id ?? "missing"}-${itemIndex}`}>
            <strong>{text(item.title)}</strong><p>{text(item.description)}</p>
            <dl className={styles.info}>
              <div><dt>当时出现编号</dt><dd>{text(item.id)}</dd></div>
              <div><dt>当时所属交流</dt><dd>{text(item.turn_id)}</dd></div>
              <div><dt>当时需求组</dt><dd>{text(item.group_key)}</dd></div>
              <div><dt>当时修订</dt><dd>{item.revision === undefined ? "历史未记录" : item.revision}</dd></div>
              <div><dt>当时审核状态</dt><dd>{status(item.review_state)}</dd></div>
              <div><dt>当时生命周期</dt><dd>{status(item.lifecycle)}</dd></div>
              <div><dt>当时归一版本</dt><dd>{text(item.normalizer_version)}</dd></div>
              <div><dt>当时审核说明</dt><dd>{text(item.reason, "无")}</dd></div>
            </dl>
            <Attributes values={item.attributes} /><FieldReferences values={item.field_sources} />
            <p>当时跨轮引用交流编号：{item.context_turn_ids === undefined ? "历史未记录" : item.context_turn_ids.length ? item.context_turn_ids.join("、") : "无"}</p>
          </div>)}
        </article>)}
      </>}
  </section>;
}
