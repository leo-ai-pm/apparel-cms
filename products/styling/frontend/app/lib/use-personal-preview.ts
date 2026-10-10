"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { discardOtherPreviewPointers, readPreviewPointer, writePreviewPointer, type PersonalPreviewPointer } from "./personal-preview-pointer";
import { useLocalPersonalPhoto } from "./use-local-personal-photo";
import { PersonalPreviewError, unavailablePreviewService, type PersonalPreviewAvailability, type PersonalPreviewController, type PersonalPreviewService, type PersonalPreviewSubmission, type PersonalPreviewTarget, type PersonalPreviewTask } from "./personal-preview-model";

type State = {
  open: boolean; target: PersonalPreviewTarget | null; availability: PersonalPreviewAvailability | null;
  availabilityLoading: boolean; submitting: boolean; error: string; uncertain: boolean; requestId: string | null;
  task: PersonalPreviewTask | null; tasks: PersonalPreviewTask[]; historyLoading: boolean; historyError: string;
  waiting: boolean; imageUrl: string | null; imageLoading: boolean; imageError: string;
  modelImageUrl: string | null; modelImageLoading: boolean; modelImageError: string;
  imageMode: "model" | "personal"; deletionPending: boolean; revoked: boolean; canRetry: boolean; recoveryNotice: string;
};
const initial = (): State => ({ open: false, target: null, availability: null, availabilityLoading: false,
  submitting: false, error: "", uncertain: false, requestId: null, task: null, tasks: [], historyLoading: false,
  historyError: "", waiting: false, imageUrl: null, imageLoading: false, modelImageUrl: null, modelImageLoading: false, imageError: "", modelImageError: "", imageMode: "model",
  deletionPending: false, revoked: false, canRetry: false, recoveryNotice: "" });
const ongoing = (task: PersonalPreviewTask) => ["queued", "running", "provider_unknown"].includes(task.status) && task.deletion === "active";
const readable = (task: PersonalPreviewTask) => task.deletion === "active" && task.hasResult && ["succeeded", "output_pending_review"].includes(task.status);
const sameTarget = (a: PersonalPreviewTarget | null, b: PersonalPreviewTarget | null) => !!a && !!b && a.sessionId === b.sessionId && a.lookVersionId === b.lookVersionId;

function createLifetime() {
  return { active: true, revoked: false, controllers: new Set<AbortController>(), urls: new Set<string>(),
    tombstones: new Map<string, "deleting" | "deleted">(), deleteIds: new Map<string, string>(), request: null as PersonalPreviewSubmission | null,
    binding: null as PersonalPreviewPointer | null, submitLock: false, readLock: false, readEpoch: 0, readAbort: null as AbortController | null, waitWanted: false, selectedId: null as string | null, availabilitySerial: 0, taskSerial: 0, imageSerial: 0, historySerial: 0 };
}

/** UI lifecycle independent of wire format. Only an explicit confirm can call service.submit. */
export function usePersonalPreview({ currentTarget, identityKey, identityReady, onIdentityInvalid, sessionKey = "current", persistRecovery = false,
  service = unavailablePreviewService }: { currentTarget: PersonalPreviewTarget | null; identityKey: string;
  identityReady: boolean; sessionKey?: string; persistRecovery?: boolean; onIdentityInvalid: () => void; service?: PersonalPreviewService }): PersonalPreviewController {
  // Each identity/adapter lifetime owns callbacks and private object URLs. No file, image, token or body is persisted.
  const scope = useMemo(() => ({ identityKey, identityReady, service }), [identityKey, identityReady, service]);
  const lifetimes = useRef(new Map<typeof scope, ReturnType<typeof createLifetime>>());
  function life() {
    let value = lifetimes.current.get(scope);
    if (!value) { value = createLifetime(); lifetimes.current.set(scope, value); }
    return value;
  }
  const [record, setRecord] = useState({ scope, value: initial() });
  const state = record.scope === scope ? record.value : initial();
  if (record.scope !== scope) setRecord({ scope, value: initial() });
  const allowed = identityReady && !state.revoked;
  const local = useLocalPersonalPhoto(`${identityKey}:${sessionKey}:${state.open}`, allowed);
  const targetChanged = state.target !== null && !sameTarget(state.target, currentTarget);
  function update(patch: Partial<State> | ((state: State) => Partial<State>)) {
    if (!life().active) return;
    setRecord(previous => {
      const value = previous.scope === scope ? previous.value : initial();
      return { scope, value: { ...value, ...(typeof patch === "function" ? patch(value) : patch) } };
    });
  }
  const valid = () => life().active && !life().revoked && identityReady;
  function requestSignal() { const controller = new AbortController(); life().controllers.add(controller); return controller; }
  function cancelRead() {
    life().readEpoch++; life().readAbort?.abort(); life().readAbort = null; life().readLock = false;
  }
  function clearDefinitivePointer(cause: unknown) {
    if (!(cause instanceof PersonalPreviewError) || !cause.definitive) return;
    if (persistRecovery) writePreviewPointer(identityKey, null);
    life().binding = null; service.releaseSensitive?.();
    update({ requestId: null, canRetry: false, recoveryNotice: "这次提交已明确被拒绝。请核对原因，再重新选择照片并明确确认。" });
  }
  function revokeImages() { life().imageSerial++; for (const url of life().urls) URL.revokeObjectURL(url); life().urls.clear(); }
  function handleError(cause: unknown, field: "error" | "historyError" | "imageError" | "modelImageError" = "error") {
    if (!life().active) return;
    if (cause instanceof PersonalPreviewError && cause.identityInvalid) {
      if (persistRecovery) writePreviewPointer(identityKey, null);
      service.releaseSensitive?.(); life().binding = null; life().revoked = true; life().request = null; life().submitLock = false;
      for (const controller of life().controllers) controller.abort();
      revokeImages(); local.clear();
      update({ ...initial(), open: state.open, revoked: true, error: "身份或照片授权已失效。本地照片与私有结果已清除，请重新确认当前身份。" });
      onIdentityInvalid();
    } else if (valid()) update({ [field]: cause instanceof Error ? cause.message : "读取未完成，请稍后查询原记录。" });
  }
  useEffect(() => {
    let owner = lifetimes.current.get(scope);
    if (!owner) { owner = createLifetime(); lifetimes.current.set(scope, owner); }
    owner.active = true;
    return () => {
      owner.active = false; owner.request = null; service.releaseSensitive?.();
      for (const controller of owner.controllers) controller.abort();
      for (const url of owner.urls) URL.revokeObjectURL(url);
      owner.urls.clear();
    };
  }, [scope, service]);

  async function loadAvailability(target: PersonalPreviewTarget | null) {
    const serial = ++life().availabilitySerial;
    if (!valid() || !target) { update({ availability: null, availabilityLoading: false }); return; }
    update({ availability: null, availabilityLoading: true, error: "" });
    const control = requestSignal();
    try {
      const availability = await service.availability(target, control.signal);
      if (valid() && serial === life().availabilitySerial) {
        if (availability.selection && !sameTarget(target, availability.selection)) throw new PersonalPreviewError("服务端生成条件与选中的搭配版本不一致，请重新核对。", false, true);
        update({ availability, ...(availability.selection ? { target: availability.selection } : {}) });
      }
    } catch (cause) { if (serial === life().availabilitySerial) handleError(cause); }
    finally { life().controllers.delete(control); if (valid() && serial === life().availabilitySerial) update({ availabilityLoading: false }); }
  }
  function normalizeTask(task: PersonalPreviewTask): PersonalPreviewTask {
    const known = life().tombstones.get(task.id);
    const deletion = known === "deleted" || task.deletion === "deleted" ? "deleted"
      : known === "deleting" || task.deletion === "deleting" ? "deleting" : "active";
    if (deletion !== "active") {
      life().tombstones.set(task.id, deletion);
      return { ...task, deletion, hasResult: false };
    }
    return task;
  }
  async function refreshHistory() {
    if (!valid()) return;
    const serial = ++life().historySerial; const control = requestSignal();
    update({ historyLoading: true, historyError: "" });
    try {
      const tasks = await service.history(control.signal);
      if (valid() && serial === life().historySerial) {
        const normalized = tasks.map(normalizeTask);
        const removed = normalized.find(task => task.id === life().selectedId && (task.deletion !== "active" || task.status === "expired"));
        if (removed) { life().waitWanted = false; revokeImages(); }
        update(value => ({ tasks: normalized, ...(removed && value.task?.id === removed.id ? {
          task: removed, imageUrl: null, imageLoading: false, modelImageUrl: null, modelImageLoading: false, imageMode: "model" as const, waiting: false,
        } : {}) }));
      }
    } catch (cause) { if (serial === life().historySerial) handleError(cause, "historyError"); }
    finally { life().controllers.delete(control); if (valid() && serial === life().historySerial) update({ historyLoading: false }); }
  }
  function acceptTask(task: PersonalPreviewTask) {
    if (!valid()) return;
    task = normalizeTask(task); life().availabilitySerial++; life().selectedId = task.id;
    const pointer: PersonalPreviewPointer = { version: 1, requestId: task.requestId, taskId: task.id, sessionId: task.target.sessionId, lookVersionId: task.target.lookVersionId };
    life().binding = pointer;
    if (persistRecovery) writePreviewPointer(identityKey, pointer);
    if (!readable(task)) revokeImages();
    update(value => ({ task, target: task.target, availability: null, availabilityLoading: false, canRetry: false, recoveryNotice: "", tasks: [task, ...value.tasks.filter(row => row.id !== task.id)],
      uncertain: false, requestId: task.requestId, waiting: life().waitWanted && value.open && ongoing(task),
      ...(!readable(task) ? { imageUrl: null, imageLoading: false, modelImageUrl: null, modelImageLoading: false, imageMode: "model" as const } : {}) }));
    life().request = null;
  }
  function openPanel() {
    life().waitWanted = true; update({ open: true, waiting: !!state.task && ongoing(state.task) });
    if (persistRecovery && valid()) discardOtherPreviewPointers(identityKey);
    const pointer = persistRecovery && valid() && !state.requestId ? readPreviewPointer(identityKey) : null;
    if (pointer) {
      life().binding = pointer;
      update({ target: null, requestId: pointer.requestId, uncertain: true, canRetry: false,
        recoveryNotice: "已恢复原请求编号，正在查询记录。照片和确认令牌未保存，不会自动重新上传。" });
      void lookup(pointer);
    } else if (!state.task && !state.uncertain && !state.submitting) { update({ target: currentTarget }); void loadAvailability(currentTarget); }
    void refreshHistory();
  }
  function closePanel() {
    cancelRead(); life().waitWanted = false; life().availabilitySerial++; life().taskSerial++; revokeImages(); local.clear();
    // Accepted/uncertain requests remain queryable; closing never cancels a remote job.
    if (life().request) life().request = null;
    service.releaseSensitive?.();
    update({ open: false, canRetry: false, waiting: false, imageUrl: null, imageLoading: false, modelImageUrl: null, modelImageLoading: false, imageMode: "model", availabilityLoading: false });
  }
  function useCurrentTarget() {
    if (!valid() || state.submitting || state.uncertain) return;
    cancelRead(); life().waitWanted = false; life().selectedId = null; life().taskSerial++; revokeImages(); life().request = null; life().binding = null; service.releaseSensitive?.();
    if (persistRecovery) writePreviewPointer(identityKey, null);
    update({ canRetry: false, recoveryNotice: "", target: currentTarget, task: null, requestId: null, error: "", imageUrl: null, imageError: "", modelImageError: "", imageMode: "model", waiting: false });
    void loadAvailability(currentTarget);
  }
  async function confirm() {
    if (!valid() || life().submitLock || state.submitting || state.uncertain || !state.open || !local.photo || !state.target || targetChanged || !state.availability?.available || !state.availability.permit) return;
    const request: PersonalPreviewSubmission = { requestId: crypto.randomUUID(), target: state.target, photo: local.photo.file, permit: state.availability.permit };
    const pointer: PersonalPreviewPointer = { version: 1, requestId: request.requestId, taskId: null, sessionId: request.target.sessionId, lookVersionId: request.target.lookVersionId };
    if (persistRecovery && !writePreviewPointer(identityKey, pointer)) { update({ error: "无法保存安全的请求恢复编号，尚未上传。请允许本页会话存储后再确认。" }); return; }
    life().binding = pointer;
    life().submitLock = true; life().selectedId = null; life().waitWanted = true; life().taskSerial++; revokeImages();
    life().request = request;
    const control = requestSignal();
    update({ submitting: true, error: "", task: null, requestId: request.requestId, imageUrl: null, imageMode: "model", availability: null });
    // Release the preview as soon as the user confirms. The request owns the temporary File until settlement.
    local.clear();
    try {
      const task = await service.submit(request, control.signal);
      if (!valid()) return;
      if (task.requestId !== request.requestId || !sameTarget(task.target, request.target)) throw new PersonalPreviewError("响应与原请求或搭配版本不一致，请查询原请求；不会重建提交。");
      acceptTask(task);
    } catch (cause) {
      if (!valid()) return;
      update({ uncertain: !(cause instanceof PersonalPreviewError && cause.definitive), waiting: false, canRetry: false });
      clearDefinitivePointer(cause); handleError(cause);
    } finally { life().controllers.delete(control); life().request = null; life().submitLock = false; if (valid()) update({ submitting: false }); }
  }
  async function lookup(pointer: PersonalPreviewPointer) {
    if (!valid() || life().readLock) return;
    life().readLock = true; const readEpoch = ++life().readEpoch; const serial = life().taskSerial; const control = requestSignal(); life().readAbort = control;
    update({ error: "", canRetry: false });
    try {
      const task = await service.findRequest(pointer.requestId, control.signal);
      if (!valid() || serial !== life().taskSerial) return;
      if (task && (task.requestId !== pointer.requestId || pointer.taskId !== null && task.id !== pointer.taskId || task.target.sessionId !== pointer.sessionId || task.target.lookVersionId !== pointer.lookVersionId)) throw new PersonalPreviewError("查询返回的请求编号不一致或冻结搭配不一致，原请求保留。");
      if (task) acceptTask(task);
      else update({ uncertain: true, canRetry: service.canRetry?.(pointer.requestId) ?? false,
        error: "尚未查到原请求，不能据此认定未调用。请稍后查询；不会自动换编号或重新上传。" });
    } catch (cause) { if (serial === life().taskSerial) handleError(cause); }
    finally { life().controllers.delete(control); if (readEpoch === life().readEpoch) { life().readLock = false; life().readAbort = null; } }
  }
  function checkRequest() {
    const pointer = life().binding ?? (state.requestId && state.target ? { version: 1 as const, requestId: state.requestId, taskId: state.task?.id ?? null, sessionId: state.target.sessionId, lookVersionId: state.target.lookVersionId } : null);
    if (pointer) void lookup(pointer);
  }
  async function retryRequest() {
    const pointer = life().binding;
    if (!valid() || life().submitLock || !pointer || !state.canRetry || !service.retry || !service.canRetry?.(pointer.requestId)) {
      update({ canRetry: false, error: "原照片或确认已不在有效内存中，不能重发。请继续查询原记录；不会自动新建任务。" }); return;
    }
    life().submitLock = true; const control = requestSignal();
    update({ submitting: true, canRetry: false, error: "" });
    try {
      const task = await service.retry(pointer.requestId, control.signal);
      if (!valid()) return;
      if (task.requestId !== pointer.requestId || pointer.taskId !== null && task.id !== pointer.taskId || task.target.sessionId !== pointer.sessionId || task.target.lookVersionId !== pointer.lookVersionId) throw new PersonalPreviewError("重试返回与原请求不一致，请继续查询原记录。");
      acceptTask(task);
    } catch (cause) { if (valid()) { update({ uncertain: !(cause instanceof PersonalPreviewError && cause.definitive) }); clearDefinitivePointer(cause); handleError(cause); } }
    finally { life().controllers.delete(control); life().submitLock = false; if (valid()) update({ submitting: false }); }
  }
  async function refreshTask() {
    if (!valid() || life().readLock || !state.task || state.deletionPending) return;
    life().readLock = true; const readEpoch = ++life().readEpoch; const serial = life().taskSerial; const control = requestSignal(); life().readAbort = control;
    try {
      const task = await service.task(state.task.id, control.signal);
      if (!valid() || serial !== life().taskSerial) return;
      if (task.id !== state.task.id || task.requestId !== state.task.requestId || !sameTarget(task.target, state.task.target)) throw new PersonalPreviewError("任务版本核对不一致，已有记录保留。");
      acceptTask(task);
    } catch (cause) { if (serial === life().taskSerial) { update({ waiting: false }); handleError(cause); } }
    finally { life().controllers.delete(control); if (readEpoch === life().readEpoch) { life().readLock = false; life().readAbort = null; } }
  }
  const poll = useEffectEvent(() => { void refreshTask(); });
  useEffect(() => {
    if (!state.open || !state.waiting || !allowed || !state.task || !ongoing(state.task)) return;
    const timer = window.setInterval(poll, 4000);
    return () => window.clearInterval(timer);
  }, [state.open, state.waiting, state.task, allowed]);
  async function reloadImage() {
    const task = state.task;
    if (!valid() || !task || !task.hasResult || task.deletion !== "active" || life().tombstones.has(task.id) || !["succeeded", "output_pending_review"].includes(task.status)) return;
    revokeImages(); const serial = life().imageSerial; const control = requestSignal();
    update({ imageUrl: null, imageLoading: true, modelImageUrl: null, modelImageLoading: false, imageError: "" });
    try {
      const blob = await service.image(task, control.signal);
      if (!valid() || serial !== life().imageSerial || life().tombstones.has(task.id)) return;
      if (!blob.size || !["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new Error("结果图片格式无效。可重新读取原结果，不会重新生成。");
      const url = URL.createObjectURL(blob); life().urls.add(url); update({ imageUrl: url });
    } catch (cause) { if (serial === life().imageSerial) handleError(cause, "imageError"); }
    finally { life().controllers.delete(control); if (valid() && serial === life().imageSerial) update({ imageLoading: false }); }
  }
  async function reloadModelImage() {
    const task = state.task;
    if (!valid() || !task || !service.modelImage || !task.modelImagePath || task.selectionStatus !== "available" || task.deletion !== "active" || task.status === "expired" || life().tombstones.has(task.id)) return;
    revokeImages(); const serial = life().imageSerial; const control = requestSignal();
    update({ imageUrl: null, imageLoading: false, modelImageUrl: null, modelImageLoading: true, modelImageError: "" });
    try {
      const blob = await service.modelImage(task, control.signal);
      if (!valid() || serial !== life().imageSerial || life().tombstones.has(task.id) || life().selectedId !== task.id) return;
      if (!blob.size || blob.type !== "image/png") throw new Error("原模特图片无法核对，可重新读取原图片。");
      const url = URL.createObjectURL(blob); life().urls.add(url); update({ modelImageUrl: url });
    } catch (cause) { if (serial === life().imageSerial) handleError(cause, "modelImageError"); }
    finally { life().controllers.delete(control); if (valid() && serial === life().imageSerial) update({ modelImageLoading: false }); }
  }
  function viewTask(task: PersonalPreviewTask) {
    if (!valid() || life().submitLock || state.uncertain) return;
    cancelRead(); life().availabilitySerial++; life().waitWanted = false; life().taskSerial++; revokeImages(); local.clear();
    const safe = normalizeTask(task); life().selectedId = task.id;
    const pointer: PersonalPreviewPointer = { version: 1, requestId: task.requestId, taskId: task.id, sessionId: task.target.sessionId, lookVersionId: task.target.lookVersionId };
    life().binding = pointer;
    if (persistRecovery) writePreviewPointer(identityKey, pointer);
    update({ task: safe, target: safe.target, requestId: safe.requestId, imageUrl: null, imageLoading: false, modelImageUrl: null, modelImageLoading: false, imageError: "", modelImageError: "", imageMode: "model", waiting: false, error: "", availability: null, availabilityLoading: false });
  }
  async function deleteTask() {
    const task = state.task;
    if (!valid() || !task || state.deletionPending || task.deletion === "deleted") return;
    life().waitWanted = false; const serial = ++life().taskSerial; life().historySerial++; life().tombstones.set(task.id, "deleting"); revokeImages();
    const actionId = life().deleteIds.get(task.id) ?? crypto.randomUUID(); life().deleteIds.set(task.id, actionId);
    const control = requestSignal();
    update(value => ({ imageUrl: null, imageLoading: false, modelImageUrl: null, modelImageLoading: false, imageMode: "model", waiting: false, historyLoading: false, deletionPending: true, error: "",
      task: { ...task, deletion: "deleting", hasResult: false }, tasks: value.tasks.map(row => row.id === task.id ? { ...row, deletion: "deleting", hasResult: false } : row) }));
    try {
      let deleted = await service.remove(task, actionId, control.signal);
      if (!valid()) return;
      if (deleted.id !== task.id || deleted.deletion === "active") throw new Error("本地访问已撤销，服务端删除尚未确认，请查询删除状态。");
      if (life().tombstones.get(task.id) === "deleted") deleted = { ...deleted, deletion: "deleted", hasResult: false };
      life().tombstones.set(task.id, deleted.deletion as "deleting" | "deleted");
      if (serial === life().taskSerial) acceptTask(deleted);
      else update(value => ({ tasks: [deleted, ...value.tasks.filter(row => row.id !== deleted.id)] }));
    } catch (cause) { handleError(cause); }
    finally { life().controllers.delete(control); if (valid()) update({ deletionPending: false }); }
  }
  return { ...state, identityReady: allowed, targetChanged, photo: local.photo, photoError: local.error,
    openPanel, closePanel, selectPhoto: file => { if (!life().submitLock && !state.uncertain) local.select(file); }, removePhoto: local.clear,
    useCurrentTarget, refreshAvailability: () => { void loadAvailability(state.target); }, confirm: () => { void confirm(); },
    retryRequest: () => { void retryRequest(); }, checkRequest, refreshTask: () => { life().waitWanted = true; void refreshTask(); }, stopWaiting: () => { life().waitWanted = false; update({ waiting: false }); },
    refreshHistory: () => { void refreshHistory(); }, viewTask,
    setImageMode: mode => { update({ imageMode: mode }); if (mode === "personal" && !state.imageUrl) void reloadImage(); else if (mode === "model" && !state.modelImageUrl) void reloadModelImage(); },
    reloadModelImage: () => { void reloadModelImage(); },
    reloadImage: () => { void reloadImage(); }, deleteTask: () => { void deleteTask(); } };
}
