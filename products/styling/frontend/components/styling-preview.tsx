"use client";
import { appPath, isPrefixedDemoDeployment } from "@/app/lib/app-path";

import Image from "next/image";
import { ArrowRight, ChevronDown, ArrowUpRight, History, Home, Info, LayoutGrid, MessageCircle, Plus, ShoppingBag, SlidersHorizontal, Sparkles, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";

import { initializeAccountHistory, fetchHistory, fetchProducts, fetchRecommendedIds, fetchTryons, fetchTryonStatus, fetchCart, addCart, removeCart, getSessionId, peekSessionId, rememberSession, forgetSessionSelection, getSavedSessions, selectSavedSession, type SavedSession, createProfileChatRequest, isStoredChatRequest, sendPreparedChat, fetchGenerationRequest, generationRequestEvent, fetchSavedSessionIndex, type PreparedChatRequest, type ChatEvent, uploadTryon, type Message, type Product } from "@/app/lib/api";
import { PlatformBar } from "@/components/platform-bar";
import { getPlatformLinks } from "@/app/lib/platform-links";
import { ConsumerDiscovery } from "./consumer-discovery";
import { ConsumerCollection } from "./consumer-collection";
import { ConsumerLookExamples } from "./consumer-look-examples";
import styles from "./styling-preview.module.css";
import { isCompleteOutfit, fetchFixedSession, FixedApiError } from "@/app/lib/fixed-outfits";
import { useFixedSession } from "./use-fixed-session";
import { FixedOutfitPanel, FixedHistory, FixedBag, type FixedActionInput } from "./fixed-outfit-panel";
import { ConsumerEventsProvider, ConsumerEventNotice, ConsumerObservedImage, useConsumerEventSession } from "./consumer-events";
import { ProfilePanel, ProfileSupplementCard } from "./consumer-profile";
import { applyProfileDraft, profileDraftLine, removeProfileDraft, EMPTY_PROFILE_DRAFT, type ProfileDraft, type ProfileField } from "@/app/lib/profile-draft";

import { initializeConsumerProfile, prepareConsumerProfile, createPrivateOutfitSession, ProfileApiError } from "@/app/lib/consumer-profile";
import { useConsumerProfile, type ConsumerProfileController } from "@/app/lib/use-consumer-profile";
import { profileRequestConditions, nextProfileField, profileRequestNeedsConfirmation } from "@/app/lib/profile-request";
import { profileEditOwner, readProfileEditBackup, removeProfileEditBackup, sameProfileEditOwner, writeProfileEditBackup, type OwnedProfileEditBackup, type ProfilePanelEditing } from "@/app/lib/profile-edit-backup";
import { createPersonalPreviewService } from "@/app/lib/personal-preview-api";
import { personalPreviewSchema } from "@/app/lib/personal-preview-schema";
import { PersonalPreviewPanel } from "./personal-preview-panel";
import { usePersonalPreview } from "@/app/lib/use-personal-preview";
import { isPersonalPreviewIntent, personalPreviewTarget } from "@/app/lib/personal-preview-model";
import { DemoAccessBoundary } from "./demo-access-boundary";

// 从对话文本识别场景，用于试穿入口默认场景
function detectScene(text: string): string | null {
  if (/约会|聚会/.test(text)) return "约会聚会";
  if (/出游|旅行|旅游|出去玩|周末/.test(text)) return "出游";
  if (/通勤|上班|工作|面试|日常/.test(text)) return "通勤";
  return null;
}

export function StylingPreview() {
  return process.env.NEXT_PUBLIC_DEMO_ACCESS_SUPPORTED === "1"
    ? <DemoAccessBoundary role="consumer"><StylingIdentityWorkspace /></DemoAccessBoundary>
    : <StylingIdentityWorkspace />;
}

function StylingIdentityWorkspace() {
  const [sessionRevision, setSessionRevision] = useState(0);
  const profile = useConsumerProfile();
  const identityRevision = useRef(0);
  useLayoutEffect(() => {
    if (identityRevision.current !== profile.identityRevision) {
      forgetSessionSelection(); identityRevision.current = profile.identityRevision;
    }
  }, [profile.identityRevision]);
  const requiresPlatformAccount = !!process.env.NEXT_PUBLIC_BASE_PATH && !isPrefixedDemoDeployment();
  const [ready, setReady] = useState(!requiresPlatformAccount);
  const [loadError, setLoadError] = useState("");
  const [accountAttempt, setAccountAttempt] = useState(0);
  useEffect(() => {
    if (!requiresPlatformAccount) return;
    let active = true;
    initializeConsumerProfile().then(() => initializeAccountHistory()).then(() => { if (active) setReady(true); }).catch(e => { if (active) setLoadError(e.message); });
    return () => { active = false; };
  }, [accountAttempt, requiresPlatformAccount]);
  if (!ready) return <div className={styles.studio}><PlatformBar /><main className={styles.boot}><p role={loadError ? "alert" : "status"}>{loadError || "正在找回你的穿搭记录…"}</p>{loadError && <div><button onClick={() => { setLoadError(""); setAccountAttempt(value => value + 1); }}>重试恢复记录</button><a href={appPath("/")}>返回消费者入口</a></div>}</main></div>;

  return <StylingConversation profile={profile} key={`${sessionRevision}:${profile.identityRevision}`} onSessionSwitch={() => setSessionRevision(value => value + 1)} />;
}

function StylingConversation({ onSessionSwitch, profile }: { onSessionSwitch: () => void; profile: ConsumerProfileController }) {
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [streamingStatus, setStreamingStatus] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ ...EMPTY_PROFILE_DRAFT });
  const [supplementField, setSupplementField] = useState<ProfileField | null>(null);
  const [scenePrompt, setScenePrompt] = useState(false);
  const profileOrigin = useRef<HTMLElement | null>(null);
  const profileApplied = useRef(false);
  const ownedProfileLine = useRef<string | null>(null);
  const [panelEditing, setPanelEditing] = useState<ProfilePanelEditing | null>(null);
  const [panelRecovery, setPanelRecovery] = useState<ProfilePanelEditing | null>(null);
  const [panelRecoveryRevision, setPanelRecoveryRevision] = useState(0);
  const [editRecovery, setEditRecovery] = useState<OwnedProfileEditBackup | null>(null);
  const [editBackupNotice, setEditBackupNotice] = useState("");
  const lastEditBackup = useRef<{ ownerKey: string; serialized: string } | null>(null);
  const lastProfileRemovalState = useRef<{ identity: string; version: number } | null>(null);
  useLayoutEffect(() => {
    if (!profile.identityReady) return;
    const owner = profileEditOwner(profile.profile);
    if (!owner) return;
    const ownerKey = `${owner.scope_kind}:${owner.context_id}`;
    const draft = { profileVersion: profile.profile!.profile_version, message, profileDraft, ownedProfileLine: ownedProfileLine.current, panel: panelEditing };
    const serialized = JSON.stringify(draft);
    if (lastEditBackup.current?.ownerKey !== ownerKey) {
      lastEditBackup.current = { ownerKey, serialized };
      queueMicrotask(() => { if (lastEditBackup.current?.ownerKey === ownerKey) setEditRecovery(readProfileEditBackup(owner)); });
      return;
    }
    if (lastEditBackup.current.serialized === serialized) return;
    lastEditBackup.current.serialized = serialized;
    const backedUp = writeProfileEditBackup(owner, draft);
    queueMicrotask(() => {
      setEditRecovery(null);
      if (!backedUp) setEditBackupNotice("本机暂时无法保留编辑备份。切换资料范围前请自行复制未发送的内容。");
    });
  }, [message, profileDraft, panelEditing, profile.identityReady, profile.profile]);
  const [historyOpen, setHistoryOpen] = useState(false);
  type ConsumerView = "home" | "discover" | "outfit" | "bag" | "history";
  const [view, setView] = useState<ConsumerView>("home");
  const [focusRevision, setFocusRevision] = useState(0);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const pageTitleRef = useRef<HTMLHeadingElement>(null);
  const focusIntent = useRef<"composer" | "title" | "catalog" | null>(null);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [mobileView, setMobileView] = useState<"chat" | "outfit">("chat");
  const [restoring, setRestoring] = useState(true);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [recoveryErrors, setRecoveryErrors] = useState<string[]>([]);
  const [imageFailures, setImageFailures] = useState<Record<string, boolean>>({});
  const [productImageFailures, setProductImageFailures] = useState<Record<string, boolean>>({});
  const [cartPending, setCartPending] = useState<string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const identityReady = profile.identityReady;
  const completeTemporaryConditions = identityReady && !profile.busy && profileDraft.top !== null && profileDraft.bottom !== null
    && profileDraft.shoes !== null && profileDraft.budget_fen !== null && message.trim().length > 0;
  const fixed = useFixedSession(identityReady ? activeSessionId : "", profile.profile);
  const events = useConsumerEventSession(activeSessionId, view, !!activeSessionId && identityReady);
  const fixedOutfit = fixed.session?.history.find(item => item.look_version_id === fixed.viewedId) ?? fixed.session?.history.find(item => item.look_version_id === fixed.session?.state.current_look_version_id) ?? null;
  const previewApiEnabled = process.env.NEXT_PUBLIC_PERSONAL_PREVIEW_ENABLED === "1";
  const previewContext = profile.profile?.authorization_context?.context_id;
  // The server context is stable across reloads; the component's revision counter is not.
  const previewIdentity = `${profile.profile?.scope_kind ?? "unknown"}:${previewContext ?? "unknown"}`;
  const previewService = useMemo(() => {
    if (!previewApiEnabled || previewIdentity.endsWith(":unknown")) return undefined;
    return createPersonalPreviewService({ schema: personalPreviewSchema });
  }, [previewApiEnabled, previewIdentity]);
  const personalPreview = usePersonalPreview({ currentTarget: personalPreviewTarget(fixedOutfit),
    identityKey: previewIdentity, identityReady: identityReady && (!previewApiEnabled || !!previewContext),
    service: previewService, persistRecovery: previewApiEnabled, sessionKey: activeSessionId,
    onIdentityInvalid: () => { void profile.refresh(); } });
  const [pendingChat, setPendingChat] = useState<PreparedChatRequest | null>(null);
  const [requestBlock, setRequestBlock] = useState("");
  const lastFailedRequest = useRef<PreparedChatRequest | null>(null);
  const pendingChatRef = useRef<PreparedChatRequest | null>(null);
  const sendLock = useRef(false);
  const [resultOutcome, setResultOutcome] = useState("");
  const [indexError, setIndexError] = useState("");
  const chatStorageKey = (sid: string) => `styling.pending-chat.v1:${sid}`;
  const pendingOwner = useRef<{ profile_id: string | null; profile_version: number; scope_kind: string } | null>(null);
  useLayoutEffect(() => {
    pendingOwner.current = profile.profile ? { profile_id: profile.profile.profile_id, profile_version: profile.profile.profile_version, scope_kind: profile.profile.scope_kind } : null;
  }, [profile.profile]);
  const savePendingChat = useCallback((request: PreparedChatRequest | null, sid: string, preserveOwner = false) => {
    pendingChatRef.current = request; setPendingChat(request);
    try {
      const ownerKey = `styling.pending-chat-owner.v1:${sid}`;
      if (request) {
        sessionStorage.setItem(chatStorageKey(sid), JSON.stringify(request));
        const oldOwner = JSON.parse(sessionStorage.getItem(ownerKey) || "null");
        if (!preserveOwner && oldOwner?.request_id !== request.request_id) sessionStorage.setItem(ownerKey, JSON.stringify({ request_id: request.request_id, ...pendingOwner.current }));
      } else {
        sessionStorage.removeItem(chatStorageKey(sid)); sessionStorage.removeItem(ownerKey); sessionStorage.removeItem(`styling.blocked-chat.v1:${sid}`);
      }
    } catch { /* In-memory identity remains stable if session storage is unavailable. */ }
    if (!request) setRequestBlock("");
  }, []);

  const onPendingRecovery = useEffectEvent((event: ChatEvent, request: PreparedChatRequest, epoch: number) => applyChatEvent(event, request, epoch));

  type TryonRecord = {
    id: string;
    status: "processing" | "succeeded" | "failed" | "cancelled";
    resultUrl?: string;
    productIds?: string[];
    error?: string;
    scene: string;
  };

  const [recommendedProductIds, setRecommendedProductIds] = useState<string[]>([]);
  const [recommendedProducts, setRecommendedProducts] = useState<Product[]>([]);
  const [cartIds, setCartIds] = useState<string[]>([]);
  const [tryons, setTryons] = useState<TryonRecord[]>([]);
  const [viewedTryonId, setViewedTryonId] = useState<string | null>(null);
  const [tryonScene, setTryonScene] = useState("通勤");
  const [pendingPhoto, setPendingPhoto] = useState<{ file: File; url: string } | null>(null);

  const viewedTryon = tryons.find((t) => t.id === viewedTryonId) ?? tryons[tryons.length - 1] ?? null;
  const succeededTryons = tryons.filter((t) => t.status === "succeeded" && t.resultUrl);
  const latestProcessing = [...tryons].reverse().find((t) => t.status === "processing") ?? null;

  const sessionIdRef = useRef("");
  const sessionEpoch = useRef(0);
  const cartOperations = useRef(new Set<string>());
  const sceneRef = useRef(""); // 会话场景：首次确定后锁定，后续消息（如回答追问）不再覆盖
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const aboutRef = useRef<HTMLDialogElement>(null);
  const aboutButtonRef = useRef<HTMLButtonElement>(null);
  const catalogButtonRef = useRef<HTMLButtonElement>(null);
  const catalogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (catalogOpen) catalogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [catalogOpen]);
  const composingRef = useRef(false); // 中文输入法组合态，防止 Enter 误发
  const stickToBottomRef = useRef(true); // 是否跟随滚动到底部
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const displayHistory = !generating && fixed.session && fixed.session.messages.length >= history.length ? fixed.session.messages : history;
  const hasResult = displayHistory.length > 0 || generating;
  const historyUnavailable = recoveryErrors.some(item => item.startsWith("对话记录"));
  const cartUnavailable = recoveryErrors.some(item => item.startsWith("模拟加购记录"));
  const imageUrl = viewedTryon?.status === "succeeded" ? viewedTryon.resultUrl : undefined;
  const imageReady = !!imageUrl && !imageFailures[imageUrl];
  const discovery = view === "home";
  const auxiliary = view === "discover" || view === "bag" || view === "history";
  const workspaceEmpty = view === "outfit" && !hasResult && !viewedTryon && recommendedProductIds.length === 0 && !fixedOutfit && !fixed.loading && !pendingChat && !error;
  const publicLinks = getPlatformLinks().filter(link => link.id === "product" || link.id === "design");

  useEffect(() => {
    const syncView = () => {
      const target = window.location.hash.slice(1);
      setFocusRevision(value => value + 1);
      if (["home", "discover", "outfit", "bag", "history"].includes(target)) {
        focusIntent.current = target === "home" ? "composer" : "title";
        if (target === "home") setMobileView("chat");
        setView(target as ConsumerView);
        setCatalogOpen(target === "discover");
        setHistoryOpen(target === "history");
        if (target === "history") setSavedSessions(getSavedSessions());
      } else if (!target) { focusIntent.current = "composer"; setMobileView("chat"); setView("home"); setCatalogOpen(false); setHistoryOpen(false); }
    };
    syncView();
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  function navigate(target: ConsumerView) {
    setFocusRevision(value => value + 1);
    focusIntent.current = target === "home" ? "composer" : "title";
    if (target === "home") { setMobileView("chat"); if (view === "home") textareaRef.current?.focus(); }
    setView(target);
    setCatalogOpen(target === "discover");
    setHistoryOpen(target === "history");
    if (target === "history") setSavedSessions(getSavedSessions());
    if (window.location.hash !== `#${target}`) window.history.pushState(null, "", `#${target}`);
  }

  function prefill(prompt: string) {
    ownedProfileLine.current = null;
    setProfileDraft({ ...EMPTY_PROFILE_DRAFT });
    setMessage(prompt);
    navigate(hasResult || viewedTryon || recommendedProductIds.length ? "outfit" : "home");
    setMobileView("chat");
    focusIntent.current = "composer";
  }

  function openProfile() {
    profileOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    profileApplied.current = false;
    setPanelRecovery(null);
    setProfileOpen(true);
  }

  function closeProfile() {
    setProfileOpen(false);
    setPanelEditing(null); setPanelRecovery(null);
    requestAnimationFrame(() => {
      if (profileApplied.current) textareaRef.current?.focus();
      else profileOrigin.current?.focus();
    });
  }

  async function restoreUnsavedEditing() {
    const owner = profile.identityReady ? profileEditOwner(profile.profile) : null;
    if (!editRecovery || !sameProfileEditOwner(owner, editRecovery.owner)) return;
    const candidate = editRecovery, epoch = sessionEpoch.current;
    const latest = await profile.refresh();
    if (epoch !== sessionEpoch.current || !sameProfileEditOwner(profileEditOwner(latest), candidate.owner)) return;
    // A successful clear/read expiry takes precedence over an older unsaved copy.
    if ((latest?.status === "cleared" || latest?.status === "expired") && candidate.profileVersion !== latest.profile_version) return;
    setMessage(candidate.message); setProfileDraft({ ...candidate.profileDraft });
    ownedProfileLine.current = candidate.ownedProfileLine;
    setPanelEditing(candidate.panel); setPanelRecovery(candidate.panel);
    if (candidate.panel) { setPanelRecoveryRevision(value => value + 1); setProfileOpen(true); }
    else textareaRef.current?.focus();
    setEditRecovery(null); setEditBackupNotice("已恢复本范围的未保存编辑。请重新核对；没有保存资料或发送搭配请求。");
  }

  function applyChoices(draft: ProfileDraft) {
    const text = applyProfileDraft(message, draft, ownedProfileLine.current);
    prefill(text);
    ownedProfileLine.current = profileDraftLine(draft) || null;
    setProfileDraft({ ...draft });
    profileApplied.current = true;
  }

  function clearChoices() {
    removeProfileEditBackup(profileEditOwner(profile.profile));
    setEditRecovery(null); setPanelEditing(null); setPanelRecovery(null); setProfileOpen(false);
    setProfileDraft({ ...EMPTY_PROFILE_DRAFT });
    setSupplementField(null);
    setScenePrompt(false);
    setMessage(removeProfileDraft(message, ownedProfileLine.current));
    ownedProfileLine.current = null;
    profileApplied.current = true;
    // Accepted/pending requests retain their original immutable body.
  }

  const clearAfterServerRemoval = useEffectEvent(() => clearChoices());
  useEffect(() => {
    const owner = profileEditOwner(profile.profile);
    if (!profile.profile) return;
    const previous = lastProfileRemovalState.current;
    const identity = owner ? `${owner.scope_kind}:${owner.context_id}` : `legacy:${profile.profile.scope_kind}:${profile.profile.profile_id ?? "empty"}`;
    lastProfileRemovalState.current = { identity, version: profile.profile.profile_version };
    if (profile.profile.status === "cleared" || profile.profile.status === "expired") {
      const backup = readProfileEditBackup(owner);
      if (previous?.identity === identity ? previous.version !== profile.profile.profile_version : backup?.profileVersion !== profile.profile.profile_version) clearAfterServerRemoval();
    }
  }, [profile.profile]);

  useLayoutEffect(() => {
    const intent = focusIntent.current;
    focusIntent.current = null;
    if (intent === "composer") textareaRef.current?.focus();
    else if (intent === "catalog") catalogButtonRef.current?.focus();
    else if (intent === "title") pageTitleRef.current?.focus();
  }, [view, message, mobileView, focusRevision]);

  const startPolling = useCallback((taskId: string) => {
    if (pollRefs.current.has(taskId)) return;
    const epoch = sessionEpoch.current;
    const interval = setInterval(async () => {
      try {
        const t = await fetchTryonStatus(taskId);
        if (epoch !== sessionEpoch.current) return;
        if (t.status === "succeeded") {
          clearInterval(interval);
          pollRefs.current.delete(taskId);
          setTryons((ts) => ts.map((x) => (x.id === taskId && x.status === "processing" ? { ...x, status: "succeeded", resultUrl: t.result_url ? appPath(t.result_url) : undefined, productIds: t.product_ids ?? x.productIds } : x)));
        } else if (t.status === "failed") {
          clearInterval(interval);
          pollRefs.current.delete(taskId);
          setTryons((ts) => ts.map((x) => (x.id === taskId && x.status === "processing" ? { ...x, status: "failed", error: t.error?.message || "效果图生成失败" } : x)));
        }
      } catch {
        // 查询失败不中断，下次继续轮询
      }
    }, 3000);
    pollRefs.current.set(taskId, interval);
  }, []);

  useEffect(() => {
    if (!identityReady) return;
    let disposed = false;
    const epoch = ++sessionEpoch.current;
    async function initializeSession() {
    let selected = peekSessionId();
    if (!selected) {
      const created = await createPrivateOutfitSession();
      if (disposed || epoch !== sessionEpoch.current) return;
      selected = created.session_id; rememberSession(selected);
    }
    const sid = selected;
    const sessionId = sid;
    sessionIdRef.current = sid;
    setActiveSessionId(sid);
    let stored: PreparedChatRequest | null = null;
    try {
      const value = JSON.parse(sessionStorage.getItem(chatStorageKey(sid)) || "null");
      if (isStoredChatRequest(value, sid)) stored = value;
    } catch { /* A malformed local pending entry is not a server result. */ }
    // Do not reveal a stored request before this identity can read its session.
    pollRefs.current.forEach(interval => clearInterval(interval));
    pollRefs.current.clear();
    const current = () => !disposed && epoch === sessionEpoch.current && sessionIdRef.current === sid;
    async function recover() {
      const outcomes = await Promise.allSettled([
        fetchHistory(sid), fetchTryons(sid),
        fetchRecommendedIds(sid).then(async ids => ({ ids, products: await fetchProducts(ids) })),
        fetchCart(sessionId),
        stored?.request_conditions !== undefined && !stored.profile_binding ? fetchFixedSession(sessionId) : Promise.resolve(true),
      ]);
      if (!current()) return;
      const [messages, images, products, cart, preparationOwner] = outcomes;
      let sameKnownOwner = false;
      try {
        const owner = JSON.parse(sessionStorage.getItem(`styling.pending-chat-owner.v1:${sid}`) || "null");
        sameKnownOwner = !!owner?.profile_id && owner.request_id === stored?.request_id && owner.profile_id === pendingOwner.current?.profile_id && owner.scope_kind === pendingOwner.current?.scope_kind;
      } catch { /* An old public session GET does not prove ownership of a local draft. */ }
      const needsOwnerProof = stored?.request_conditions !== undefined && !stored.profile_binding;
      const canRestorePending = preparationOwner.status === "fulfilled" && !!preparationOwner.value && (!needsOwnerProof || sameKnownOwner);
      if (messages.status === "fulfilled") {
        setHistory(messages.value);
        if (canRestorePending) savePendingChat(stored, sessionId, true);
        else { pendingChatRef.current = null; setPendingChat(null); setRequestBlock("PROFILE_PENDING_OWNER_UNVERIFIED"); setError("旧草稿的资料归属尚未确认，已保留但不会展示或重发。请开始新的私有对话并重新输入需求。"); }
        if (stored && canRestorePending) {
          setMessage(current => current || stored!.message);
          try {
            const block = JSON.parse(sessionStorage.getItem(`styling.blocked-chat.v1:${sid}`) || "null");
            if (block?.request_id === stored.request_id && typeof block.code === "string") setRequestBlock(block.code);
          } catch { /* A malformed marker cannot change the original request. */ }
        }
      } else { pendingChatRef.current = null; setPendingChat(null); }
      if (images.status === "fulfilled") {
        const mapped: TryonRecord[] = images.value.map((t) => ({
          id: t.task_id,
          status: t.status,
          resultUrl: t.result_url ? appPath(t.result_url) : undefined,
          productIds: t.product_ids,
          error: t.error?.message,
          scene: t.scene || "通勤",
        }));
        setTryons(mapped);
        mapped.filter(item => item.status === "processing").forEach(item => startPolling(item.id));
        setViewedTryonId(id => mapped.some(item => item.id === id) ? id : mapped.at(-1)?.id ?? null);
      }
      if (products.status === "fulfilled") { setRecommendedProductIds(products.value.ids); setRecommendedProducts(products.value.products); }
      if (cart.status === "fulfilled") setCartIds(cart.value);
      const names = ["对话记录", "图片记录", "推荐单品", "模拟加购记录", "旧请求归属"];
      setRecoveryErrors(outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [`${names[index]}暂时无法读取，请重试恢复；已有内容保留。`] : []));
      if (!window.location.hash && ((messages.status === "fulfilled" && messages.value.length > 0) || (images.status === "fulfilled" && images.value.length > 0) || (products.status === "fulfilled" && products.value.ids.length > 0))) setView("outfit");
      setRestoring(false);
      if (stored && canRestorePending && messages.status === "fulfilled") {
        try {
          const record = await fetchGenerationRequest(sid, stored.request_id);
          if (!current() || pendingChatRef.current?.request_id !== stored.request_id) return;
          const event = record ? generationRequestEvent(record) : null;
          if (event) onPendingRecovery(event, stored, epoch);
          else setError(record ? "上次请求仍待确认，可继续查询原请求；不会重复生成。" : "上次请求尚未被服务端找到，可按原编号重试发送。");
        } catch { if (current()) setError("上次请求状态暂时无法确认，需求与原编号已保留。"); }
      }
    }
    await recover();
    }
    void initializeSession().catch(() => {
      if (!disposed && epoch === sessionEpoch.current) { setRestoring(false); setRecoveryErrors(["对话记录初始化失败，请重试恢复记录；本次编辑保留。"]); }
    });
    return () => { disposed = true; };
  }, [startPolling, restoreAttempt, savePendingChat, identityReady]);

  useEffect(() => {
    if (view !== "history" || !identityReady) return;
    let active = true;
    fetchSavedSessionIndex().then(items => { if (active) { setSavedSessions(items); setIndexError(""); } }).catch(() => { if (active) setIndexError("服务端会话列表暂时无法读取，仍保留本机历史入口。"); });
    return () => { active = false; };
  }, [view, identityReady]);

  const invalidateSession = useCallback(() => { sessionEpoch.current++; sessionIdRef.current = ""; }, []);

  // 卸载时失效异步请求并清理试穿轮询。
  useEffect(() => {
    const refs = pollRefs.current;
    return () => {
      invalidateSession();
      refs.forEach((iv) => clearInterval(iv));
      refs.clear();
    };
  }, [invalidateSession]);

  // 新消息到达时，若用户停留在底部则自动跟随；用户上翻看上下文时不打断
  useEffect(() => {
    const el = messagesRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [displayHistory, streaming, view, supplementField]);

  // 选中照片出现预览时，自动滚到底部，让"确认生成/取消"按钮可见
  useEffect(() => {
    if (pendingPhoto) {
      stickToBottomRef.current = true;
      const scrollToBottom = () => {
        const el = messagesRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      };
      requestAnimationFrame(scrollToBottom);
      // 预览图加载后可能撑高内容，再补一次滚动
      const t = setTimeout(scrollToBottom, 200);
      return () => clearTimeout(t);
    }
  }, [pendingPhoto]);

  // 方案生成后（有商品可试穿）自动滚到底部，让上传入口可见；
  // 推荐单品卡片是异步加载的（recommendedProducts），渲染完成后再补滚一次
  useEffect(() => {
    if (recommendedProductIds.length > 0) {
      stickToBottomRef.current = true;
      const scrollToBottom = () => {
        const el = messagesRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      };
      requestAnimationFrame(scrollToBottom);
      // 卡片图片加载会撑高内容，稍后再补一次滚动，确保卡片和上传按钮可见
      const t = setTimeout(scrollToBottom, 200);
      return () => clearTimeout(t);
    }
  }, [recommendedProductIds, recommendedProducts]);

  function handleScroll() {
    const el = messagesRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function applyChatEvent(ev: ChatEvent, request: PreparedChatRequest, epoch: number) {
    if (epoch !== sessionEpoch.current || request.session_id !== sessionIdRef.current || pendingChatRef.current?.request_id !== request.request_id) return;
    if (ev.type === "status") setStreamingStatus(ev.message);
    else if (ev.type === "text") setStreaming(value => value + ev.content);
    else if (ev.type === "done") {
      savePendingChat(null, request.session_id);
      if (ev.outcome === "complete_outfit" && !isCompleteOutfit(ev.outfit)) {
        lastFailedRequest.current = request; setError("返回的固定搭配缺少有效版本、图片或三件SKU，原方案保留。"); setMessage(current => current || request.message);
      } else {
        setHistory(rows => [...rows, { role: "assistant", content: ev.content }]);
        setResultOutcome(ev.outcome || "text_complete");
        setSupplementField(ev.outcome === "clarification" ? nextProfileField(ev.profile_context) : null);
        setScenePrompt(ev.outcome === "clarification" && ev.profile_context?.clarification?.next_field === "scene" && ev.profile_context.missing_fields.includes("scene"));
        if (ev.outcome) {
          if (ev.outcome === "complete_outfit" && ev.outfit) fixed.setViewedId(ev.outfit.look_version_id);
          if (["no_match", "refusal", "action_failed"].includes(ev.outcome)) setMessage(current => current || request.message);
          void fixed.refresh().catch(() => { if (epoch === sessionEpoch.current) setError("搭配已返回，但固定版本读取失败，请重新读取记录；原方案保留。"); });
        } else {
          const ids = ev.product_ids || [];
          setRecommendedProductIds(ids);
          setRecommendedProducts(items => items.filter(item => ids.includes(item.product_id)));
          void fetchProducts(ids).then(items => { if (epoch === sessionEpoch.current) setRecommendedProducts(items); }).catch(() => { if (epoch === sessionEpoch.current) setRecoveryErrors(values => [...values, "推荐单品暂时无法读取，请重试恢复；已有搭配文字保留。"]); });
        }
      }
      setStreaming(""); setStreamingStatus(""); setGenerating(false);
    } else if (ev.type === "error") {
      savePendingChat(null, request.session_id); lastFailedRequest.current = request; setResultOutcome("");
      setError(ev.error.code === "NO_API_KEY" ? "当前搭配服务暂未就绪，无法生成方案。需求已保留，可稍后再试。" : ev.error.message);
      setMessage(current => current || request.message); setStreaming(""); setStreamingStatus(""); setGenerating(false);
      // A server interruption can happen after a fixed version was committed.
      void fixed.refresh().catch(() => null);
    }
  }

  async function checkPendingRequest() {
    const request = pendingChatRef.current;
    if (!request || sendLock.current) return;
    const epoch = sessionEpoch.current;
    sendLock.current = true; setGenerating(true);
    try {
      const record = await fetchGenerationRequest(request.session_id, request.request_id);
      if (epoch !== sessionEpoch.current) return;
      const event = record ? generationRequestEvent(record) : null;
      if (event) { applyChatEvent(event, request, epoch); await fixed.refresh().catch(() => null); }
      else setError(record ? "这次请求尚未获得可确认的终态，请稍后再次查询；不会创建新需求。" : "服务端尚未找到这次请求。可用原编号重试发送；不会生成新的请求编号。");
    } catch { if (epoch === sessionEpoch.current) setError("请求状态暂时无法确认，需求与原编号已保留，请稍后再次查询。"); }
    finally { if (epoch === sessionEpoch.current) { sendLock.current = false; setGenerating(false); } }
  }

  function editNewProfileRequest() {
    const original = pendingChatRef.current;
    if (!original || !profileRequestNeedsConfirmation(requestBlock)) return;
    // An explicit user transition, never an automatic reprepare or new POST.
    try { sessionStorage.setItem(`styling.previous-chat.v1:${original.request_id}`, JSON.stringify(original)); }
    catch { setError("无法保留旧请求，请先复制原需求并稍后重试；不会自动换编号。"); return; }
    savePendingChat(null, original.session_id);
    setMessage(current => current || original.message); setRequestBlock("");
    setError("旧请求已保留。请核对当前资料和需求，再点击发送以创建新请求。");
    textareaRef.current?.focus();
  }

  async function send(text?: string, retry?: PreparedChatRequest, onlyCurrent = false) {
    const raw = (text ?? message).trim();
    if (!retry && isPersonalPreviewIntent(raw)) { personalPreview.openPanel(); return; }
    if (!raw || (!profile.ready && !(onlyCurrent && completeTemporaryConditions)) || sendLock.current || generating || restoring || historyUnavailable || fixed.loading) return;
    if (fixedOutfit && fixedOutfit.look_version_id !== fixed.session?.state.current_look_version_id && !retry) { setError("正在查看历史版本。请先回到当前方案，再继续表达换搭需求；草稿保留。"); return; }
    if (pendingChatRef.current && !retry) { setError("上次请求结果尚未确认，请先查询原请求状态；不会把重试记作新需求。"); return; }
    if (!retry && lastFailedRequest.current?.message === raw) { setError("这次需求已返回失败，原编号不会重复执行。请调整需求后再发送；原方案与草稿保留。"); return; }
    const epoch = sessionEpoch.current;
    const sid = sessionIdRef.current || getSessionId();
    const detected = detectScene(raw);
    if (detected && !sceneRef.current) { sceneRef.current = detected; setTryonScene(detected); }
    let request = retry ?? createProfileChatRequest(sid, raw, profileRequestConditions(profileDraft));
    let expectedPreparationOwner: { profile_id: string | null; profile_version: number } | null = null;
    if (retry && request.request_conditions !== undefined && !request.profile_binding) {
      try {
        const marker = JSON.parse(sessionStorage.getItem(`styling.pending-chat-owner.v1:${sid}`) || "null");
        if (marker?.request_id === request.request_id && Number.isSafeInteger(marker.profile_version) && marker.profile_version >= 0
          && (marker.profile_id === null || typeof marker.profile_id === "string" && marker.profile_id.length > 0)) {
          expectedPreparationOwner = { profile_id: marker.profile_id, profile_version: marker.profile_version };
        }
      } catch { /* A missing original version cannot be replaced by today's defaults. */ }
    }
    sendLock.current = true; savePendingChat(request, sid, Boolean(retry));
    if (!retry) events.emit({ event_name: "message_submit", source_slot: "composer", request_id: request.request_id });
    navigate("outfit"); setMobileView("chat");
    if (!retry) setHistory(rows => [...(fixed.session?.messages ?? rows), { role: "user", content: raw }]);
    if (!retry) {
      setMessage(""); ownedProfileLine.current = null; setProfileDraft({ ...EMPTY_PROFILE_DRAFT }); setSupplementField(null); setScenePrompt(false);
      if (textareaRef.current) { textareaRef.current.value = ""; textareaRef.current.blur(); }
    }
    setError(""); setRequestBlock(""); setResultOutcome(""); setStreaming(""); setStreamingStatus("正在为你搭配…"); setGenerating(true);
    stickToBottomRef.current = true;
    try {
      if (retry) {
        const record = await fetchGenerationRequest(sid, request.request_id);
        if (epoch !== sessionEpoch.current) return;
        const terminal = record ? generationRequestEvent(record) : null;
        if (terminal) { applyChatEvent(terminal, request, epoch); return; }
        if (record) { setError("原请求仍在处理或未记录终态，请继续查询，不重复发送。"); setMessage(current => current || raw); return; }
      }
      if (request.request_conditions !== undefined && !request.profile_binding) {
        if (retry && !await fetchFixedSession(sid)) {
          throw new ProfileApiError(409, "PROFILE_PENDING_OWNER_UNVERIFIED", "旧准备的资料归属无法确认。原请求已保留，请明确开始新私有对话并重新输入。");
        }
        if (epoch !== sessionEpoch.current) return;
        const prepared = await prepareConsumerProfile({ operation: "chat", session_id: sid, request_id: request.request_id, request_body: request });
        if (epoch !== sessionEpoch.current) return;
        request = Object.freeze({ ...request, profile_binding: prepared.profile_binding });
        savePendingChat(request, sid, Boolean(retry));
        if (retry && (!expectedPreparationOwner || expectedPreparationOwner.profile_version !== prepared.profile_binding.profile_version
          || expectedPreparationOwner.profile_id !== prepared.profile_binding.profile_id)) {
          throw new ProfileApiError(409, "PROFILE_PREPARATION_CHANGED", "无法确认重试准备仍使用最初的资料版本。原请求及返回绑定已保留，请保留旧请求，重新编辑并确认本次条件。");
        }
      }
      await sendPreparedChat(request, event => applyChatEvent(event, request, epoch));
    } catch (cause) {
      if (epoch !== sessionEpoch.current) return;
      if (cause instanceof ProfileApiError || cause instanceof FixedApiError) {
        setRequestBlock(cause.code);
        try { sessionStorage.setItem(`styling.blocked-chat.v1:${sid}`, JSON.stringify({ request_id: request.request_id, code: cause.code })); } catch { /* Original body remains in memory. */ }
      }
      setError(cause instanceof Error ? cause.message : "连接中断，正在保留请求编号。请查询原请求结果。");
      setMessage(current => current || raw); setStreaming(""); setStreamingStatus("");
    } finally { if (epoch === sessionEpoch.current) { sendLock.current = false; setGenerating(false); } }
  }

  async function fixedAction(input: FixedActionInput) {
    if (!profile.ready || restoring || generating || fixed.pending) return;
    if (input.operation === "restore_history") events.emit({ event_name: "history_restore", source_slot: "fixed_history_restore", look_version_id: input.target_look_version_id });
    const result = await fixed.perform(input.operation === "restore_history" ? { ...input, request_conditions: profileRequestConditions(profileDraft) } : input);
    if (result?.outcome === "complete_outfit" || result?.outcome === "action_completed") setError("");
    if (result?.outcome === "complete_outfit") navigate("outfit");
  }

  async function viewFixedHistory(id: string) {
    const owner = sessionEpoch.current;
    try {
      const value = await fixed.refresh();
      if (owner !== sessionEpoch.current || !value?.history.some(item => item.look_version_id === id)) return;
      fixed.setViewedId(id);
      events.emit({ event_name: "history_restore", source_slot: "fixed_history_view", look_version_id: id });
      navigate("outfit");
    } catch { if (owner === sessionEpoch.current) setError("历史版本读取失败，原方案保留。"); }
  }

  async function newConversation(keepDraft = false) {
    if (!profile.ready || sendLock.current) return;
    const oldEpoch = sessionEpoch.current;
    sendLock.current = true; setRestoring(true);
    let nextId: string;
    try { nextId = (await createPrivateOutfitSession()).session_id; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "新对话未创建，请重试。"); return; }
    finally { if (oldEpoch === sessionEpoch.current) { sendLock.current = false; setRestoring(false); } }
    if (oldEpoch !== sessionEpoch.current) return;
    const retained = keepDraft ? message || pendingChatRef.current?.message || "" : "";
    sessionEpoch.current++;
    rememberSession(nextId);
    sessionIdRef.current = nextId;
    setActiveSessionId(sessionIdRef.current); pendingChatRef.current = null; setPendingChat(null); lastFailedRequest.current = null; sendLock.current = false; setResultOutcome("");
    navigate("home");
    setHistoryOpen(false);
    sceneRef.current = "";
    setHistory([]);
    setStreaming("");
    setStreamingStatus("");
    setError("");
    setMessage(retained); setRequestBlock("");
    setProfileDraft({ ...EMPTY_PROFILE_DRAFT }); setSupplementField(null); setScenePrompt(false); setProfileOpen(false);
    ownedProfileLine.current = null;
    setRecommendedProductIds([]);
    setRecommendedProducts([]);
    setCartIds([]);
    setTryons([]);
    setViewedTryonId(null);
    setImageFailures({}); setProductImageFailures({}); setRecoveryErrors([]); setRestoring(false); setMobileView("chat");
    cartOperations.current.clear(); setCartPending([]);
    pollRefs.current.forEach((iv) => clearInterval(iv));
    pollRefs.current.clear();
    stickToBottomRef.current = true;
    textareaRef.current?.focus();
  }

  // 模拟加购（PRD v1.3 feedback_type=simulated_cart）：加购→信号类型自动转 simulated_cart；清空→还原 intent
  async function toggleCart(productId: string) {
    if (cartOperations.current.has(productId)) return;
    cartOperations.current.add(productId);
    setCartPending(ids => [...ids, productId]);
    const epoch = sessionEpoch.current;
    const sid = sessionIdRef.current;
    const adding = !cartIds.includes(productId);
    try {
      if (adding) {
        await addCart(sid, productId);
        if (epoch !== sessionEpoch.current) return;
        setCartIds((ids) => [...ids, productId]);
      } else {
        await removeCart(sid, productId);
        if (epoch !== sessionEpoch.current) return;
        setCartIds(ids => ids.filter(id => id !== productId));
      }
    } catch (e) {
      if (epoch === sessionEpoch.current) setError(e instanceof Error ? e.message : "加购操作失败，请稍后重试");
    } finally { if (epoch === sessionEpoch.current) { cartOperations.current.delete(productId); setCartPending(ids => ids.filter(id => id !== productId)); } }
  }


  async function startTryon(file: File) {
    if (recommendedProductIds.length === 0) return;
    const sid = sessionIdRef.current;
    const epoch = sessionEpoch.current;
    const scene = sceneRef.current || tryonScene;
    const productIds = [...recommendedProductIds];
    const localId = `local-${Date.now()}`;
    setTryons((ts) => [...ts, { id: localId, status: "processing", scene, productIds }]);
    setViewedTryonId(localId);
    try {
      const { task_id } = await uploadTryon(file, productIds, scene, sid);
      if (epoch !== sessionEpoch.current) return;
      // 上传等待期间若已被取消，则不再开始轮询
      let cancelled = false;
      setTryons((ts) => {
        const target = ts.find((t) => t.id === localId);
        if (target && target.status !== "processing") cancelled = true;
        return ts.map((t) => (t.id === localId ? { ...t, id: task_id } : t));
      });
      if (cancelled) return;
      setViewedTryonId(task_id);
      startPolling(task_id);
    } catch (e) {
      if (epoch !== sessionEpoch.current) return;
      setTryons((ts) => ts.map((t) => (t.id === localId ? { ...t, status: "failed", error: e instanceof Error ? e.message : "照片上传失败，请稍后重试" } : t)));
    }
  }

  function cancelTryon(id: string) {
    const iv = pollRefs.current.get(id);
    if (iv) {
      clearInterval(iv);
      pollRefs.current.delete(id);
    }
    setTryons((ts) => ts.map((t) => (t.id === id && t.status === "processing" ? { ...t, status: "cancelled" } : t)));
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      // 先本地预览，用户确认后再真正提交生成（避免上传即扣费）
      setPendingPhoto((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return { file, url: URL.createObjectURL(file) };
      });
    }
    e.target.value = ""; // 允许再次选择同一文件
  }

  function confirmTryon() {
    if (!pendingPhoto) return;
    const file = pendingPhoto.file;
    setPendingPhoto(null);
    startTryon(file);
  }

  function cancelPreview() {
    if (pendingPhoto?.url) URL.revokeObjectURL(pendingPhoto.url);
    setPendingPhoto(null);
  }

  function openAbout() {
    setAboutOpen(true);
    aboutRef.current?.showModal();
  }

  function closeCatalog() {
    navigate(hasResult || viewedTryon ? "outfit" : "home");
    focusIntent.current = "catalog";
  }

  function closeAbout() {
    aboutRef.current?.close();
  }

  return (
    <ConsumerEventsProvider value={events}><div className={styles.studio} data-layout={discovery ? "discovery" : "conversation"}>
      <a className="skip-link" href="#chat-input">跳到输入框</a>
      <aside className={styles.sideRail} aria-label="穿搭功能导航">
        <a className={styles.railBrand} href={appPath("/")} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate("home"); } }} aria-label="穿搭" aria-current="page"><span aria-hidden="true">S</span><span className={styles.srOnly}>穿搭</span></a>
        <nav>
          <button title="首页" aria-label="首页" aria-current={view === "home" ? "page" : undefined} onClick={() => navigate("home")}><Home size={22} aria-hidden="true" /><span>首页</span></button>
          <button ref={catalogButtonRef} aria-controls="scene-catalog" title="发现单品" aria-label="浏览场景与商品提示" aria-current={view === "discover" ? "page" : undefined} aria-expanded={catalogOpen} onClick={() => navigate("discover")}><LayoutGrid size={22} aria-hidden="true" /><span>发现</span></button>
          <button title="我的搭配" aria-label="我的搭配" aria-current={view === "outfit" ? "page" : undefined} onClick={() => navigate("outfit")}><Sparkles size={22} aria-hidden="true" /><span>搭配</span></button>
          <button title="模拟购物袋" aria-label="模拟购物袋" aria-current={view === "bag" ? "page" : undefined} onClick={() => navigate("bag")}><ShoppingBag size={22} aria-hidden="true" />{cartIds.length + (fixed.session?.cart_items.reduce((n, item) => n + item.quantity, 0) ?? 0) > 0 && <b className={styles.cartBadge}>{cartIds.length + (fixed.session?.cart_items.reduce((n, item) => n + item.quantity, 0) ?? 0)}</b>}<span>购物袋</span></button>
          <button title="历史对话" aria-label="历史对话" disabled={restoring || generating || !!latestProcessing || !!pendingPhoto} aria-current={view === "history" ? "page" : undefined} aria-expanded={historyOpen} aria-controls="conversation-history" onClick={() => navigate("history")}><History size={22} aria-hidden="true" /><span>历史</span></button>
        </nav>
        <div className={styles.railUtilities}>
          <button className={styles.railProfile} title="我的穿搭资料" aria-label="我的穿搭资料" onClick={openProfile} aria-haspopup="dialog" aria-expanded={profileOpen}><SlidersHorizontal size={21} aria-hidden="true" /><span>资料</span></button>
          <button className={styles.railAbout} title="关于体验" aria-label="关于体验" ref={aboutButtonRef} onClick={openAbout} aria-haspopup="dialog" aria-expanded={aboutOpen}><Info size={21} aria-hidden="true" /></button>
        </div>
      </aside>
      <div className={styles.topStrip}><span className={styles.stripMark} aria-hidden="true">穿</span><span>{process.env.NEXT_PUBLIC_STYLING_FIXTURE === "true" ? "穿搭推荐使用离线规则 · 本人效果以生成服务状态为准" : "AI 穿搭体验 · 模拟商品仅供参考"}</span><ArrowRight size={14} aria-hidden="true" /></div>


      <ConsumerEventNotice controller={events} />
      {!profile.ready && <div className={styles.fixedNotice} role={profile.error ? "alert" : "status"}>
        {profile.error && <span>{profile.error}</span>}
        {profile.pendingMutation ? <>
          <span>{profile.canReplayPending ? "有一条资料操作待确认，原编号与编辑已保留。" : "旧资料操作仅可查询，原保存授权不能继续写入。"}</span>
          <button type="button" onClick={openProfile}>查看待确认资料操作</button>
        </> : <>
          {!profile.error && <span>{profile.status === "loading" ? profile.profile ? "正在重新读取本浏览器的穿搭资料…" : "正在初始化本浏览器的穿搭资料…" : profile.busy ? "正在确认资料操作…" : "资料暂未就绪，请打开资料面板核对。"}</span>}
        </>}
        {profile.error && <button onClick={() => void profile.refresh()}>重新读取我的资料</button>}
        <span>可以先编辑需求，资料就绪后再发送。</span>
      </div>}
      {view !== "home" && <div className={styles.pageHeader} key={view}>
        <div><span className={styles.headerEyebrow}>YOUR PERSONAL STYLING SPACE</span><h1 ref={pageTitleRef} tabIndex={-1}>{view === "discover" ? "发现单品" : view === "bag" ? "模拟购物袋" : view === "history" ? "历史对话" : "我的搭配"}</h1></div>
        <button aria-label="新对话" disabled={restoring || generating || !!latestProcessing || !!pendingPhoto} onClick={() => void newConversation()}><Plus size={18} aria-hidden="true" />新对话</button>
      </div>}
      {profile.ready && view === "discover" && <section id="scene-catalog" ref={catalogRef} className={styles.destination} aria-label="浏览场景与商品提示" onKeyDown={event => { if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest("dialog")) && !catalogRef.current?.querySelector("dialog[open]")) { event.preventDefault(); closeCatalog(); } }}>
        <button className={styles.backButton} aria-label="关闭商品提示" onClick={closeCatalog}>返回穿搭 <ArrowUpRight size={16} aria-hidden="true" /></button>
        <ConsumerCollection mode="discover" sessionId={sessionIdRef.current} cartIds={cartIds} onPrefill={prefill} onCartChange={setCartIds} disabled={restoring} /><div className={styles.destinationPrompts}><span>从场景开始</span><button onClick={() => { events.emit({ event_name: "draft_prefill", source_slot: "discover_scene_work" }); prefill("帮我搭一套日常通勤装，简单利落，走路舒服。"); }}>日常通勤</button><button onClick={() => { events.emit({ event_name: "draft_prefill", source_slot: "discover_scene_weekend" }); prefill("帮我搭一套周末出游的穿搭，轻松一点，方便走路，有点层次感。"); }}>周末出游</button><button onClick={() => { events.emit({ event_name: "draft_prefill", source_slot: "discover_scene_date" }); prefill("帮我搭一套约会聚会的穿搭，自然大方，不要太正式。"); }}>约会聚会</button></div>
      </section>}
      {profile.ready && view === "bag" && <section className={styles.destination} aria-label="当前会话模拟购物袋">{fixed.session && <FixedBag session={fixed.session} disabled={generating || fixed.pending || !!fixed.retryAction} onAction={fixedAction} />}<h2>灵感目录模拟购物袋</h2>{cartUnavailable ? <div className={styles.recoveryError} role="alert"><p>模拟加购记录暂时无法读取，不能确认购物袋内容与合计。</p><button disabled={restoring || generating} onClick={() => { if (restoring || generating) return; setRestoring(true); setRestoreAttempt(value => value + 1); }}>重新读取购物袋记录</button></div> : <ConsumerCollection mode="bag" sessionId={sessionIdRef.current} cartIds={cartIds} onPrefill={prefill} onCartChange={setCartIds} disabled={restoring || generating} />}</section>}
      {historyOpen && view === "history" && <section id="conversation-history" className={`conversation-history ${styles.historyPage}`} aria-label="历史对话">
        <div><h2>继续你的穿搭故事</h2><button onClick={() => navigate("home")} aria-label="关闭历史对话"><X size={18} aria-hidden="true" /></button></div>
        <button className={styles.personalPreviewButton} type="button" onClick={personalPreview.openPanel} aria-haspopup="dialog">查看本人效果记录</button>
        {fixed.session && <FixedHistory session={fixed.session} viewedId={fixed.viewedId} disabled={generating || fixed.pending || !!fixed.retryAction} onView={viewFixedHistory} onAction={fixedAction} />}
        <p>打开已有对话可读取已保存的完整搭配与文字，不调用模型。</p>{indexError && <p role="alert">{indexError}</p>}
        <ul>{savedSessions.map((item, index) => <li key={item.id}><button aria-current={item.id === sessionIdRef.current ? "true" : undefined} onClick={() => { if (selectSavedSession(item.id)) { window.history.replaceState(null, "", "#outfit"); onSessionSwitch(); } }}>
          <MessageCircle size={24} aria-hidden="true" /><span>对话 {savedSessions.length - index}{item.id === sessionIdRef.current ? " · 当前" : ""}</span><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString("zh-CN")}</time><ArrowUpRight size={18} aria-hidden="true" />
        </button></li>)}</ul>
      </section>}
      {workspaceEmpty && <section className={styles.destination} aria-label="我的搭配示例"><div className={styles.personalPreviewEntry}><button className={styles.personalPreviewButton} type="button" onClick={personalPreview.openPanel} aria-haspopup="dialog">看看我穿的效果</button><p>先生成一套完整搭配，再选择本人照片。上传照片是可选的。</p></div><ConsumerLookExamples /><button className={styles.startStyling} onClick={() => { navigate("home"); requestAnimationFrame(() => textareaRef.current?.focus()); }}>说说你的场景，开始自己的搭配 <ArrowRight size={18} aria-hidden="true" /></button></section>}

      {(fixed.error || fixed.notice || fixed.pending || fixed.retryAction) && <div className={styles.fixedNotice} role={fixed.error ? "alert" : "status"}>{fixed.error || fixed.requestBlock?.message || fixed.notice || "正在更新固定搭配记录…"}{fixed.error && <button disabled={fixed.pending} onClick={() => void fixed.refresh().catch(() => null)}>重新读取固定记录</button>}{fixed.retryAction && (
        fixed.requestBlock?.code === "PROFILE_SESSION_RESTART_REQUIRED" ? <button disabled={fixed.pending || !profile.ready} onClick={() => void newConversation(true)}>开始新对话并使用我的资料</button>
          : fixed.requestBlock ? <button disabled={fixed.pending || !profile.ready} onClick={() => fixed.confirmNewAction()}>保留原恢复操作，重新选择</button>
            : <button disabled={fixed.pending || !profile.ready} onClick={() => void fixed.retry()}>用原操作编号重试</button>)}</div>}
      <div className={styles.viewTabs} hidden={auxiliary || workspaceEmpty} aria-label="切换穿搭视图">
        <button aria-pressed={mobileView === "chat"} aria-controls="styling-conversation" onClick={() => { setMobileView("chat"); requestAnimationFrame(() => textareaRef.current?.focus()); }}>对话</button>
        <button aria-pressed={mobileView === "outfit"} aria-controls="outfit-visual" onClick={() => setMobileView("outfit")}>完整搭配</button>
      </div>

      <main id="top" className="chat-main" hidden={auxiliary || workspaceEmpty} data-layout={discovery ? "discovery" : "conversation"} data-mobile-view={mobileView}>
        <section id="outfit-visual" className="editorial-photo" aria-label="搭配画布与当前单品">
          <div className={styles.personalPreviewEntry}><button className={styles.personalPreviewButton} type="button" onClick={personalPreview.openPanel} aria-haspopup="dialog" aria-expanded={personalPreview.open}>看看我穿的效果</button><p>{fixedOutfit ? `可选本人照片效果 · 先核对版本 ${fixedOutfit.version_no}，确认后才上传` : "先生成一套完整搭配，再选择本人照片。"}</p></div>
          {fixedOutfit ? <FixedOutfitPanel key={fixedOutfit.look_version_id} outfit={fixedOutfit} current={fixedOutfit.look_version_id === fixed.session?.state.current_look_version_id} disabled={generating || restoring || fixed.pending || !!fixed.retryAction} onAction={fixedAction} onReturnCurrent={() => { fixed.setViewedId(fixed.session?.state.current_look_version_id ?? null); setError(""); }} /> : <>
          <div className={styles.lookHeading}><div><span className={styles.headerEyebrow}>YOUR LOOK</span><h2>你的穿搭画布</h2></div><span className={styles.lookStatus}>{viewedTryon ? viewedTryon.status === "succeeded" ? "已保存的旧版效果图" : viewedTryon.status === "processing" ? "等待实际结果" : "结果未就绪" : "等待完整搭配图"}</span></div>
          <div className={styles.lookBody}><figure className={styles.boundFigure} aria-label="完整搭配与效果图">
          <div className={styles.imageCanvas}>
          {imageReady && imageUrl ? (
            <Image src={imageUrl} alt="已保存的AI合成效果图，非真实试穿或尺码效果" fill unoptimized className="tryon-result" sizes="(max-width: 900px) 100vw, 44vw" onError={() => setImageFailures(values => ({ ...values, [imageUrl]: true }))} />
          ) : !viewedTryon ? (
            <div className={styles.visualEmpty} role="status"><Sparkles size={38} aria-hidden="true" /><h2>{generating ? "正在理解你的穿搭需求" : "完整搭配图尚未提供"}</h2><p>{generating ? "顾问正在处理。搭配画面与单品会保留在这里。" : "当前服务未返回固定模特搭配图。你可以查看真实推荐单品、继续表达偏好，或展开下方独立搭配示例。"}</p><span className={styles.canvasTag}>上装 · 下装 · 鞋履</span></div>
          ) : (
            <div className={styles.visualEmpty} role="status">
              <span className={styles.visualMark} aria-hidden="true">▧</span>
              <h2>{viewedTryon.status === "processing" ? "正在等待效果图" : viewedTryon.status === "failed" ? "效果图生成失败" : viewedTryon.status === "cancelled" ? "已停止等待" : "结果图暂时无法显示"}</h2>
              <p>{viewedTryon.status === "processing" ? "任务仍在处理中。你可以继续阅读搭配建议，系统会查询实际结果。" : viewedTryon.status === "failed" ? viewedTryon.error || "生成未成功，已有对话和单品保留。" : viewedTryon.status === "cancelled" ? "已停止本页轮询，后台任务可能仍在继续。稍后可恢复记录查看。" : "任务已完成，但图片地址缺失或图片未能加载；不会用意向图替代实际结果。"}</p>
              {viewedTryon.status === "succeeded" && <button disabled={restoring || generating} onClick={() => { if (restoring || generating) return; setImageFailures({}); setRestoring(true); setRestoreAttempt(value => value + 1); }}>重新读取图片记录</button>}
            </div>
          )}
          </div>
          <figcaption>
            <strong>{viewedTryon ? "已保存的效果图" : "当前搭配状态"}</strong>
            {viewedTryon && <span>历史任务：{viewedTryon.id}</span>}
            {viewedTryon && <span>{viewedTryon.productIds?.length ? `对应商品编号：${viewedTryon.productIds.join("、")}` : "此历史任务未返回商品编号"}</span>}
            <span>{viewedTryon ? "历史效果图与当前推荐分别展示；商品价格/版本未冻结，右侧单品为当前推荐。AI 合成，仅供参考，不代表真实试穿或尺码效果。" : hasResult ? "完整图与商品必须由服务绑定；当前单品为真实接口返回，价格未冻结。" : "先聊需求，再看你的搭配。示例与实际推荐分开展示。"}</span>
          </figcaption>
          </figure>
          <aside className={styles.currentItems} aria-label="当前推荐单品">
                {!generating && recommendedProducts.length > 0 ? (
                  <div className="product-cards">
                    <span className="product-cards-title">当前推荐单品 · 模拟加购</span>
                    <div className="product-cards-list">
                      {recommendedProducts.map((p) => {
                        const inCart = cartIds.includes(p.product_id);
                        return (
                          <div key={p.product_id} className="product-card">
                            {productImageFailures[p.product_id] ? <div className={styles.productImageMissing} role="img" aria-label={`${p.name}：商品图片暂缺`}>商品图片暂缺</div> : <ConsumerObservedImage observation={{ event_name: "product_impression", source_slot: "legacy_current_item", product_id: p.product_id }} width={160} height={160} unoptimized src={appPath(p.image_url || `/product-images/${p.product_id}.png`)} alt={p.name} className="product-card-img" onError={() => setProductImageFailures(values => ({ ...values, [p.product_id]: true }))} />}
                            <span className="product-card-name">{p.name}</span>
                            <span className={styles.skuCaption}>{p.category} · {p.product_id}</span><span className="product-card-price">¥{p.price}</span>
                            <button type="button" className={`cart-button${inCart ? " added" : ""}`} disabled={cartPending.includes(p.product_id)} onClick={() => toggleCart(p.product_id)} aria-pressed={inCart}>
                              {cartPending.includes(p.product_id) ? "提交中…" : inCart ? "已加购 ✓" : "＋ 加购"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
{recommendedProducts.length === 0 && <div className={styles.noProducts}><ShoppingBag size={27} aria-hidden="true" /><h3>让单品一起搭起来</h3><p>{generating ? "正在等待顾问返回真实商品。" : "告诉顾问场景和预算，返回的商品会在这里展示。"}</p><button onClick={() => { setMobileView("chat"); requestAnimationFrame(() => textareaRef.current?.focus()); }}>继续和顾问聊 <ArrowRight size={16} aria-hidden="true" /></button></div>}
          </aside></div>

          </>}
          <details className={styles.exampleDetails} onToggle={event => setExamplesOpen(event.currentTarget.open)}><summary>查看独立搭配示例 <ChevronDown size={16} aria-hidden="true" /></summary>{examplesOpen && !discovery && <ConsumerLookExamples compact />}</details>
        </section>

        <section id="styling-conversation" className="chat-panel" aria-label="穿搭对话">
          {!discovery && <div className={styles.conversationHeading}><span className={styles.advisorAvatar}>穿</span><div><strong>你的穿搭顾问</strong><span>从你的生活出发</span></div><span className={styles.advisorDot} aria-hidden="true" /></div>}
          <div className="chat-messages" ref={messagesRef} onScroll={handleScroll}>
            {restoring && <p className={styles.recoveryStatus} role="status">正在恢复对话、图片和推荐记录…不会重新生成。</p>}
            {discovery || (displayHistory.length === 0 && !generating) ? (
              <div className="chat-empty"><ConsumerDiscovery disabled={restoring || generating} compact={!discovery} active={discovery && !auxiliary && !workspaceEmpty} onPrefill={prefill} /></div>
            ) : (
              <>
                {displayHistory.map((m, i) => (
                  <div key={i} className={`turn ${m.role}`}>
                    <div className="turn-role">{m.role === "user" ? "你" : "穿搭顾问"}</div>
                    <div className="turn-content">{m.role === "assistant" ? <ReactMarkdown>{m.content}</ReactMarkdown> : m.content}</div>
                  </div>
                ))}
                {generating ? (
                  <div className="turn assistant">
                    <div className="turn-role">穿搭顾问</div>
                    <div className="turn-content">
                      {streaming ? <ReactMarkdown>{streaming}</ReactMarkdown> : <span className="turn-status">{streamingStatus || "正在为你搭配…"}</span>}
                    </div>
                  </div>
                ) : null}
                {!fixed.session && !fixed.health?.enabled && !generating && (recommendedProductIds.length > 0 || tryons.length > 0) ? (
                  <div className="vto-card">
                    <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFileChange} hidden aria-label="上传照片" />
                    {pendingPhoto ? (
                      <div className="vto-preview">
                        <span className="vto-prompt">确认生成旧版照片 AI 效果图？仅供参考，不代表真实试穿或尺码效果。</span>
                        {/* eslint-disable-next-line @next/next/no-img-element -- 本地预览 */}
                        <img src={pendingPhoto.url} alt="待生成照片预览" className="vto-preview-img" />
                        <div className="vto-actions">
                          <button className="upload-button" type="button" onClick={confirmTryon}>确认生成</button>
                          <button className="upload-button" type="button" onClick={cancelPreview}>取消</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {recommendedProductIds.length > 0 ? (
                          <>
                            <span className="vto-prompt">旧版照片 AI 效果图 · 仅供参考，不代表真实试穿或尺码效果。选择照片后需再次确认才会生成。</span>
                            <div className="vto-actions">
                              <div className="select-field">
                                <select value={tryonScene} onChange={(e) => { const v = e.target.value; sceneRef.current = v; setTryonScene(v); }} aria-label="试穿场景"><option value="通勤">通勤</option><option value="出游">出游</option><option value="约会聚会">约会聚会</option></select>
                                <ChevronDown size={13} aria-hidden="true" />
                              </div>
                              <button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()}>上传照片</button>
                            </div>
                          </>
                        ) : null}

                        {latestProcessing ? (
                          <div className="vto-result">
                            <span className="vto-status">「{latestProcessing.scene}」任务处理中，正在查询实际结果…</span>
                            <button className="upload-button" type="button" onClick={() => cancelTryon(latestProcessing.id)}>停止等待</button>
                          </div>
                        ) : viewedTryon?.status === "failed" ? (
                          <div className="vto-result">
                            <span className="vto-status vto-error">{viewedTryon.error}</span>
                            <button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()}>重试</button>
                          </div>
                        ) : viewedTryon?.status === "succeeded" ? (
                          <div className="vto-result">
                            <span className="vto-status">{imageReady ? "已保存的AI合成效果图，可切换完整搭配查看。" : "结果图暂时无法显示，请重新读取图片记录。"}</span>
                            {/* eslint-disable-next-line @next/next/no-img-element -- 后端动态生成图，无需 Next 优化 */}
                            {imageReady && <img src={viewedTryon.resultUrl} alt="试穿效果图" className="vto-result-img" />}
                          </div>
                        ) : viewedTryon?.status === "cancelled" ? (
                          <p className="vto-status">已停止本页等待；后台任务可能仍在继续。稍后可恢复记录查看。</p>
                        ) : null}
                      </>
                    )}

                    {succeededTryons.length > 0 ? (
                      <div className="vto-history">
                        <span className="vto-history-title">历史效果图</span>
                        <div className="vto-history-list">
                          {succeededTryons.map((t) => (
                            <button key={t.id} type="button" className={`vto-thumb${viewedTryon?.id === t.id ? " active" : ""}`} onClick={() => setViewedTryonId(t.id)} aria-label={`查看${t.scene}试穿效果图`}>
                              {/* eslint-disable-next-line @next/next/no-img-element -- 后端动态生成图 */}
                              <img src={t.resultUrl} alt={`${t.scene}试穿效果图`} />
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
            {!discovery && !generating && scenePrompt && <section className={styles.profileTools} aria-label="补充使用场景"><div><strong>这次会在哪个场景穿？</strong><p>可以直接告诉顾问。当前完整图覆盖通勤；其他场景会按实际资源判断。</p></div><button type="button" onClick={() => { setMessage(current => `${current}${current ? "\n" : ""}日常通勤`); setScenePrompt(false); textareaRef.current?.focus(); }}>填入通勤场景</button><button type="button" onClick={() => setScenePrompt(false)}>我直接输入</button></section>}
            {!discovery && !generating && supplementField && <ProfileSupplementCard key={`${supplementField}:${profileDraft[supplementField]}`} field={supplementField} value={profileDraft[supplementField]} onChange={value => {
              const next = { ...profileDraft, [supplementField]: value };
              setProfileDraft(next); setMessage(applyProfileDraft(message, next, ownedProfileLine.current));
              ownedProfileLine.current = profileDraftLine(next) || null;
              requestAnimationFrame(() => textareaRef.current?.focus());
            }} onOpenProfile={openProfile} onDismiss={() => { setSupplementField(null); requestAnimationFrame(() => textareaRef.current?.focus()); }} />}
          </div>

          <div className="chat-input" id="chat-input">
            {editRecovery && profile.identityReady && sameProfileEditOwner(profileEditOwner(profile.profile), editRecovery.owner) && <div className={styles.pendingRequest}><p>本范围有未保存的编辑备份。恢复将替换当前未发送编辑；不会保存资料或发送请求。</p><button type="button" disabled={generating || profile.busy || profile.status !== "ready"} onClick={() => void restoreUnsavedEditing()}>恢复未保存的编辑</button><button type="button" onClick={() => {
              const owner = profile.identityReady ? profileEditOwner(profile.profile) : null;
              if (sameProfileEditOwner(owner, editRecovery.owner) && removeProfileEditBackup(owner)) setEditRecovery(null);
            }}>丢弃编辑备份</button></div>}
            {editBackupNotice && <p role="status">{editBackupNotice}</p>}
            {recoveryErrors.length > 0 && <div className={styles.recoveryError} role="alert">{recoveryErrors.map(item => <p key={item}>{item}</p>)}<button disabled={restoring || generating} onClick={() => { setRestoring(true); setRestoreAttempt(value => value + 1); }}>重试恢复记录</button></div>}
            {error ? <p className="chat-error" role="alert">{error}</p> : null}
            {pendingChat && !generating && <div className={styles.pendingRequest}><span>有一条请求待确认，原需求和编号已保留。</span><button disabled={!profile.ready} onClick={() => void checkPendingRequest()}>查询原请求结果</button>
              {requestBlock === "PROFILE_SESSION_RESTART_REQUIRED" ? <button disabled={!profile.ready} onClick={() => void newConversation(true)}>开始新对话并使用我的资料</button>
                : requestBlock === "PROFILE_PENDING_OWNER_UNVERIFIED" ? null : profileRequestNeedsConfirmation(requestBlock) ? <button disabled={!profile.ready} onClick={editNewProfileRequest}>保留旧请求，重新编辑</button>
                : <button disabled={!profile.ready} onClick={() => void send(pendingChat.message, pendingChat)}>按原编号重试发送</button>}
              {pendingChat.profile_binding && <small>原请求已绑定资料版本 {pendingChat.profile_binding.profile_version}；修改资料不会替换这次绑定。</small>}
            </div>}
            {requestBlock === "PROFILE_PENDING_OWNER_UNVERIFIED" && <button disabled={!profile.ready} onClick={() => void newConversation()}>开始新的私有对话</button>}
            {!profile.ready && profile.pendingMutation && !pendingChat && <div className={styles.pendingRequest}><p>保存结果待确认，不影响本次明确选择。补齐本次三尺码和预算后，可单独发送；场景按本次原话识别。不会重试保存，也不会采用缺省尺码或预算。</p><button disabled={!completeTemporaryConditions || generating || restoring || fixed.loading} onClick={() => void send(undefined, undefined, true)}>仅按完整本次条件发送</button></div>}
            {resultOutcome && <p className={styles.outcomeNote}>{({ complete_outfit: "完整搭配已返回，请核对图与三件单品。", clarification: "还需要补充信息，请继续告诉顾问。", refusal: "这次请求未执行，原方案保留。", no_match: "当前固定目录没有符合这次要求的完整搭配，原方案保留。", action_completed: "操作已完成，详情以实际记录为准。", action_failed: "操作未完成，原方案保留。", text_complete: "文字回复已完成。" } as Record<string, string>)[resultOutcome] || "已收到服务回复。"}</p>}
            {!discovery && !generating && <div className={styles.profileTools}>
              {profile.ready && profile.profile?.status === "saved" && <span>已启用{profile.profile.scope_kind === "user" ? "当前用户" : "本设备"}资料 · 版本 {profile.profile.profile_version}，本次明确要求优先</span>}
              <label htmlFor="supplement-field">选择一项补充</label>
              <select id="supplement-field" value={supplementField ?? ""} onChange={event => { stickToBottomRef.current = true; setSupplementField((event.target.value || null) as ProfileField | null); }}>
                <option value="">也可以直接打字告诉顾问</option><option value="top">上衣尺码</option><option value="bottom">下装尺码</option><option value="shoes">鞋码</option><option value="budget_fen">本次预算</option>
              </select>
            </div>}

            {fixed.health?.enabled && <details className={styles.coverage}><summary>当前固定搭配覆盖与服务状态</summary><p>正式固定目录：M1V2六款商品、四套搭配图；上衣M、裤子M、鞋38，整套最低¥737。首页P系列是独立灵感目录，暂不支持直接用P编号生成固定搭配。</p><p>{fixed.health.ready ? "固定搭配服务可用。" : "当前生成服务不可用；已保存的版本仍可查看。"} 已使用模型HTTP {fixed.health.model_http_attempts}/{fixed.health.model_http_attempt_limit} 次。</p><button type="button" disabled={generating || restoring} onClick={() => { events.emit({ event_name: "draft_prefill", source_slot: "fixed_coverage_example" }); prefill("预算800元，平时上衣M、裤子M、鞋38，通勤，请给我一套完整搭配"); }}>填入可改写的800元示例</button></details>}
            <div className="input-row">
              <textarea ref={textareaRef} id="brief" aria-label="说说你的穿搭需求" value={message} onChange={(e) => {
                const text = e.target.value;
                if (ownedProfileLine.current && !text.split("\n").includes(ownedProfileLine.current)) {
                  ownedProfileLine.current = null; setProfileDraft({ ...EMPTY_PROFILE_DRAFT });
                }
                setMessage(text);
              }} maxLength={4000} rows={discovery ? 1 : 2} placeholder={discovery ? "今天，你想怎么穿？" : "例如：通勤，预算800元，上衣M、裤子M、鞋38"} disabled={generating} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={(e) => { if (e.key !== "Enter" || e.shiftKey) return; if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return; e.preventDefault(); send(); }} />
              <div className="input-actions">
                <button className="send-button" type="button" onClick={() => send()} disabled={!profile.ready || generating || restoring || fixed.loading || historyUnavailable || !message.trim()} aria-label="发送"><span className={styles.sendLabel}>{generating ? "生成中…" : "发送"}</span><ArrowRight size={21} strokeWidth={1.7} aria-hidden="true" /></button>
              </div>
            </div>
            <p className="preview-note">Enter 发送 · Shift+Enter 换行 · AI建议仅供参考</p>
          </div>
        </section>
      </main>
      <footer className="site-footer"><span>让衣服适合生活。</span><span>AI 合成仅供参考 · 模拟加购不产生订单</span><div className={styles.partnerLinks}>{publicLinks.map(link => <a key={link.id} href={link.href} target="_blank" rel="noopener noreferrer" aria-label={link.label}>{link.label}</a>)}<a href={appPath("/platform")} aria-label="鞋服 AI 协作平台">鞋服 AI 协作平台</a></div><button className={styles.footerNew} aria-label={discovery ? "新对话" : undefined} hidden={!discovery} disabled={restoring || generating || !!latestProcessing || !!pendingPhoto} onClick={() => void newConversation()}><Plus size={14} aria-hidden="true" />新对话</button></footer>

      <ProfilePanel key={panelRecoveryRevision} controller={profile} onCleared={clearChoices} open={profileOpen} onClose={closeProfile} draft={profileDraft} onApply={applyChoices} onClearLocal={clearChoices} initialEditing={panelRecovery} onEditingChange={setPanelEditing} />
      <PersonalPreviewPanel controller={personalPreview} />

      <dialog ref={aboutRef} className="about-dialog" aria-labelledby="about-title" onClose={() => { setAboutOpen(false); aboutButtonRef.current?.focus(); }} onClick={(e) => { if (e.target === e.currentTarget) closeAbout(); }}>
        <div className="dialog-content"><button className="dialog-close" onClick={closeAbout} aria-label="关闭关于体验"><X size={20} aria-hidden="true" /></button><span className="eyebrow">ABOUT THIS EXPERIENCE</span><h2 id="about-title">从你的场景出发，给出搭配理由。</h2><p>这是一个穿搭对话助手。描述你的场景、体型、偏好与预算，助手会结合穿搭知识给出文字方案，并支持继续调整。</p><p>保留旧版照片 AI 效果图功能，仅供参考，不代表真实试穿或尺码效果；首页单品为已有自主 AI 合成示例，风格意向图并非本次推荐结果。</p><p>对话和生成结果保存在服务端。当前浏览器会记住历史入口，关闭后可重新打开；清除浏览器数据或更换设备后，这份入口列表不会自动同步。</p><button className="outline-button" onClick={closeAbout}>继续体验 <ArrowRight size={16} aria-hidden="true" /></button></div>
      </dialog>
    </div></ConsumerEventsProvider>
  );
}
