import { isProfileAuthorizationContext, PROFILE_LIMITS, type SavedConsumerProfile } from "./consumer-profile";
import { EMPTY_PROFILE_DRAFT, type ProfileDraft } from "./profile-draft";

export interface ProfileEditOwner { scope_kind: "device" | "user"; context_id: string }
export interface ProfilePanelEditing { editing: ProfileDraft; touched: (keyof ProfileDraft)[] }
export interface ProfileEditBackup {
  profileVersion: number;
  message: string;
  profileDraft: ProfileDraft;
  ownedProfileLine: string | null;
  panel: ProfilePanelEditing | null;
}
export interface OwnedProfileEditBackup extends ProfileEditBackup { owner: ProfileEditOwner }
const fields = Object.keys(EMPTY_PROFILE_DRAFT) as (keyof ProfileDraft)[];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
const ownerValid = (value: unknown): value is ProfileEditOwner => record(value) && exact(value, ["scope_kind", "context_id"])
  && (value.scope_kind === "device" || value.scope_kind === "user") && typeof value.context_id === "string" && value.context_id.length > 0 && !/\s/.test(value.context_id);
export function profileEditOwner(profile: SavedConsumerProfile | null): ProfileEditOwner | null {
  return profile && isProfileAuthorizationContext(profile.authorization_context)
    ? { scope_kind: profile.scope_kind, context_id: profile.authorization_context.context_id } : null;
}
export function sameProfileEditOwner(a: ProfileEditOwner | null, b: ProfileEditOwner | null): boolean {
  return !!a && !!b && a.scope_kind === b.scope_kind && a.context_id === b.context_id;
}
function draftValid(value: unknown): value is ProfileDraft {
  if (!record(value) || !exact(value, fields)) return false;
  for (const field of ["height_cm", "weight_kg"] as const) {
    const n = value[field], range = PROFILE_LIMITS[field];
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < range.min || n > range.max || !Number.isInteger(n * 2))) return false;
  }
  return ["top", "bottom"].every(field => value[field] === null || ["S", "M", "L", "XL"].includes(String(value[field])))
    && (value.shoes === null || [35, 36, 37, 38, 39, 40].includes(value.shoes as number))
    && (value.budget_fen === null || typeof value.budget_fen === "number" && Number.isSafeInteger(value.budget_fen) && value.budget_fen >= PROFILE_LIMITS.budget_fen.min && value.budget_fen <= PROFILE_LIMITS.budget_fen.max);
}
function backupValid(value: unknown): value is OwnedProfileEditBackup {
  if (!record(value) || !exact(value, ["owner", "profileVersion", "message", "profileDraft", "ownedProfileLine", "panel"]) || !ownerValid(value.owner)
    || typeof value.profileVersion !== "number" || !Number.isSafeInteger(value.profileVersion) || value.profileVersion < 0
    || typeof value.message !== "string" || value.message.length > 20000 || !draftValid(value.profileDraft)
    || !(value.ownedProfileLine === null || typeof value.ownedProfileLine === "string" && value.message.split("\n").includes(value.ownedProfileLine))) return false;
  return value.panel === null || record(value.panel) && exact(value.panel, ["editing", "touched"]) && draftValid(value.panel.editing)
    && Array.isArray(value.panel.touched) && value.panel.touched.length > 0 && value.panel.touched.every(field => fields.includes(field as keyof ProfileDraft))
    && new Set(value.panel.touched).size === value.panel.touched.length;
}
function key(owner: ProfileEditOwner) {
  return `styling.unsaved-profile-edit.v1:${process.env.NEXT_PUBLIC_BASE_PATH || "/"}:${owner.scope_kind}:${encodeURIComponent(owner.context_id)}`;
}
export function readProfileEditBackup(owner: ProfileEditOwner | null): OwnedProfileEditBackup | null {
  if (!owner || !ownerValid(owner)) return null;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key(owner)) || "null");
    return backupValid(value) && sameProfileEditOwner(value.owner, owner) ? value : null;
  } catch { return null; }
}
/** Private, unsubmitted edits only. Never a saved profile, operation body or automatic restore. */
export function writeProfileEditBackup(owner: ProfileEditOwner | null, draft: ProfileEditBackup): boolean {
  if (!owner || !ownerValid(owner)) return false;
  const value = { owner: { scope_kind: owner.scope_kind, context_id: owner.context_id }, profileVersion: draft.profileVersion, message: draft.message,
    profileDraft: { ...draft.profileDraft }, ownedProfileLine: draft.ownedProfileLine, panel: draft.panel ? {
      editing: Object.fromEntries(fields.map(field => [field, draft.panel!.touched.includes(field) ? draft.panel!.editing[field] : null])) as ProfileDraft,
      touched: [...draft.panel.touched],
    } : null };
  if (!backupValid(value)) return false;
  try {
    if (!value.message && !Object.values(value.profileDraft).some(field => field !== null) && !value.panel) sessionStorage.removeItem(key(owner));
    else sessionStorage.setItem(key(owner), JSON.stringify(value));
    return true;
  } catch { return false; }
}
export function removeProfileEditBackup(owner: ProfileEditOwner | null): boolean {
  if (!owner || !ownerValid(owner)) return false;
  try { sessionStorage.removeItem(key(owner)); return true; } catch { return false; }
}
