"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, ChevronRight, ClipboardCheck, FileText, Layers3, RotateCcw, Send, Sparkles, UserRound, UsersRound } from "lucide-react";
import styles from "./role-flow-demo.module.css";

type Role = "manager" | "staff";
type Stage = "triage" | "assigned" | "review" | "returned" | "approved";

const stageLabels = ["智能体分析", "负责人派单", "人员对话核验", "负责人终审", "交给设计"];
const defaultDescription = "核对现有直筒西裤的尺码与裤长覆盖；若仍无法满足小个子用户的秋季通勤需求，再提出适配版型的设计需求。";
const defaultBasis = "相近反馈集中在裤长与腰臀比例；意向、模拟加购和相关成交已分开计数，现有 SKU 覆盖仍待核验。";
type Message = { speaker: "agent" | "staff"; text: string };
const initialMessages: Message[] = [{ speaker: "agent", text: "我已按场景、品类和问题归并信号，并形成可修改的需求草稿。目前不能断定要开发新款：先核对现有 SKU 的裤长和尺码覆盖。你可以追问依据与反例，核验后修改草稿。" }];
const suggestions = ["为什么不直接做新款？", "有哪些反例和待核验项？", "以后加入客服反馈怎么处理？"];

function simulatedReply(question: string) {
  if (/客服|来源|接入/.test(question)) return "客服反馈接入后，我会记录来源、时间窗口和授权状态，脱敏后与穿搭型号记录按同一问题归并；仍保留原始来源编号，并区分独立用户、重复咨询和反例。当前客服接口尚未接入，这里只演示处理方式。";
  if (/反例|依据|证据|核验/.test(question)) return "现有样本里有 12 次意向、5 次模拟加购、3 笔相关成交；这些口径不能相加，也不能直接推出新款需求。反例与缺口：已有商品可能覆盖目标尺码；还需查 SKU 尺码表、库存、样本时间窗口和不同身高用户反馈。";
  if (/新款|设计/.test(question)) return "暂不直接提出新款，因为问题可能来自现有商品尺码、库存或展示信息。建议先核对 SKU 覆盖和可售状态；若确认无法满足，再将版型适配诉求提交设计。";
  return "我会把这个问题列入待核验清单，并把结论与证据分开呈现。此页是预设回复演示；正式版本需要连接模型、证据检索与来源权限后，才能根据真实提问生成回答。";
}

export function RoleFlowDemo() {
  const [role, setRole] = useState<Role>("manager");
  const [stage, setStage] = useState<Stage>("triage");
  const [assignee, setAssignee] = useState("小林");
  const [description, setDescription] = useState(defaultDescription);
  const [basis, setBasis] = useState(defaultBasis);
  const [priority, setPriority] = useState("P2");
  const [version, setVersion] = useState(1);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [question, setQuestion] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("模拟信号到达后，智能体已自动完成初步分析并生成草稿；请先查看依据。");

  const step = stage === "triage" ? 0 : stage === "assigned" ? 2 : stage === "review" || stage === "returned" ? 3 : 4;

  function reset() {
    setRole("manager");
    setStage("triage");
    setAssignee("小林");
    setDescription(defaultDescription);
    setBasis(defaultBasis);
    setPriority("P2");
    setVersion(1);
    setMessages(initialMessages);
    setQuestion("");
    setReason("");
    setNotice("模拟信号已重新进入，智能体已自动生成分析与草稿。请从证据开始查看。");
  }

  function assign() {
    setStage("assigned");
    setNotice(`负责人已确认信号并直接分派给${assignee}。请切换到产品人员视角。`);
  }

  function askAgent(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setMessages((current) => [...current, { speaker: "staff", text: trimmed }, { speaker: "agent", text: simulatedReply(trimmed) }]);
    setQuestion("");
  }

  function submit() {
    if (!description.trim() || !basis.trim()) {
      setNotice("请先填写需求描述和判断依据。演示中的提交会保留当前输入。");
      return;
    }
    setStage("review");
    setRole("manager");
    setNotice("需求草稿已提交负责人终审；系统已切换到负责人视角。");
  }

  function returnDraft() {
    if (!reason.trim()) {
      setNotice("请填写退回原因，让产品人员知道需要补充什么。");
      return;
    }
    setStage("returned");
    setVersion((current) => current + 1);
    setRole("staff");
    setNotice("需求已退回产品人员修改；系统已切换到产品人员视角。");
  }

  function approve() {
    setStage("approved");
    setNotice("负责人已终审批准。演示中的需求卡已进入“待交设计”。");
  }

  return <div className={styles.shell}>
    <aside className={styles.rail} aria-label="演示导航">
      <div className={styles.brand}><span className={styles.brandMark}><Layers3 size={21} aria-hidden="true" /></span><div><strong>产品需求</strong><small>流程演示</small></div></div>
      <div className={styles.railSection}>工作视角</div>
      <div className={styles.roleSwitch} role="group" aria-label="切换演示角色">
        <button type="button" className={role === "manager" ? styles.roleActive : ""} aria-pressed={role === "manager"} onClick={() => setRole("manager")}><UserRound size={18} aria-hidden="true" />产品负责人</button>
        <button type="button" className={role === "staff" ? styles.roleActive : ""} aria-pressed={role === "staff"} onClick={() => setRole("staff")}><UsersRound size={18} aria-hidden="true" />产品人员</button>
      </div>
      <div className={styles.railNote}><span className={styles.dot} />角色切换仅用于看演示页面，不代表真实登录或权限控制。</div>
      <Link className={styles.backLink} href="/"><ArrowLeft size={16} aria-hidden="true" />返回当前工作台</Link>
    </aside>

    <main className={styles.main}>
      <header className={styles.topline}><span>产品团队工作流</span><span className={styles.demoBadge}>模拟数据 · 无真实提交</span></header>
      <div className={styles.content}>
        <div className={styles.titleRow}><div><p className={styles.kicker}>先看流程，再定功能</p><h1>智能体先分析，人来核验和决策</h1><p className={styles.lead}>信号进入后，智能体主动归因、去重并生成有依据的需求草稿；负责人派单，产品人员与智能体对话核验，再由负责人终审后交给设计。</p></div><button type="button" className={styles.resetButton} onClick={reset}><RotateCcw size={16} aria-hidden="true" />重新演示</button></div>

        <nav className={styles.progress} aria-label="需求流程进度">{stageLabels.map((label, index) => <div key={label} className={`${styles.progressStep} ${index <= step ? styles.progressDone : ""} ${index === step ? styles.progressCurrent : ""}`} aria-current={index === step ? "step" : undefined}><span>{index < step ? <Check size={14} aria-hidden="true" /> : String(index + 1).padStart(2, "0")}</span><b>{label}</b></div>)}</nav>

        <div className={styles.workspaceHeader}><div><span className={styles.viewPill}>{role === "manager" ? "负责人视角" : "产品人员视角"}</span><h2>{role === "manager" ? "待处理的决策" : "我的需求任务"}</h2></div><p aria-live="polite">{notice}</p></div>

        <div className={styles.columns}>
          <section className={styles.evidence} aria-labelledby="evidence-title">
            <div className={styles.panelHead}><div><span className={styles.subLabel}>来源与证据</span><h3 id="evidence-title">秋季通勤西裤需求信号</h3></div><span className={styles.signalId}>SIG-DEMO-018</span></div>
            <p className={styles.evidenceIntro}>穿搭端传入模拟脱敏信号后，智能体自动整理。下方内容均为虚构样本，不代表真实用户分析。</p>
            <div className={styles.sourceList}><span><b>当前演示来源</b> 穿搭型号 · 已标记模拟/脱敏</span><span><b>后续可接入</b> 客服反馈、营销互动、门店反馈、历史产品档案 · 尚未连接</span></div>
            <div className={styles.quote}><span>用户反馈摘录</span><p>“试了两条通勤西裤，腰围合适时裤长总是偏长，希望有适合 160cm 左右身高的版型。”</p></div>
            <div className={styles.metricRow}><div><strong>12</strong><span>表达意向</span></div><div><strong>5</strong><span>模拟加购</span></div><div><strong>3</strong><span>相关成交</span></div></div>
            <div className={styles.agentInsight}><div className={styles.agentInsightHead}><Sparkles size={17} aria-hidden="true" /><strong>智能体自动分析 · 可追问</strong><span>模拟输出</span></div><p><b>问题归因</b> 初判为尺码与版型适配诉求；先排除缺货、缺图、服务或工具故障。</p><p><b>归并口径</b> 按“秋季通勤＋下装＋裤长问题”聚类，保留原信号 SIG-DEMO-018；样本窗口与去重覆盖待核验。</p><p><b>证据与反例</b> 意向、模拟加购、成交分别计数。已有 SKU 可能满足需求，相关成交也不能证明必须开发新款。</p><p><b>下一步</b> 核对 SKU 尺码表与库存；若覆盖不足，再形成适配版型的设计需求。</p><div className={styles.agentReady}>已生成可编辑草稿；人可以审核、追问并修改结论。</div></div>
            <dl className={styles.meta}><div><dt>场景</dt><dd>秋季 · 通勤</dd></div><div><dt>品类</dt><dd>下装 · 直筒西裤</dd></div><div><dt>已知问题</dt><dd>裤长、腰臀比例</dd></div><div><dt>待核对</dt><dd>现有 SKU 尺码覆盖</dd></div></dl>
            <div className={styles.evidenceFoot}><FileText size={16} aria-hidden="true" /><span>证据包需保留来源、去重口径与关联信号；这组数字本身不能直接证明必须开发新款。</span></div>
          </section>

          <section className={styles.actionPanel} aria-labelledby="action-title">
            <div className={styles.panelHead}><div><span className={styles.subLabel}>当前操作</span><h3 id="action-title">{role === "manager" ? stage === "triage" ? "确认信号并派单" : stage === "review" ? "终审产品需求" : stage === "approved" ? "已批准，待交设计" : "查看任务进度" : stage === "assigned" || stage === "returned" ? "整理需求证据包" : "查看任务状态"}</h3></div><ClipboardCheck size={21} aria-hidden="true" /></div>

            {role === "manager" && stage === "triage" && <div className={styles.actionBody}><p>先判断这组记录值得进入产品团队，再指定一位产品人员整理。缺货、缺图或单纯服务问题应分流处理。</p><label htmlFor="assignee">指定产品人员</label><select id="assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}><option>小林</option><option>小周</option><option>小陈</option></select><div className={styles.actionHint}>确认后会进入所选人员的“我的任务”。</div><button type="button" className={styles.primaryButton} onClick={assign}>确认信号并分派<ArrowRight size={16} aria-hidden="true" /></button></div>}

            {role === "manager" && (stage === "assigned" || stage === "returned") && <div className={styles.actionBody}><div className={styles.statusLine}><span className={styles.statusDot} />已分派给 {assignee}</div><p>{stage === "returned" ? "已退回，等待产品人员补充证据后重新提交。" : "产品人员正在整理需求。切换角色可查看经办人的编辑页面。"}</p><button type="button" className={styles.secondaryButton} onClick={() => setRole("staff")}>查看产品人员工作台<ChevronRight size={16} aria-hidden="true" /></button></div>}

            {role === "staff" && stage === "triage" && <div className={styles.actionBody}><div className={styles.emptyState}><UsersRound size={26} aria-hidden="true" /><strong>还没有分派任务</strong><p>负责人确认信号并指定经办人后，任务会出现在这里。</p></div><button type="button" className={styles.secondaryButton} onClick={() => setRole("manager")}>切换到负责人视角<ChevronRight size={16} aria-hidden="true" /></button></div>}

            {role === "staff" && (stage === "assigned" || stage === "returned") && <div className={styles.actionBody}>
              <div className={styles.statusLine}><span className={styles.statusDot} />{stage === "returned" ? `终审退回 · 版本 v${version}` : `负责人已分派给${assignee} · 智能体草稿已就绪`}</div>
              {stage === "returned" && <div className={styles.returnReason}><strong>负责人退回意见</strong><p>{reason}</p></div>}
              <div className={styles.chatPanel}>
                <div className={styles.chatHead}><Sparkles size={17} aria-hidden="true" /><div><strong>与知需讨论</strong><small>预设回复演示 · 未连接真实模型</small></div></div>
                <div className={styles.chatMessages} role="log" aria-label="模拟对话记录" aria-live="polite">{messages.map((message, index) => <div key={`${index}-${message.speaker}`} className={message.speaker === "agent" ? styles.agentMessage : styles.staffMessage}><b>{message.speaker === "agent" ? "智能体" : "产品人员"}</b><p>{message.text}</p></div>)}</div>
                <div className={styles.suggestions}>{suggestions.map((item) => <button key={item} type="button" onClick={() => askAgent(item)}>{item}</button>)}</div>
                <form className={styles.chatForm} onSubmit={(event) => { event.preventDefault(); askAgent(question); }}><label htmlFor="agent-question">向智能体追问</label><div><input id="agent-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：为什么不是直接做新款？" /><button type="submit" aria-label="发送问题"><Send size={16} aria-hidden="true" /></button></div></form>
              </div>
              <div className={styles.draftHeading}><strong>智能体已生成的需求草稿</strong><span>产品人员核验后可直接修改</span></div>
              <label htmlFor="description">需求描述</label><textarea id="description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
              <label htmlFor="basis">证据与判断依据</label><textarea id="basis" rows={3} value={basis} onChange={(event) => setBasis(event.target.value)} />
              <div className={styles.formRow}><label htmlFor="priority">建议优先级</label><select id="priority" value={priority} onChange={(event) => setPriority(event.target.value)}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></div>
              <p className={styles.fieldNote}>建议级别仅用于演示；真实 P0–P3 规则尚未确定，由负责人终审确认。</p>
              <button type="button" className={styles.primaryButton} onClick={submit}>提交负责人终审<Send size={16} aria-hidden="true" /></button>
            </div>}

            {role === "manager" && stage === "review" && <div className={styles.actionBody}><div className={styles.statusLine}><span className={styles.statusDot} />{assignee}提交的需求 · 版本 v{version} · 待终审</div><div className={styles.reviewBox}><span>需求描述</span><p>{description}</p><span>证据依据</span><p>{basis}</p></div><div className={styles.formRow}><label htmlFor="final-priority">确认最终优先级</label><select id="final-priority" value={priority} onChange={(event) => setPriority(event.target.value)}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></div><p className={styles.fieldNote}>此处仅演示负责人确认动作，尚无正式评分规则。</p><label htmlFor="return-reason">退回原因（退回时填写）</label><textarea id="return-reason" rows={2} placeholder="例如：请先核对现有 SKU 的裤长尺码" value={reason} onChange={(event) => setReason(event.target.value)} /><div className={styles.buttonRow}><button type="button" className={styles.secondaryButton} onClick={returnDraft}>退回修改</button><button type="button" className={styles.primaryButton} onClick={approve}>批准并交设计<ArrowRight size={16} aria-hidden="true" /></button></div></div>}

            {role === "staff" && stage === "review" && <div className={styles.actionBody}><div className={styles.statusLine}><span className={styles.statusDot} />已提交 · 等待负责人终审</div><p>提交后的版本保持为审核快照。负责人退回后才能继续修改。</p><button type="button" className={styles.secondaryButton} onClick={() => setRole("manager")}>查看负责人终审<ChevronRight size={16} aria-hidden="true" /></button></div>}

            {stage === "approved" && <div className={styles.actionBody}><div className={styles.approvedIcon}><Check size={25} aria-hidden="true" /></div><h4>需求已获终审批准</h4><p>批准版本将交给设计负责人。设计是否接收、退回及后续回应，会关联这份需求的版本。</p><div className={styles.handoff}><span>交接卡片</span><strong>REQ-DEMO-001 · {priority}</strong><p>{description}</p><small>经办人 {assignee} · 审批人 产品负责人 · 版本 v{version}</small></div><button type="button" className={styles.secondaryButton} onClick={reset}>重新走一遍流程<RotateCcw size={16} aria-hidden="true" /></button></div>}
          </section>
        </div>

        <div className={styles.bottomNote}><span>这页演示自动分析、对话与审核</span><p>智能体分析与对话均为预设模拟；尚未接入真实模型、客服数据、账号、数据库或设计端接口。</p></div>
      </div>
    </main>
  </div>;
}
