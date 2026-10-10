"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, ImagePlus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { appPath } from "@/app/lib/app-path";
import { PERSONAL_PREVIEW_DISCLAIMER, previewStatusLabels, type PersonalPreviewAvailability, type PersonalPreviewController, type PersonalPreviewTarget, type PersonalPreviewTask } from "@/app/lib/personal-preview-model";
import styles from "./personal-preview-panel.module.css";

export function PersonalPreviewPanel({ controller }: { controller: PersonalPreviewController }) {
  return controller.open ? <PreviewDialog controller={controller} /> : null;
}

const versionLabel = (target: PersonalPreviewTarget) => target.versionNo === null ? target.lookVersionId : String(target.versionNo);

function TargetSummary({ target, label }: { target: PersonalPreviewTarget; label: string }) {
  if (target.contentCleared) return <div className={styles.targetSummary}><h3>{label}</h3><p>搭配内容已按期限清除</p><p className={styles.note}>原搭配版本：{target.lookVersionId}。不使用当前搭配补齐历史。</p></div>;
  return <div className={styles.targetSummary}>
    <div className={styles.sectionHeading}><h3>{label}</h3><span>搭配版本 {versionLabel(target)}</span></div>
    <ul className={styles.items}>{target.items.map(item => <li key={item.slot}>
      <span>{({ top: "上衣", bottom: "下装", shoes: "鞋" } as Record<string, string>)[item.slot] ?? item.slot}</span>
      <div><strong>{item.name}</strong><small>{item.skuId}</small></div>
    </li>)}</ul>
    <p className={styles.note}>本次仅对应这三件商品。查看本人效果不会更改你的搭配。</p>
    <details className={styles.frozenDetails}>
      <summary>查看搭配冻结依据</summary>
      <dl><div><dt>选择摘要</dt><dd>{target.selectionDigest || "历史未记录"}</dd></div>{target.items.map(item => <div key={item.slot}>
        <dt>{({ top: "上衣", bottom: "下装", shoes: "鞋" } as Record<string, string>)[item.slot] ?? item.slot}参考图</dt>
        <dd><span>素材：{item.referenceAssetId || "历史未记录"}</span><span>版本：{item.referenceVersion || "历史未记录"}</span></dd>
      </div>)}</dl>
      <p>仅展示这个搭配版本留下的记录，不用当前商品资料补齐旧记录。</p>
    </details>
  </div>;
}

function MockNotice() {
  return <p className={styles.mockNotice}><ShieldCheck size={18} aria-hidden="true" /><span><strong>技术模拟</strong> · 非本人真实生成，不作为真实穿搭效果。</span></p>;
}

function TaskView({ controller, task }: { controller: PersonalPreviewController; task: PersonalPreviewTask }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [failedModelUrl, setFailedModelUrl] = useState<string | null>(null);
  const deleted = task.deletion === "deleted";
  const deleting = task.deletion === "deleting" || controller.deletionPending;
  const unavailable = deleted || deleting || task.status === "expired" || task.selectionStatus === "content_cleared";
  const personalAvailable = !unavailable && task.hasResult && (task.status === "succeeded" || task.status === "output_pending_review");
  const personalImage = personalAvailable && controller.imageMode === "personal" ? controller.imageUrl : null;
  const modelImage = !unavailable && controller.imageMode === "model" ? task.modelImagePath ? controller.modelImageUrl ?? null : task.target.modelUrl ? appPath(task.target.modelUrl) : null : null;
  const personalFailed = !!personalImage && failedUrl === personalImage;
  const modelFailed = !!modelImage && failedModelUrl === modelImage;
  const pending = ["queued", "running", "provider_unknown"].includes(task.status);

  useEffect(() => {
    if (!unavailable && task.modelImagePath && controller.imageMode === "model" && !controller.modelImageUrl && !controller.modelImageLoading && !controller.modelImageError) controller.reloadModelImage?.();
  }, [unavailable, task.modelImagePath, controller]);

  return <section className={styles.task} aria-label="当前本人效果任务">
    <div className={styles.sectionHeading}><h3>本次效果</h3><span className={styles.status} role="status">{deleted ? "已删除" : deleting ? "删除处理中" : previewStatusLabels[task.status]}</span></div>
    {task.mode === "mock" && <MockNotice />}
    {task.selectionStatus === "content_cleared" && <p className={styles.note}>搭配内容已按期限清除。原任务、请求及搭配版本编号保留，不重新生成。</p>}
    <p className={styles.taskDetail}>{task.detail}</p>
    <dl className={styles.taskMeta}><div><dt>任务编号</dt><dd>{task.id}</dd></div><div><dt>生成时搭配</dt><dd>版本 {versionLabel(task.target)}</dd></div></dl>
    {task.status === "provider_unknown" && !unavailable && <p className={styles.warning}>暂时无法确认生成服务是否已受理或完成。请查询原任务；不会自动再提交，也不能据此认定未计费。</p>}
    {task.status === "output_pending_review" && !unavailable && <p className={styles.warning}>画面与完整三件商品仍待核对，暂不算生成成功。</p>}
    {task.status === "failed" && !unavailable && <p className={styles.warning}>这次生成没有可交付的本人效果。不会用模特图替代成功结果，也不会自动重做。</p>}
    {task.status === "expired" && !deleted && <p className={styles.warning}>该任务或效果已过期，不能继续显示原图片。过期不代表生成服务已取消或没有计费。</p>}
    {deleting && <p className={styles.warning}>正在撤销本页访问并处理删除，服务端是否完成以重新查询的状态为准。生成服务可能仍在处理或计费。</p>}
    {deleted && <p className={styles.note}>服务端已报告删除；本页不再展示照片或结果。这不代表生成服务方已完成删除，也不影响原搭配和穿搭资料。</p>}

    {!unavailable && <div className={styles.imageSwitch} role="group" aria-label="查看效果图片">
      <button type="button" aria-pressed={controller.imageMode === "model"} disabled={!task.target.modelUrl && !task.modelImagePath} onClick={() => controller.setImageMode("model")}>固定模特</button>
      <button type="button" aria-pressed={controller.imageMode === "personal"} disabled={!personalAvailable} onClick={() => controller.setImageMode("personal")}>本人效果</button>
    </div>}
    {!unavailable && <div className={styles.resultLayout}>
      <div className={styles.resultImage}>
        {modelImage && !modelFailed ? <>
          {/* The frozen model URL must remain distinct from the private result; neither image uses an optimizer or observation events. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={modelImage} src={modelImage} alt={`版本 ${versionLabel(task.target)} 的固定模特搭配参考`} onError={event => { if (event.currentTarget.isConnected) setFailedModelUrl(modelImage); }} />
          <span>固定模特参考 · 不是本人效果</span>
        </> : personalImage && !personalFailed ? <>
          {/* Private object URLs are owned and revoked by the controller; never send them through an image proxy. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={personalImage} src={personalImage} alt={task.mode === "mock" ? "技术模拟的效果图，非本人真实生成" : `版本 ${versionLabel(task.target)} 的本人 AI 穿搭效果参考`} onError={event => { if (event.currentTarget.isConnected) setFailedUrl(personalImage); }} />
          <span>{task.mode === "mock" ? "技术模拟 · 非本人真实生成" : "本人 AI 穿搭效果参考"}</span>
        </> : <div className={styles.imageEmpty} role="status"><ImagePlus size={30} aria-hidden="true" /><p>{modelFailed ? "这张固定模特参考图暂时无法显示，不影响本人效果的任务状态。" : controller.imageLoading ? "正在读取本人效果…" : controller.modelImageLoading ? "正在读取原模特图片…" : controller.imageMode === "personal" ? "暂时没有可显示的本人效果" : "该历史版本没有模特参考图"}</p></div>}
      </div>
      <TargetSummary target={task.target} label="生成当时的搭配" />
    </div>}
    {!unavailable && (personalFailed || controller.imageError) && <div className={styles.error} role="alert">{personalFailed && <p>本人效果图片暂时无法显示，可重新读取原结果，不会重新生成。</p>}{controller.imageError && <p>{controller.imageError}</p>}<p>这是图片读取状态，不会重新生成。</p><button type="button" className={styles.secondary} disabled={controller.imageLoading} onClick={controller.reloadImage}>重新读取本人效果</button></div>}
    {!unavailable && (modelFailed || controller.modelImageError) && <div className={styles.error} role="alert"><p>{controller.modelImageError || "原模特图片暂时无法显示。"}</p><button type="button" className={styles.secondary} disabled={controller.modelImageLoading} onClick={() => { setFailedModelUrl(null); controller.reloadModelImage?.(); }}>重新读取原模特图片</button></div>}
    {personalAvailable && controller.imageUrl && <a className={styles.secondary} href={controller.imageUrl} download={`${task.mode === "mock" ? "mock-output" : "personal-ai-reference"}-${task.id}.jpg`}>{task.mode === "mock" ? "下载技术模拟图" : "下载本人AI参考图"}</a>}
    <p className={styles.note}>{PERSONAL_PREVIEW_DISCLAIMER}</p>
    {task.expiresAt && <p className={styles.note}>效果到期时间：{task.expiresAt}</p>}
    <div className={styles.actions}>
      <button type="button" className={styles.secondary} disabled={controller.deletionPending} onClick={controller.refreshTask}><RefreshCw size={15} aria-hidden="true" />查询原任务</button>
      {controller.waiting && pending && !unavailable && <button type="button" className={styles.secondary} onClick={controller.stopWaiting}>停止等待</button>}
      {!deleted && !deleting && <button type="button" className={styles.dangerLink} onClick={() => setConfirmDelete(true)}><Trash2 size={15} aria-hidden="true" />删除这次照片与效果</button>}
    </div>
    {pending && !unavailable && <p className={styles.note}>{controller.waiting ? "可离开页面，或停止等待。停止等待只停止本页查询，不会取消生成服务的任务。" : "当前没有自动等待。可查询原任务，不会重新生成。"}</p>}
    {confirmDelete && !deleted && !deleting && <div className={styles.deleteConfirm} role="group" aria-label="确认删除这次照片与效果">
      <strong>确定删除这次照片与效果？</strong>
      <p>确认后撤销本页图片访问并向服务端申请删除。未完成的生成可能仍在运行或计费；不会删除搭配历史、穿搭资料或其他任务。</p>
      <div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => setConfirmDelete(false)}>保留这次效果</button><button type="button" className={styles.danger} onClick={() => { setConfirmDelete(false); controller.deleteTask(); }}>确认删除</button></div>
    </div>}
  </section>;
}

function PreviewDialog({ controller: c }: { controller: PersonalPreviewController }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const title = useId();
  const description = useId();
  const photoErrorId = useId();
  const [consent, setConsent] = useState<{ photo: File; target: PersonalPreviewTarget; availability: PersonalPreviewAvailability | null } | null>(null);
  const accepted = !!consent && consent.photo === c.photo?.file && consent.target === c.target && consent.availability === c.availability && !c.targetChanged && c.identityReady;
  const activeTask = c.task?.deletion === "active" && ["queued", "running", "provider_unknown"].includes(c.task.status);
  const canConfirm = c.identityReady && !!c.target && !!c.photo && !c.photoError && !!c.availability?.available && !!c.availability.permit && !c.availabilityLoading && !c.targetChanged && !c.submitting && !c.uncertain && !c.deletionPending && !activeTask && accepted;
  const photoLocked = !c.identityReady || c.submitting || c.uncertain;

  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (node && !node.open) node.showModal();
    closeButton.current?.focus();
    return () => {
      if (node?.open) node.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function handleKey(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") { event.preventDefault(); c.closePanel(); return; }
    if (event.key !== "Tab") return;
    const node = dialog.current;
    const focusable = node ? Array.from(node.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled):not([type=hidden]),summary,[href],[tabindex]:not([tabindex='-1'])")).filter(item => !item.hidden && item.tabIndex >= 0) : [];
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (!first) { event.preventDefault(); node?.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-modal="true" aria-labelledby={title} aria-describedby={description} onCancel={event => { event.preventDefault(); c.closePanel(); }} onKeyDown={handleKey} onClick={event => { if (event.target === event.currentTarget) c.closePanel(); }}>
    <div className={styles.shell}>
      <header className={styles.header}><div><span className={styles.eyebrow}>为你多看一步</span><h2 id={title}>看看我穿的效果</h2></div><button ref={closeButton} type="button" className={styles.close} aria-label="关闭本人效果" onClick={c.closePanel}><X size={21} aria-hidden="true" /></button></header>
      <div className={styles.body}>
        <p id={description} className={styles.introduction}>先选一张本人照片，再确认这套搭配。选择照片只在本页预览，确认生成后才会上传。</p>
        {!c.identityReady && <p className={styles.warning} role="status">当前身份尚未就绪，暂不能选择照片、生成或查看私有历史。请先恢复当前身份。</p>}
        <div className={styles.selection}>
          <section className={styles.photoCard} aria-label="本地照片选择">
            <div className={styles.sectionHeading}><h3>你的照片</h3><span>仅本次使用</span></div>
            <div className={styles.photoPreview}>{c.identityReady && c.photo ? <>
              {/* This local file preview never passes through a remote optimizer or analytics component. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.photo.url} alt="本地所选本人照片，尚未确认上传" />
              <span>本地预览</span>
            </> : <div className={styles.imageEmpty}><ImagePlus size={34} aria-hidden="true" /><p>选择一张清楚的全身照</p><small>单人、正面、光线清楚</small></div>}</div>
            <input ref={input} type="file" hidden tabIndex={-1} accept="image/jpeg,image/png,image/webp" aria-label="选择本人照片" aria-invalid={!!c.photoError} aria-describedby={c.photoError ? photoErrorId : undefined} disabled={photoLocked} onChange={event => {
              const file = event.currentTarget.files?.[0];
              if (file) { setConsent(null); c.selectPhoto(file); }
              event.currentTarget.value = "";
            }} />
            <div className={styles.actions}><button type="button" className={styles.secondary} disabled={photoLocked} onClick={() => input.current?.click()}><ImagePlus size={16} aria-hidden="true" />{c.identityReady && c.photo ? "重新选择照片" : "选择照片"}</button>{c.identityReady && c.photo && <button type="button" className={styles.textButton} disabled={photoLocked} onClick={() => { setConsent(null); c.removePhoto(); }}>移除照片</button>}</div>
            {c.photoError && <p id={photoErrorId} className={styles.error} role="alert">{c.photoError}</p>}
            <p className={styles.note}>支持 JPEG、PNG、WebP。关闭或刷新前尚未确认的照片不会保留，需要重新选择。</p>
          </section>
          <section className={styles.targetCard} aria-label="本次生成搭配">
            {c.identityReady && c.target ? <TargetSummary target={c.target} label="这次搭配" /> : <div className={styles.empty}><h3>这次搭配</h3><p>先生成一套完整搭配，再来查看本人效果。</p></div>}
            {c.targetChanged && <div className={styles.warning} role="status"><strong>当前搭配已经变化</strong><p>这里仍保留刚才选中的版本。请明确改用当前搭配，再重新核对照片和三件商品。</p><button type="button" className={styles.secondary} disabled={!c.identityReady || c.submitting || c.uncertain} onClick={() => { setConsent(null); c.useCurrentTarget(); }}>改用当前搭配并重新核对</button></div>}
            <div className={styles.availability} aria-busy={c.availabilityLoading}>
              {c.availabilityLoading ? <p role="status">正在核对这套搭配的生成条件…</p> : !c.availability ? <p role="status">尚未读取生成条件，现在不能提交。</p> : <>
                {c.availability.mode === "mock" && <MockNotice />}
                <strong>{c.availability.available ? "生成条件已读取" : "这套搭配暂时不能生成本人效果"}</strong>
                {c.availability.reasons.length > 0 && <ul>{c.availability.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
                <dl className={styles.serviceNotes}><div><dt>用途</dt><dd>{c.availability.purposeNote}</dd></div><div><dt>保留与删除</dt><dd>{c.availability.retentionNote}</dd></div><div><dt>额度与费用</dt><dd>{c.availability.costNote}</dd></div></dl>
              </>}
              <button type="button" className={styles.textButton} disabled={!c.identityReady || !c.target || c.target.contentCleared || c.availabilityLoading || c.submitting || c.uncertain} onClick={c.refreshAvailability}><RefreshCw size={15} aria-hidden="true" />重新读取生成条件</button>
            </div>
          </section>
        </div>
        {c.error && <p className={styles.error} role="alert">{c.error}</p>}
        {c.recoveryNotice && <p className={styles.note} role="status">{c.recoveryNotice}</p>}
        {c.uncertain && <div className={styles.warning} role="status"><strong>本次提交结果尚未确认</strong><p>请先查询原请求。不会自动重新上传、另建任务或再次生成。</p>{c.requestId && <p className={styles.identifier}>原请求编号：{c.requestId}</p>}
          {!c.canRetry || !c.retryRequest ? <p>本次照片或确认已不在内存，需要查询原记录；不会自动新建。</p> : <p>原照片与原编号仍可用于明确重试，重试不会改用当前照片或搭配。</p>}
          <div className={styles.actions}><button type="button" className={styles.secondary} disabled={!c.identityReady || c.submitting} onClick={c.checkRequest}>查询原请求</button>
            {c.canRetry && c.retryRequest && <button type="button" className={styles.secondary} disabled={!c.identityReady || c.submitting} onClick={() => { if (c.identityReady && !c.submitting && c.canRetry) c.retryRequest?.(); }}>用原照片和原编号重试提交</button>}
          </div>
        </div>}
        {c.identityReady && c.task && <TaskView key={c.task.id} controller={c} task={c.task} />}
        <section className={styles.history} aria-label="本人效果历史">
          <div className={styles.sectionHeading}><h3>我的效果历史</h3><button type="button" className={styles.textButton} disabled={!c.identityReady || c.historyLoading} onClick={c.refreshHistory}>刷新历史</button></div>
          <p className={styles.note}>只显示本浏览器当前身份可访问的任务；查看历史不会重新生成。</p>
          {c.identityReady && (c.historyLoading ? <p role="status">正在读取效果历史…</p> : c.historyError ? <p role="alert" className={styles.error}>{c.historyError}</p> : c.tasks.length === 0 ? <p className={styles.empty}>还没有本人效果记录。选择照片后，你仍可以决定暂不生成。</p> : <ul className={styles.historyList}>{c.tasks.map(task => <li key={task.id}><div><strong>搭配版本 {versionLabel(task.target)}</strong><span>{task.deletion === "deleted" ? "已删除" : task.deletion === "deleting" ? "删除处理中" : previewStatusLabels[task.status]}{task.mode === "mock" ? " · 技术模拟，非本人真实生成" : ""}</span><small>{task.createdAt}</small></div><button type="button" className={styles.secondary} disabled={c.deletionPending || c.submitting} aria-label={`查看任务 ${task.id}`} onClick={() => c.viewTask(task)}>查看<ArrowRight size={15} aria-hidden="true" /></button></li>)}</ul>)}
        </section>
        <p className={styles.sharedNote}><ShieldCheck size={18} aria-hidden="true" /><span>共享设备使用后，请主动删除本人照片与效果。清除穿搭资料不会删除图片；清除站点数据或身份过期可能无法找回历史。{PERSONAL_PREVIEW_DISCLAIMER}</span></p>
      </div>
      <footer className={styles.footer}>
        <label className={styles.consent}><input type="checkbox" checked={accepted} disabled={!c.identityReady || !c.photo || !c.target || c.targetChanged || c.submitting || c.uncertain} onChange={event => setConsent(event.currentTarget.checked && c.photo && c.target ? { photo: c.photo.file, target: c.target, availability: c.availability } : null)} /><span>我确认有权使用这张照片，并授权用于本次穿搭效果；我已核对搭配，并同意以上用途、保留规则及费用说明。</span></label>
        <div className={styles.footerActions}><p>{c.submitting ? "正在提交本次确认，请勿重复操作…" : activeTask ? "原任务仍在处理中，请先查看任务状态。" : "选照不上传；只有这次确认才会提交。"}</p><button type="button" className={styles.secondary} onClick={c.closePanel}>暂不生成</button><button type="button" className={styles.primary} disabled={!canConfirm} onClick={() => { if (canConfirm) { setConsent(null); c.confirm(); } }}>{c.submitting ? "正在提交…" : "确认生成"}<ArrowRight size={17} aria-hidden="true" /></button></div>
      </footer>
    </div>
  </dialog>;
}
