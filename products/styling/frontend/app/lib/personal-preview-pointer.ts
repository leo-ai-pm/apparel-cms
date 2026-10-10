// Only opaque recovery references. No photo, body, digest, token, private URL or current profile values.
export type PersonalPreviewPointer = { version: 1; requestId: string; taskId: string | null; sessionId: string; lookVersionId: string };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const key = (identityKey: string) => `styling.personal-preview-pointer.v1:${process.env.NEXT_PUBLIC_BASE_PATH || "/"}:${identityKey}`;
export function isPreviewPointer(value: unknown): value is PersonalPreviewPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "lookVersionId,requestId,sessionId,taskId,version" && row.version === 1
    && [row.requestId, row.sessionId, row.lookVersionId].every(id => typeof id === "string" && ID.test(id))
    && (row.taskId === null || typeof row.taskId === "string" && ID.test(row.taskId));
}
export function readPreviewPointer(identityKey: string): PersonalPreviewPointer | null {
  if (!identityKey) return null;
  try { const pointer: unknown = JSON.parse(sessionStorage.getItem(key(identityKey)) || "null"); return isPreviewPointer(pointer) ? pointer : null; }
  catch { return null; }
}
export function discardOtherPreviewPointers(identityKey: string): void {
  if (!identityKey) return;
  try {
    const prefix = `styling.personal-preview-pointer.v1:${process.env.NEXT_PUBLIC_BASE_PATH || "/"}:`;
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const name = sessionStorage.key(index);
      if (name?.startsWith(prefix) && name !== key(identityKey)) sessionStorage.removeItem(name);
    }
  } catch { /* Storage denial is handled before any new submission. */ }
}
export function writePreviewPointer(identityKey: string, pointer: PersonalPreviewPointer | null): boolean {
  if (!identityKey || pointer !== null && !isPreviewPointer(pointer)) return false;
  try {
    if (pointer) sessionStorage.setItem(key(identityKey), JSON.stringify(pointer)); else sessionStorage.removeItem(key(identityKey));
    return true;
  } catch { return false; }
}
