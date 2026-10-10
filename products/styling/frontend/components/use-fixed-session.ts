"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFixedSession, fetchOutfitHealth, postFixedAction, FixedApiError, type FixedSession, type FixedActionRequest, type OutfitHealth } from "@/app/lib/fixed-outfits";
import type { FixedActionInput } from "./fixed-outfit-panel";
import { isProfileBinding, isRequestConditions, prepareConsumerProfile, ProfileApiError } from "@/app/lib/consumer-profile";

const actionKey = (sid: string) => `styling.pending-action.v1:${sid}`;
const blockKey = (sid: string) => `styling.blocked-action.v1:${sid}`;
const preparationOwnerKey = (sid: string) => `styling.pending-action-owner.v1:${sid}`;
export interface FixedProfileOwner { profile_id: string | null; profile_version: number }
export interface FixedRequestBlock { code: string; message: string }
function savePreparationOwner(sid: string, actionId: string, profile: FixedProfileOwner | null | undefined) {
  try {
    const existing = JSON.parse(sessionStorage.getItem(preparationOwnerKey(sid)) || "null");
    if (existing?.action_id !== actionId) sessionStorage.setItem(preparationOwnerKey(sid), JSON.stringify({ action_id: actionId, profile_id: profile?.profile_id ?? null, profile_version: profile?.profile_version ?? null }));
  } catch { /* An unverifiable original version must require confirmation before retrying. */ }
}
function readPreparationOwner(sid: string, actionId: string): FixedProfileOwner | null {
  try {
    const owner = JSON.parse(sessionStorage.getItem(preparationOwnerKey(sid)) || "null");
    if (owner?.action_id === actionId && Number.isSafeInteger(owner.profile_version) && owner.profile_version >= 0 && (owner.profile_id === null || typeof owner.profile_id === "string" && owner.profile_id.length > 0)) return { profile_id: owner.profile_id, profile_version: owner.profile_version };
  } catch { /* A later profile read cannot reconstruct the original preparation version. */ }
  return null;
}
function saveBlock(sid: string, actionId: string, block: FixedRequestBlock | null) {
  try { if (block) sessionStorage.setItem(blockKey(sid), JSON.stringify({ action_id: actionId, ...block })); else sessionStorage.removeItem(blockKey(sid)); } catch { /* Keep the current visible conflict even if storage is unavailable. */ }
}
function readBlock(sid: string, body: FixedActionRequest | null): FixedRequestBlock | null {
  try {
    const block = JSON.parse(sessionStorage.getItem(blockKey(sid)) || "null");
    if (body && block?.action_id === body.action_id && typeof block.code === "string" && /^[A-Z_]+$/.test(block.code) && typeof block.message === "string") return { code: block.code, message: block.message };
  } catch { /* Do not infer a server conflict from invalid browser storage. */ }
  return null;
}
function freezeBody<T>(body: T): T {
  const copy = JSON.parse(JSON.stringify(body));
  function freeze(value: unknown) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } }
  freeze(copy); return copy;
}
function saveAction(sid: string, body: FixedActionRequest | null) {
  try { if (body) sessionStorage.setItem(actionKey(sid), JSON.stringify(body)); else { sessionStorage.removeItem(actionKey(sid)); sessionStorage.removeItem(preparationOwnerKey(sid)); } } catch { /* The in-memory retry keeps its original identity. */ }
}
function readAction(sid: string): FixedActionRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(actionKey(sid)) || "null");
    if (value && /^[A-Za-z0-9_-]{1,64}$/.test(value.action_id) && Number.isSafeInteger(value.expected_state_revision) && Number.isSafeInteger(value.expected_conversation_revision)
      && value.expected_state_revision >= 0 && value.expected_conversation_revision >= 0
      && ["view_history", "restore_history", "add_bundle_to_cart", "add_item_to_cart", "remove_item_from_cart"].includes(value.operation)
      && (value.profile_binding === undefined || isProfileBinding(value.profile_binding))
      && (value.request_conditions === undefined || isRequestConditions(value.request_conditions))) return freezeBody(value);
  } catch { /* Malformed storage is never a server result. */ }
  return null;
}

export function useFixedSession(sessionId: string, currentProfile?: FixedProfileOwner | null) {
  const [session, setSession] = useState<FixedSession | null>(null);
  const [health, setHealth] = useState<OutfitHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [retryAction, setRetryAction] = useState<FixedActionRequest | null>(null);
  const [requestBlock, setRequestBlock] = useState<FixedRequestBlock | null>(null);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const currentId = useRef(sessionId);
  const epoch = useRef(0);
  const actionLock = useRef(false);
  const readSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) return null;
    const owner = epoch.current;
    const read = ++readSequence.current;
    try {
      const [value, latestHealth] = await Promise.all([fetchFixedSession(sessionId), fetchOutfitHealth().catch(() => null)]);
      if (read !== readSequence.current || owner !== epoch.current || sessionId !== currentId.current) return null;
      setSession(value); if (latestHealth) setHealth(latestHealth);
      const original = value ? readAction(sessionId) : null;
      const block = value ? readBlock(sessionId, original) : null;
      setRetryAction(original); setRequestBlock(block);
      setViewedId(old => value?.history.some(item => item.look_version_id === old) ? old : value?.state.current_look_version_id ?? null);
      setError(block?.message ?? "");
      return value;
    } catch (cause) {
      if (read === readSequence.current && owner === epoch.current && sessionId === currentId.current && cause instanceof FixedApiError && cause.code.startsWith("PROFILE_")) {
        setSession(null); setRetryAction(null); setRequestBlock(null); setError(cause.message);
      }
      throw cause;
    } finally {
      if (read === readSequence.current && owner === epoch.current && sessionId === currentId.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    currentId.current = sessionId;
    const owner = ++epoch.current;
    const read = ++readSequence.current;
    actionLock.current = false;
    // Deliberate reset at the session boundary, before any asynchronous response can land.
    queueMicrotask(() => {
      if (owner !== epoch.current || currentId.current !== sessionId) return;
      setSession(null); setViewedId(null); setRetryAction(null); setRequestBlock(null); setError(""); setNotice(""); setPending(false); setLoading(Boolean(sessionId));
    });
    if (!sessionId) return;
    void fetchFixedSession(sessionId).then(value => {
      if (read !== readSequence.current || owner !== epoch.current || currentId.current !== sessionId) return;
      setSession(value); setViewedId(value?.state.current_look_version_id ?? null);
      const original = value ? readAction(sessionId) : null;
      const block = value ? readBlock(sessionId, original) : null;
      setRetryAction(original); setRequestBlock(block); if (block) setError(block.message);
    }).catch(cause => { if (read === readSequence.current && owner === epoch.current && currentId.current === sessionId) setError(cause instanceof FixedApiError ? cause.message : "固定搭配记录暂时无法读取，请重新读取。已有记录不会被改写。"); })
      .finally(() => { if (read === readSequence.current && owner === epoch.current && currentId.current === sessionId) setLoading(false); });
    void fetchOutfitHealth().then(value => { if (owner === epoch.current && currentId.current === sessionId) setHealth(value); }).catch(() => { if (owner === epoch.current && currentId.current === sessionId) setHealth(null); });
    return () => { currentId.current = ""; };
  }, [sessionId]);

  const perform = async (input: FixedActionInput, original?: FixedActionRequest) => {
    if (!session || actionLock.current || requestBlock || (retryAction && !original)) return null;
    let body = original ?? freezeBody({ ...input, action_id: crypto.randomUUID(), expected_state_revision: session.state.state_revision, expected_conversation_revision: session.conversation_revision } as FixedActionRequest);
    const owner = epoch.current;
    saveAction(sessionId, body);
    const needsPreparation = body.operation === "restore_history" && body.request_conditions !== undefined && body.profile_binding === undefined;
    if (needsPreparation && !original) savePreparationOwner(sessionId, body.action_id, currentProfile);
    const originalPreparationOwner = needsPreparation && original ? readPreparationOwner(sessionId, body.action_id) : null;
    actionLock.current = true; setPending(true); setError(""); setNotice("");
    try {
      // A legacy pending action has neither field and remains a legacy retry. New profile restores opt in with conditions, even when empty.
      if (needsPreparation) {
        const prepared = await prepareConsumerProfile({ operation: "restore", session_id: sessionId, request_id: body.action_id, request_body: body });
        if (owner !== epoch.current || currentId.current !== sessionId) return null;
        body = freezeBody({ ...body, profile_binding: prepared.profile_binding });
        saveAction(sessionId, body);
        if (original && (!originalPreparationOwner || originalPreparationOwner.profile_version !== prepared.profile_binding.profile_version || originalPreparationOwner.profile_id !== prepared.profile_binding.profile_id)) {
          throw new ProfileApiError(409, "PROFILE_PREPARATION_CHANGED", "无法确认重试准备仍使用最初的资料版本。原恢复操作及返回绑定已保留，请保留旧请求，重新编辑并确认本次条件。");
        }
      }
      const result = await postFixedAction(sessionId, body);
      if (owner !== epoch.current || currentId.current !== sessionId) return null;
      saveAction(sessionId, null); saveBlock(sessionId, body.action_id, null); setRetryAction(null); setRequestBlock(null);
      const next = await refresh();
      if (owner !== epoch.current || currentId.current !== sessionId) return null;
      if (body.operation === "restore_history" && result.outcome === "complete_outfit") {
        setViewedId(next?.state.current_look_version_id ?? null);
        setNotice("已恢复为新的当前版本，原历史版本保留。");
      } else if (result.outcome === "action_completed") setNotice("模拟购物袋已更新，不产生订单。");
      else if (body.operation !== "view_history") setError(result.response.text || "操作未完成，请查看当前状态后再决定下一步。");
      return result;
    } catch (cause) {
      if (owner !== epoch.current || currentId.current !== sessionId) return null;
      const known = cause instanceof FixedApiError || cause instanceof ProfileApiError;
      if (known && cause.code.startsWith("PROFILE_") && cause.status < 500) {
        const block = { code: cause.code, message: cause.message };
        saveAction(sessionId, body); saveBlock(sessionId, body.action_id, block); setRetryAction(body); setRequestBlock(block); setError(cause.message);
      } else if (known && cause.code === "REQUEST_IN_PROGRESS") {
        saveAction(sessionId, body); setRetryAction(body); setError(cause.message);
      } else if (known && cause.status === 409) {
        saveAction(sessionId, null); saveBlock(sessionId, body.action_id, null); setRetryAction(null); setRequestBlock(null);
        await refresh().catch(() => null);
        if (owner === epoch.current && currentId.current === sessionId) setError("记录已发生变化，已尝试重新读取。请检查当前版本与购物袋，再明确选择操作；不会自动重做。");
      } else if (known && cause.status < 500 && cause.status !== 429) {
        saveAction(sessionId, null); setRetryAction(null);
        setError(cause.message);
      } else {
        saveAction(sessionId, body); setRetryAction(body);
        setError(known && cause.code.startsWith("PROFILE_") ? cause.message : body.operation === "restore_history" ? "恢复操作响应未确认。原操作编号、本次条件和已有资料绑定已保留；请明确原体重试，不会自动恢复。" : "操作响应未确认。已有购物袋保留；可用原操作编号重新查询提交结果，避免重复加购。");
      }
      return null;
    } finally {
      if (owner === epoch.current && currentId.current === sessionId) { actionLock.current = false; setPending(false); }
    }
  };

  const confirmNewAction = () => {
    if (!session || !retryAction || !requestBlock || actionLock.current) return false;
    try {
      const key = `styling.action-archive.v1:${sessionId}`;
      const existing = JSON.parse(sessionStorage.getItem(key) || "[]");
      if (!Array.isArray(existing)) throw new Error("Invalid archived requests");
      sessionStorage.setItem(key, JSON.stringify([...existing, { body: retryAction, block: requestBlock, archived_at: new Date().toISOString() }]));
      saveAction(sessionId, null); saveBlock(sessionId, retryAction.action_id, null);
      setRetryAction(null); setRequestBlock(null); setError(""); setNotice("原操作已留档。请查看当前资料和条件，再明确选择要恢复的历史版本。");
      return true;
    } catch { setError("原操作暂时无法留档，尚未清除原编号和绑定，请稍后重试。"); return false; }
  };

  const retry = async () => {
    if (!retryAction || requestBlock || actionLock.current) return null;
    const original = retryAction, owner = epoch.current;
    try {
      const authorized = await refresh();
      if (!authorized || owner !== epoch.current || currentId.current !== sessionId) return null;
      return await perform(original, original);
    } catch (cause) {
      if (owner === epoch.current && currentId.current === sessionId) setError(cause instanceof FixedApiError ? cause.message : "原会话资格暂时无法确认。原操作已保留，尚未重新提交，请稍后重读。");
      return null;
    }
  };

  return { session, health, loading, error, notice, pending, retryAction, requestBlock, confirmNewAction, viewedId, setViewedId, refresh, perform,
    retry,
    clearNotice: () => { setError(""); setNotice(""); },
  };
}
