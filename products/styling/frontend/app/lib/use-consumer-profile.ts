"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchConsumerProfile, fetchProfileOperation, initializeConsumerProfile, mutateConsumerProfile, ProfileApiError, validateProfileMutation, type ProfileMutation, type ProfileMutationReceipt, type ProfilePatch, type SavedConsumerProfile } from "./consumer-profile";

const PENDING_KEY = `styling.pending-profile.v1:${process.env.NEXT_PUBLIC_BASE_PATH || "/"}`;
type PendingOwner = Pick<SavedConsumerProfile, "profile_id" | "scope_kind"> & { authorization_expires_at?: string; authorization_blocked?: boolean };
function readPending(): { body: ProfileMutation; owner: PendingOwner } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    validateProfileMutation(record.body);
    if (!record.owner || !["device", "user"].includes(record.owner.scope_kind) || !(record.owner.profile_id === null || typeof record.owner.profile_id === "string")) return null;
    if (record.owner.authorization_expires_at !== undefined && (typeof record.owner.authorization_expires_at !== "string" || !Number.isFinite(Date.parse(record.owner.authorization_expires_at)))) return null;
    if (record.owner.authorization_blocked !== undefined && typeof record.owner.authorization_blocked !== "boolean") return null;
    return record;
  } catch { return null; }
}

export interface ConsumerProfileController {
  profile: SavedConsumerProfile | null;
  status: "loading" | "ready" | "error";
  ready: boolean;
  identityReady: boolean;
  busy: boolean;
  error: string;
  notice: string;
  pendingMutation: ProfileMutation | null;
  identityRevision: number;
  refresh: () => Promise<SavedConsumerProfile | null>;
  mutate: (operation: "save" | "update" | "clear", patch: ProfilePatch, explicitDefaultBudget?: boolean) => Promise<boolean>;
  retryMutation: () => Promise<boolean>;
  canReplayPending: boolean;
  discardPendingMutation: () => void;
  reset: () => void;
}

/** Keeps authority in current GET responses; operation receipts never reconstruct profile values. */
export function useConsumerProfile(identityKey: string | number = "browser"): ConsumerProfileController {
  const [profile, setProfile] = useState<SavedConsumerProfile | null>(null);
  const [status, setStatus] = useState<ConsumerProfileController["status"]>("loading");
  const [busy, setBusy] = useState(false);
  const [identityReady, setIdentityReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingMutation, setPendingMutation] = useState<ProfileMutation | null>(null);
  const [identityRevision, setIdentityRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const current = useRef<SavedConsumerProfile | null>(null);
  const pending = useRef<ProfileMutation | null>(null);
  const pendingOwner = useRef<PendingOwner | null>(null);
  const [restoredUnproven, setRestoredUnproven] = useState(false);
  const restoredCannotReplay = useRef(false);
  const restoreCandidate = useRef<ReturnType<typeof readPending>>(null);
  const epoch = useRef(0);
  const mutationLock = useRef(false);
  const readSerial = useRef(0);
  const readFlight = useRef<{ owner: number; serial: number; promise: Promise<SavedConsumerProfile | null> } | null>(null);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  const keepPending = useCallback((body: ProfileMutation | null) => {
    pending.current = body;
    setPendingMutation(body);
    if (!body) { pendingOwner.current = null; restoredCannotReplay.current = false; setRestoredUnproven(false); }
    try {
      if (!body) sessionStorage.removeItem(PENDING_KEY);
      else if (pendingOwner.current) sessionStorage.setItem(PENDING_KEY, JSON.stringify({ body, owner: pendingOwner.current }));
    } catch { /* In-memory operation identity still survives transport failures. */ }
  }, []);

  const blockPending = useCallback((message: string) => {
    restoredCannotReplay.current = true; setRestoredUnproven(true);
    if (pendingOwner.current) pendingOwner.current = { ...pendingOwner.current, authorization_blocked: true };
    keepPending(pending.current); setError(message);
  }, [keepPending]);

  const acceptCurrent = useCallback((next: SavedConsumerProfile, owner: number) => {
    if (owner !== epoch.current) return null;
    const previous = current.current;
    const contextChanged = previous?.authorization_context && previous.authorization_context.context_id !== next.authorization_context?.context_id;
    const identityChanged = previous && (contextChanged || previous.scope_kind !== next.scope_kind || (previous.profile_id !== null && previous.profile_id !== next.profile_id));
    if (identityChanged) {
      epoch.current++;
      if (pending.current?.expected_authorization_context || previous.authorization_context && pending.current) blockPending("资料授权范围已变化，旧修改不会重发。编辑与原操作已保留，请重新确认保存范围。");
      else keepPending(null);
      mutationLock.current = false; setBusy(false); setNotice("资料范围已变化，之前的资料操作不会重发；请核对当前资料后重新编辑。");
      setIdentityRevision(value => value + 1);
    } else if (previous && next.profile_id === previous.profile_id && next.profile_version < previous.profile_version) {
      setProfile(previous); setStatus("ready"); setIdentityReady(true);
      return previous;
    }
    current.current = next;
    setProfile(next); setStatus("ready"); setIdentityReady(true);
    const restored = restoreCandidate.current;
    restoreCandidate.current = null;
    if (restored) {
      const originalContext = restored.body.expected_authorization_context;
      if (!originalContext && !next.authorization_context && (restored.owner.scope_kind !== next.scope_kind || (restored.owner.profile_id !== null && restored.owner.profile_id !== next.profile_id))) {
        keepPending(null); setNotice("保存范围已经变化，之前的待确认资料操作未重发，请核对当前资料。");
      } else {
        pendingOwner.current = restored.owner;
        restoredCannotReplay.current = originalContext || next.authorization_context
          ? !originalContext || originalContext.context_id !== next.authorization_context?.context_id || !restored.owner.authorization_expires_at || Date.parse(restored.owner.authorization_expires_at) <= Date.now() || !!restored.owner.authorization_blocked
          : restored.owner.profile_id === null;
        setRestoredUnproven(restoredCannotReplay.current); keepPending(restored.body);
        setNotice(restoredCannotReplay.current ? originalContext || next.authorization_context
          ? "已保留旧操作与编辑，原保存授权暂不能继续写入。请先查询原操作；未完成时须结束旧查询，重新确认当前保存范围。"
          : "已恢复旧操作编号；原操作开始时还没有资料编号，无法完整核对其归属，只能先查询原操作，找不到时不会重发。"
          : "有一条资料操作待确认，原编号与修改内容已恢复；请查询后按原编号重试。");
      }
    }
    return next;
  }, [blockPending, keepPending]);

  const readCurrent = useCallback((owner: number, initialize = false, force = false): Promise<SavedConsumerProfile | null> => {
    if (!force && readFlight.current?.owner === owner) return readFlight.current.promise;
    const serial = ++readSerial.current;
    const promise = (async () => {
      try {
        const next = await (initialize ? initializeConsumerProfile() : fetchConsumerProfile());
        if (owner !== epoch.current || serial !== readSerial.current) return null;
        const accepted = acceptCurrent(next, owner);
        setError("");
        return accepted;
      } catch (cause) {
        if (owner === epoch.current && serial === readSerial.current) {
          setStatus("error"); setIdentityReady(false);
          if (cause instanceof ProfileApiError && (cause.status === 401 || cause.status === 403)) {
            if (pending.current?.expected_authorization_context) blockPending("当前资料授权无法确认，原操作与编辑已保留；请恢复当前资料读取后重新确认。");
            else keepPending(null);
            epoch.current++; current.current = null; setProfile(null);
            mutationLock.current = false; setBusy(false); setIdentityRevision(value => value + 1);
          }
          setError(cause instanceof Error ? `资料读取失败：${cause.message}` : "资料读取失败，请重试；仍可编辑本次需求。");
        }
        return null;
      } finally {
        if (readFlight.current?.serial === serial) readFlight.current = null;
      }
    })();
    readFlight.current = { owner, serial, promise };
    return promise;
  }, [acceptCurrent, blockPending, keepPending]);

  useEffect(() => {
    const owner = ++epoch.current;
    const lifetimeEpoch = epoch;
    restoreCandidate.current = readPending();
    queueMicrotask(() => {
      if (owner !== epoch.current) return;
      current.current = null;
      setProfile(null); setStatus("loading"); setIdentityReady(false); setError(""); setNotice("");
      pending.current = null; setPendingMutation(null); mutationLock.current = false; setBusy(false);
      void readCurrent(owner, true);
    });
    return () => { lifetimeEpoch.current++; };
  }, [identityKey, attempt, keepPending, readCurrent]);

  const refresh = useCallback(async () => {
    const owner = epoch.current;
    setStatus("loading"); setError("");
    return readCurrent(owner);
  }, [readCurrent]);

  useEffect(() => {
    const visibleRead = () => { if (document.visibilityState === "visible" && !mutationLock.current) void refresh(); };
    window.addEventListener("focus", visibleRead);
    document.addEventListener("visibilitychange", visibleRead);
    return () => { window.removeEventListener("focus", visibleRead); document.removeEventListener("visibilitychange", visibleRead); };
  }, [refresh]);

  const finishReceipt = useCallback(async (receipt: ProfileMutationReceipt, body: ProfileMutation, owner: number) => {
    if (owner !== epoch.current) return false;
    // Hide cleared defaults immediately, while the following GET establishes current authority.
    if (body.operation === "clear" && receipt.profile_version >= (current.current?.profile_version ?? 0)) setProfile(null);
    setStatus("loading");
    const fresh = await readCurrent(owner, false, true);
    if (owner !== epoch.current || !fresh) return false;
    if (fresh.profile_version < receipt.profile_version || fresh.profile_id !== receipt.profile_id || fresh.scope_kind !== receipt.scope_kind) {
      setStatus("error"); setIdentityReady(false);
      setError("已收到资料操作回执，但当前读取尚未核对到对应版本或范围；编辑和原操作编号保留，请重新查询。");
      return false;
    }
    keepPending(null);
    const later = fresh.profile_version > receipt.profile_version;
    setNotice(later ? "原操作已确认；资料之后已发生变化，当前展示的是重新读取的最新资料。"
      : body.operation === "clear" ? "已清除保存的基础资料和常用预算。历史搭配及已受理请求保留。"
        : fresh.scope_kind === "device" ? "已保存在本设备的当前浏览器，可在同一站点与空间的新对话中复用。" : "已保存到当前用户资料；本次未发送的需求保持不变。");
    return true;
  }, [keepPending, readCurrent]);

  const runMutation = useCallback(async (body: ProfileMutation, retry: boolean) => {
    if (mutationLock.current) return false;
    const owner = epoch.current;
    const expectedOwner = pendingOwner.current ? { ...pendingOwner.current } : null;
    mutationLock.current = true; setBusy(true); setError(""); setNotice(""); keepPending(body);
    try {
      let receipt: ProfileMutationReceipt | null = null;
      if (body.expected_authorization_context || current.current?.authorization_context) {
        setStatus("loading");
        const fresh = await readCurrent(owner, false, true);
        if (owner !== epoch.current || !fresh) return false;
        const originalContext = body.expected_authorization_context;
        if (originalContext && (originalContext.context_contract !== fresh.authorization_context?.context_contract || originalContext.context_id !== fresh.authorization_context.context_id)) {
          blockPending("资料授权范围已变化，旧修改不会重发。编辑与原操作已保留，请结束旧查询后重新确认保存范围。");
          return false;
        }
        if (!expectedOwner || expectedOwner.scope_kind !== fresh.scope_kind || expectedOwner.profile_id !== null && expectedOwner.profile_id !== fresh.profile_id) {
          blockPending("当前资料范围与原操作不一致，未查询或重发旧修改。编辑与原操作已保留，请结束旧查询后重新确认保存范围。");
          return false;
        }
        // A successful historical receipt remains readable even after its original token expires or is revoked.
        if (retry) receipt = await fetchProfileOperation(body.profile_action_id);
        if (owner !== epoch.current) return false;
        if (!receipt) {
          if (!originalContext) {
            blockPending("当前范围没有找到旧操作。旧操作未记录保存授权，只能查询，不能补用新授权重发；请结束旧查询后重新确认要保存的字段。");
            return false;
          }
          if (expectedOwner?.authorization_blocked || !expectedOwner?.authorization_expires_at || Date.parse(expectedOwner.authorization_expires_at) <= Date.now()) {
            blockPending("当前范围没有找到旧操作，原保存授权已失效、到期或无法核对。编辑与原操作已保留，请结束旧查询后重新确认保存。");
            return false;
          }
          if (expectedOwner.scope_kind !== fresh.scope_kind || expectedOwner.profile_id !== null && expectedOwner.profile_id !== fresh.profile_id || body.expected_profile_version !== fresh.profile_version) {
            blockPending("当前资料版本或保存范围已变化，旧修改没有重发。编辑与原操作已保留，请结束旧查询后重新确认当前资料。");
            return false;
          }
          receipt = await mutateConsumerProfile(body);
        }
      } else {
        if (retry) receipt = await fetchProfileOperation(body.profile_action_id);
        if (owner !== epoch.current) return false;
        if (!receipt) {
        // Cookie ownership may have changed without a focus event. Never send an old patch
        // using only an equal revision number: distinct consumers can have the same revision.
        setStatus("loading");
        const fresh = await readCurrent(owner, false, true);
        if (owner !== epoch.current || !fresh) return false;
        if (fresh.authorization_context) {
          blockPending("资料保存规则已经更新。原操作未记录授权，只能查询，不能补用新授权重发；请结束旧查询后重新确认保存。");
          return false;
        }
        if (!expectedOwner || expectedOwner.scope_kind !== fresh.scope_kind || (expectedOwner.profile_id !== null && expectedOwner.profile_id !== fresh.profile_id)) {
          keepPending(null); setError("资料范围已变化，原修改没有发送。请重新核对当前资料后明确保存。");
          return false;
        }
        if (retry && expectedOwner.profile_id === null) {
          restoredCannotReplay.current = true; setRestoredUnproven(true);
          setError("当前范围没有找到旧操作。原操作的空资料归属无法核对，因此不会重发；可结束查询并重新确认需要保存的字段。");
          return false;
        }
        receipt = await mutateConsumerProfile(body);
        }
      }
      return await finishReceipt(receipt, body, owner);
    } catch (cause) {
      if (owner !== epoch.current) return false;
      if (body.expected_authorization_context && cause instanceof ProfileApiError && (cause.code.startsWith("PROFILE_AUTH_CONTEXT_") || cause.status === 409 || cause.status === 401 || cause.status === 403)) {
        const message = `资料操作未完成：${cause.message}。原操作与编辑已保留，请查询结果后重新确认当前保存范围。`;
        blockPending(message);
        if (cause.status === 401 || cause.code === "PROFILE_OWNER_INVALID") {
          epoch.current++; mutationLock.current = false; setBusy(false); current.current = null; setProfile(null); setStatus("error"); setIdentityReady(false); setIdentityRevision(value => value + 1);
        } else if (cause.status === 403) {
          setStatus("loading");
          await readCurrent(owner, false, true);
          if (owner === epoch.current) setError(message);
        }
      } else if (body.expected_authorization_context && cause instanceof ProfileApiError && cause.status === 429) {
        setError("资料保存暂未受理，原操作与原授权已保留。请稍后查询并明确原体重试，不能替换原授权。");
      } else if (cause instanceof ProfileApiError && cause.status === 409) {
        keepPending(null);
        await readCurrent(owner);
        if (owner === epoch.current) setError("资料已被其他操作更新，或原动作存在冲突。已重新读取当前资料；你的编辑保留，请核对后再次明确保存。");
      } else if (cause instanceof ProfileApiError && cause.status >= 400 && cause.status < 500) {
        keepPending(null);
        if (cause.status === 403 || cause.status === 401) { epoch.current++; mutationLock.current = false; setBusy(false); setProfile(null); current.current = null; setStatus("error"); setIdentityReady(false); setIdentityRevision(value => value + 1); }
        setError(`资料操作未完成：${cause.message}。你的编辑保留。`);
      } else {
        try {
          const receipt = await fetchProfileOperation(body.profile_action_id);
          if (owner !== epoch.current) return false;
          if (receipt) return await finishReceipt(receipt, body, owner);
        } catch { /* An unavailable receipt is not permission to invent another operation ID. */ }
        if (owner === epoch.current) setError("资料操作结果尚未确认，编辑与原操作编号已保留。请查询并按原编号重试；不会自动重复保存。");
      }
      return false;
    } finally {
      if (owner === epoch.current) { mutationLock.current = false; setBusy(false); }
    }
  }, [blockPending, finishReceipt, keepPending, readCurrent]);

  const mutate = useCallback(async (operation: "save" | "update" | "clear", patch: ProfilePatch, explicitDefaultBudget = false) => {
    const saved = current.current;
    if (!saved || statusRef.current !== "ready" || mutationLock.current || pending.current) return false;
    const body: ProfileMutation = {
      profile_action_id: crypto.randomUUID(), operation, expected_profile_version: saved.profile_version,
      patch: structuredClone(patch),
      ...(saved.authorization_context ? { expected_authorization_context: { context_contract: saved.authorization_context.context_contract, context_id: saved.authorization_context.context_id, operation_token: saved.authorization_context.operation_token } } : {}),
      ...(operation !== "clear" ? { explicit_save: true } : {}),
      ...(explicitDefaultBudget ? { explicit_default_budget: true } : {}),
    };
    pendingOwner.current = { profile_id: saved.profile_id, scope_kind: saved.scope_kind, ...(saved.authorization_context ? { authorization_expires_at: saved.authorization_context.expires_at } : {}) };
    restoredCannotReplay.current = false; setRestoredUnproven(false);
    return runMutation(body, false);
  }, [runMutation]);

  const retryMutation = useCallback(async () => pending.current ? runMutation(pending.current, true) : false, [runMutation]);
  const discardPendingMutation = useCallback(() => {
    if (mutationLock.current) return;
    keepPending(null); setError(""); setNotice("已结束本页对旧资料操作的查询，不代表取消服务端已受理的操作。请重新读取资料后核对要保存的字段。");
    void refresh();
  }, [keepPending, refresh]);
  const reset = useCallback(() => {
    epoch.current++; current.current = null; restoreCandidate.current = null; keepPending(null); mutationLock.current = false;
    setProfile(null); setStatus("loading"); setIdentityReady(false); setBusy(false); setError(""); setNotice("");
    setIdentityRevision(value => value + 1); setAttempt(value => value + 1);
  }, [keepPending]);

  return { profile, status, ready: status === "ready" && !pendingMutation && !busy, identityReady, busy, error, notice, pendingMutation, identityRevision, refresh, mutate, retryMutation, canReplayPending: !restoredUnproven, discardPendingMutation, reset };
}
