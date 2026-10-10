import type { RequestConditions, UsualSizes, ClothingProfileSize, ShoeProfileSize } from "./consumer-profile";
import type { ProfileDraft, ProfileField } from "./profile-draft";
import type { ProfileContext } from "./api";

/** Only explicit current selections. Saved defaults and provenance are resolved by the server. */
export function profileRequestConditions(draft: ProfileDraft): RequestConditions {
  const sizes: UsualSizes = {};
  for (const slot of ["top", "bottom"] as const) {
    if (draft[slot] !== null) sizes[slot] = { system: "clothing_alpha", value: draft[slot] as ClothingProfileSize["value"] };
  }
  if (draft.shoes !== null) sizes.shoes = { system: "cn_shoe", value: String(draft.shoes) as ShoeProfileSize["value"] };
  return {
    ...(draft.budget_fen === null ? {} : { budget_max_fen: draft.budget_fen }),
    ...(Object.keys(sizes).length ? { request_profile_overrides: { usual_sizes: sizes } } : {}),
  };
}

/** Never infer missing sizes from body measurements or assistant prose. */
export function nextProfileField(context?: ProfileContext): ProfileField | null {
  const next = context?.clarification?.next_field;
  if (!next || !context?.missing_fields.includes(next)) return null;
  return ({ "usual_sizes.top": "top", "usual_sizes.bottom": "bottom", "usual_sizes.shoes": "shoes", budget_max_fen: "budget_fen" } as Record<string, ProfileField>)[next] ?? null;
}

export const profileRequestNeedsConfirmation = (code: string) => [
  "PROFILE_CLEARED", "PROFILE_SNAPSHOT_INVALIDATED", "PROFILE_SNAPSHOT_EXPIRED", "PROFILE_INVALID_REQUEST", "PROFILE_INVALID_SCENE", "PROFILE_PREPARATION_CHANGED",
].includes(code);
