import type { FixedOutfit } from "./fixed-outfits";

// UI models only. These are not API DTOs and never authorize ownership or SKU input.
export type PersonalPreviewTarget = {
  sessionId: string; lookVersionId: string; versionNo: number | null; lookId: string | null; modelUrl: string | null;
  selectionDigest?: string;
  contentCleared?: boolean;
  items: { slot: string; skuId: string; name: string; referenceAssetId?: string; referenceVersion?: string }[];
};
export type PersonalPreviewStatus = "queued" | "running" | "provider_unknown" | "output_pending_review" | "succeeded" | "failed" | "expired";
export type PersonalPreviewTask = {
  id: string; requestId: string; status: PersonalPreviewStatus;
  deletion: "active" | "deleting" | "deleted";
  target: PersonalPreviewTarget; createdAt: string; expiresAt: string | null;
  selectionStatus?: "available" | "content_cleared"; modelImagePath?: string | null;
  detail: string; hasResult: boolean; mode: "mock" | "real";
};
export type PersonalPreviewAvailability = {
  available: boolean; reasons: string[]; mode: "mock" | "real" | "unavailable";
  purposeNote: string; retentionNote: string; costNote: string;
  selection?: PersonalPreviewTarget;
  // Adapter-owned opaque confirmation data; never reconstructed from profile/SKU state.
  permit: unknown;
};
export type PersonalPreviewSubmission = {
  requestId: string; target: PersonalPreviewTarget; photo: File; permit: unknown;
};
export interface PersonalPreviewService {
  availability(target: PersonalPreviewTarget, signal: AbortSignal): Promise<PersonalPreviewAvailability>;
  submit(request: PersonalPreviewSubmission, signal: AbortSignal): Promise<PersonalPreviewTask>;
  findRequest(requestId: string, signal: AbortSignal): Promise<PersonalPreviewTask | null>;
  task(id: string, signal: AbortSignal): Promise<PersonalPreviewTask>;
  history(signal: AbortSignal): Promise<PersonalPreviewTask[]>;
  image(task: PersonalPreviewTask, signal: AbortSignal): Promise<Blob>;
  modelImage?(task: PersonalPreviewTask, signal: AbortSignal): Promise<Blob>;
  remove(task: PersonalPreviewTask, actionId: string, signal: AbortSignal): Promise<PersonalPreviewTask>;
  retry?(requestId: string, signal: AbortSignal): Promise<PersonalPreviewTask>;
  canRetry?(requestId: string): boolean;
  releaseSensitive?(): void;
}
export type PersonalPreviewController = {
  open: boolean; target: PersonalPreviewTarget | null; targetChanged: boolean; identityReady: boolean;
  photo: { file: File; url: string } | null; photoError: string;
  availability: PersonalPreviewAvailability | null; availabilityLoading: boolean;
  submitting: boolean; error: string; uncertain: boolean; requestId: string | null;
  task: PersonalPreviewTask | null; tasks: PersonalPreviewTask[]; historyLoading: boolean; historyError: string;
  waiting: boolean; imageUrl: string | null; imageLoading: boolean; imageError: string;
  imageMode: "model" | "personal"; deletionPending: boolean;
  openPanel: () => void; closePanel: () => void; selectPhoto: (file: File) => void; removePhoto: () => void;
  useCurrentTarget: () => void; refreshAvailability: () => void; confirm: () => void;
  checkRequest: () => void; refreshTask: () => void; stopWaiting: () => void;
  refreshHistory: () => void; viewTask: (task: PersonalPreviewTask) => void;
  setImageMode: (mode: "model" | "personal") => void; reloadImage: () => void; deleteTask: () => void;
  canRetry?: boolean; retryRequest?: () => void;
  recoveryNotice?: string;
  modelImageUrl?: string | null; modelImageLoading?: boolean; modelImageError?: string; reloadModelImage?: () => void;
};
export class PersonalPreviewError extends Error {
  constructor(message: string, readonly identityInvalid = false, readonly definitive = false, readonly code?: string, readonly status?: number) { super(message); }
}
export const PERSONAL_PREVIEW_DISCLAIMER = "AI穿搭效果参考，服装细节可能有偏差，不代表实际合身或尺码效果。";
export const previewStatusLabels: Record<PersonalPreviewStatus, string> = {
  queued: "已受理，排队中", running: "正在生成", provider_unknown: "生成服务状态待确认",
  output_pending_review: "效果待核对", succeeded: "效果已完成", failed: "生成失败", expired: "效果已过期",
};
export function personalPreviewTarget(outfit: FixedOutfit | null): PersonalPreviewTarget | null {
  if (!outfit) return null;
  return { sessionId: outfit.session_id, lookVersionId: outfit.look_version_id, versionNo: outfit.version_no,
    lookId: outfit.look_id, modelUrl: outfit.image_url,
    items: (["top", "bottom", "shoes"] as const).map(slot => ({ slot, skuId: outfit.items[slot].sku_id, name: outfit.items[slot].name })) };
}
// Only standalone opt-in phrases open the local flow. Mixed styling requests stay with the agent.
export function isPersonalPreviewIntent(text: string): boolean {
  return /^(?:我想|请|帮我)?(?:看看我穿(?:这套|当前这套)的效果|用我的照片看(?:这套)?穿搭效果|上传(?:我的|本人)?照片看穿搭效果)[。！!？?\s]*$/.test(text.trim());
}
export const unavailablePreview: PersonalPreviewAvailability = {
  available: false, reasons: ["本人照片效果服务尚未接通，暂时不能上传或生成。可先在本机选择、预览照片。"],
  mode: "unavailable", purposeNote: "确认后仅用于这次所选搭配的AI效果处理。",
  retentionNote: "服务端保存期限与删除规则尚未就绪，当前照片只在此页面内存中。",
  costNote: "生成额度与费用尚未核定，目前不能提交。", permit: null,
};
const unavailable = async (): Promise<never> => { throw new PersonalPreviewError("本人照片效果接口尚未接通，请稍后重新读取。", false, true); };
// No network fallback to the old public tryon service.
export const unavailablePreviewService: PersonalPreviewService = {
  availability: async () => unavailablePreview, submit: unavailable, findRequest: unavailable,
  task: unavailable, history: unavailable, image: unavailable, remove: unavailable,
};
