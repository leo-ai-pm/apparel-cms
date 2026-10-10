"use client";

import { parseApprovalEligibility } from "../lib/admin-api";
import styles from "./EligibilityNotice.module.css";

type Props = {
  eligibility: unknown;
  onOpenSource: (id: string, opener: HTMLElement) => void;
  busy: boolean;
};

const reviews = { pending: "待核对", approved: "已批准", rejected: "已排除" };
const lifecycles = { active: "有效", excluded: "已排除", retracted: "已撤回", replaced: "已替换" };

/** The server decides source eligibility; rereading is never a pause override. */
export default function EligibilityNotice({ eligibility, onOpenSource, busy }: Props) {
  const parsed = parseApprovalEligibility(eligibility);
  if (!parsed) return <section className={`${styles.notice} ${styles.unknown}`} role="alert" aria-label="审批资格不可用">
    <h3>审批资格不可用，当前不能批准</h3>
    <p>后端资格信息缺失、政策无法识别或格式异常，请联系后端核对。刷新或重新核对不会被当作放行依据。</p>
  </section>;

  if (parsed.eligible) return <section className={styles.notice} role="status" aria-label="来源资格允许核对">
    <h3>当前来源未触发审批暂停</h3>
    <p>{parsed.message}</p>
    <p className={styles.hint}>来源资格通过后，仍须逐条核对全部有效证据、保持完整基准一致并填写批准说明；最终以服务端事务校验为准。</p>
  </section>;

  return <section className={`${styles.notice} ${styles.paused}`} role="alert" aria-label="审批已暂停">
    <h3>审批已暂停，等待人工复核</h3>
    <p>{parsed.message}</p>
    <p className={styles.hint}>可以继续查看原话、翻页和保留说明。刷新、重新获取摘要或再次阅读不能解除暂停，当前没有恢复或强行放行入口。</p>
    <ul className={styles.sources}>
      {parsed.blocked_sources.map(source => <li key={source.occurrence_id} className={styles.source}>
        <dl>
          <div><dt>出处交流</dt><dd><code>{source.turn_id}</code></dd></div>
          <div><dt>阻塞出现记录</dt><dd><code>{source.occurrence_id}</code></dd></div>
          <div><dt>修订</dt><dd>{source.revision}</dd></div>
          <div><dt>审核状态</dt><dd>{reviews[source.review_state]}（{source.review_state}）</dd></div>
          <div><dt>生命周期</dt><dd>{lifecycles[source.lifecycle]}（{source.lifecycle}）</dd></div>
        </dl>
        <button type="button" className={styles.sourceButton} disabled={busy}
          data-approval-source={source.turn_id}
          onClick={event => onOpenSource(source.turn_id, event.currentTarget)}>查看阻塞出处原话</button>
      </li>)}
    </ul>
    <p className={styles.hint}>资格按引用交流的全部出现记录保守判定，不代表某字段唯一对应的出现记录；不改目标热度、旧交接包或发送状态。</p>
  </section>;
}
