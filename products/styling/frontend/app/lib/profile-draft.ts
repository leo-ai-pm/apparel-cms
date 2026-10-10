/** Unsaved, current-conversation choices. Never a server profile or snapshot. */
export type ProfileDraft = {
  height_cm: number | null;
  weight_kg: number | null;
  top: string | null;
  bottom: string | null;
  shoes: number | null;
  budget_fen: number | null;
};

export type ProfileField = "top" | "bottom" | "shoes" | "budget_fen";

export const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  height_cm: null, weight_kg: null, top: null, bottom: null, shoes: null, budget_fen: null,
};

const DRAFT_PREFIX = "【本次选择（未保存）】";

/** Visible, editable text only; does not submit a request, emit an event or persist. */
export function profileDraftLine(draft: ProfileDraft): string {
  const choices = [
    draft.height_cm !== null ? `身高${draft.height_cm}厘米` : "",
    draft.weight_kg !== null ? `体重${draft.weight_kg}公斤` : "",
    draft.top ? `上衣${draft.top}` : "",
    draft.bottom ? `裤子${draft.bottom}` : "",
    draft.shoes !== null ? `鞋${draft.shoes}码` : "",
    draft.budget_fen !== null ? `预算${draft.budget_fen / 100}元` : "",
  ].filter(Boolean);
  return choices.length ? `${DRAFT_PREFIX}${choices.join("，")}` : "";
}

export function applyProfileDraft(message: string, draft: ProfileDraft, ownedLine?: string | null): string {
  const original = removeProfileDraft(message, ownedLine);
  const line = profileDraftLine(draft);
  return line ? `${original}${original ? "\n" : ""}${line}` : original;
}

/** Only a still-unedited generated line belongs to the control. User edits are prose. */
export function removeProfileDraft(message: string, ownedLine?: string | null): string {
  if (!ownedLine) return message;
  const lines = message.split("\n");
  const index = lines.lastIndexOf(ownedLine);
  if (index < 0) return message;
  lines.splice(index, 1);
  return lines.join("\n");
}
