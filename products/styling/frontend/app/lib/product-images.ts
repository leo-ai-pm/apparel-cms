import { appPath } from "./app-path";
import type { FixedOutfit, FixedSlot } from "./fixed-outfits";

export const PRODUCT_IMAGE_DISCLAIMER = "AI生成单品参考图·演示预览·待用户视觉确认";
export interface ProductImageUseRef {
  asset_id: string;
  asset_version: number;
  tenant_id: string;
  catalog_version: string;
  product_id: string;
  sku_ids: string[];
  sku_id: string;
  kind: "product_single_image";
  representation: "style_color_reference";
  image_url: string;
  image_sha256: string;
  mime_type: "image/jpeg" | "image/png";
  width: number;
  height: number;
  byte_size: number;
  state: "agent_checked_preview";
  user_review: "pending";
  origin: { origin_type: "ai_generated" | "self_created" | "open_license" | "authorized"; source_name: string; source_ref: string; is_simulated: true; rights_confirmed: true };
  is_simulated: true;
  disclaimer: typeof PRODUCT_IMAGE_DISCLAIMER;
  registration: { registered_at: string };
}
export interface ProductImageDisplay {
  recorded: boolean;
  status: "recorded" | "history_unrecorded" | "unavailable";
  look_version_id: string;
  image_refs: Record<FixedSlot, ProductImageUseRef | null>;
  is_simulated: true;
}
export type ProductImageExpected = { product_id: string; sku_id: string; tenant_id: string; catalog_version: string };
export type FrozenProductImage = { status: "available" | "history_unrecorded" | "unavailable" | "not_recorded"; ref: ProductImageUseRef | null; key: string };

const slots = ["top", "bottom", "shoes"] as const;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 2000;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(v);
const count = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max;
const keys = (v: Record<string, unknown>, expected: readonly string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const refKeys = ["asset_id", "asset_version", "tenant_id", "catalog_version", "product_id", "sku_ids", "sku_id", "kind", "representation", "image_url", "image_sha256", "mime_type", "width", "height", "byte_size", "state", "user_review", "origin", "is_simulated", "disclaimer", "registration"];

/** This validates a server-provided mapping, never supplies a current-catalog fallback. */
export function parseProductImageUseRef(value: unknown, expected: ProductImageExpected): ProductImageUseRef | null {
  if (!object(value) || !keys(value, refKeys) || !id(value.asset_id) || !count(value.asset_version, Number.MAX_SAFE_INTEGER)
    || !id(expected.product_id) || !id(expected.sku_id) || !id(expected.tenant_id) || !id(expected.catalog_version)
    || value.product_id !== expected.product_id || value.sku_id !== expected.sku_id || value.tenant_id !== expected.tenant_id || value.catalog_version !== expected.catalog_version
    || !Array.isArray(value.sku_ids) || value.sku_ids.length !== 1 || value.sku_ids[0] !== expected.sku_id
    || value.kind !== "product_single_image" || value.representation !== "style_color_reference"
    || value.image_url !== `/api/v1/outfits/product-assets/${value.asset_id}`
    || typeof value.image_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.image_sha256)
    || !["image/jpeg", "image/png"].includes(String(value.mime_type))
    || !count(value.width, 1024) || !count(value.height, 1024) || !count(value.byte_size, 1024 * 1024)
    || value.state !== "agent_checked_preview" || value.user_review !== "pending" || value.is_simulated !== true
    || value.disclaimer !== PRODUCT_IMAGE_DISCLAIMER || !object(value.origin)
    || !keys(value.origin, ["origin_type", "source_name", "source_ref", "is_simulated", "rights_confirmed"])
    || !["ai_generated", "self_created", "open_license", "authorized"].includes(String(value.origin.origin_type))
    || !text(value.origin.source_name) || !text(value.origin.source_ref) || value.origin.is_simulated !== true || value.origin.rights_confirmed !== true
    || !object(value.registration) || !keys(value.registration, ["registered_at"])
    || typeof value.registration.registered_at !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.registration.registered_at)
    || !Number.isFinite(Date.parse(value.registration.registered_at))) return null;
  // Rebuild in stable order, allowing exact semantic comparison regardless of JSON key order.
  return {
    asset_id: value.asset_id, asset_version: value.asset_version, tenant_id: expected.tenant_id, catalog_version: expected.catalog_version,
    product_id: expected.product_id, sku_ids: [expected.sku_id], sku_id: expected.sku_id,
    kind: "product_single_image", representation: "style_color_reference", image_url: value.image_url as string,
    image_sha256: value.image_sha256, mime_type: value.mime_type as ProductImageUseRef["mime_type"], width: value.width, height: value.height, byte_size: value.byte_size,
    state: "agent_checked_preview", user_review: "pending",
    origin: { origin_type: value.origin.origin_type as ProductImageUseRef["origin"]["origin_type"], source_name: value.origin.source_name, source_ref: value.origin.source_ref, is_simulated: true, rights_confirmed: true },
    is_simulated: true, disclaimer: PRODUCT_IMAGE_DISCLAIMER, registration: { registered_at: value.registration.registered_at },
  };
}

/** Optional single-image failures must not invalidate the independently frozen complete look. */
export function normalizeProductImageFields(outfit: FixedOutfit): FixedOutfit {
  const raw: unknown = outfit.product_image_display;
  if (raw === undefined && slots.every(slot => outfit.items[slot].image_use_ref === undefined && outfit.items[slot].image_url === undefined)) return outfit;
  const display: ProductImageDisplay = { recorded: false, status: raw === undefined ? "history_unrecorded" : "unavailable", look_version_id: outfit.look_version_id, image_refs: { top: null, bottom: null, shoes: null }, is_simulated: true };
  const validEnvelope = object(raw) && keys(raw, ["recorded", "status", "look_version_id", "image_refs", "is_simulated"])
    && raw.look_version_id === outfit.look_version_id && raw.is_simulated === true && object(raw.image_refs) && keys(raw.image_refs, slots);
  if (validEnvelope && object(raw)) {
    if (raw.recorded === false && raw.status === "history_unrecorded") display.status = "history_unrecorded";
    else if (raw.recorded === true && (raw.status === "recorded" || raw.status === "unavailable")) {
      display.recorded = true; display.status = raw.status;
      for (const slot of slots) {
        const item = outfit.items[slot];
        const source = (raw.image_refs as Record<string, unknown>)[slot];
        if (source === null && item.image_use_ref == null && item.image_url == null) continue;
        const expected = { product_id: item.product_id, sku_id: item.sku_id, tenant_id: outfit.tenant_id ?? "", catalog_version: outfit.resources.catalog_version };
        const ref = parseProductImageUseRef(source, expected);
        const itemRef = parseProductImageUseRef(item.image_use_ref, expected);
        if (ref && itemRef && item.image_url === ref.image_url && JSON.stringify(ref) === JSON.stringify(itemRef)) display.image_refs[slot] = ref;
        else display.status = "unavailable";
      }
    }
  }
  return { ...outfit, product_image_display: display, items: {
    top: { ...outfit.items.top, image_use_ref: display.image_refs.top, image_url: display.image_refs.top?.image_url ?? null },
    bottom: { ...outfit.items.bottom, image_use_ref: display.image_refs.bottom, image_url: display.image_refs.bottom?.image_url ?? null },
    shoes: { ...outfit.items.shoes, image_use_ref: display.image_refs.shoes, image_url: display.image_refs.shoes?.image_url ?? null },
  } };
}

export function getFrozenProductImage(outfit: FixedOutfit, slot: FixedSlot): FrozenProductImage {
  const display = normalizeProductImageFields(outfit).product_image_display;
  const ref = display?.image_refs[slot] ?? null;
  const status = ref ? "available" : !display || display.status === "history_unrecorded" ? "history_unrecorded" : display.status === "unavailable" ? "unavailable" : "not_recorded";
  // lv-1 is local to a session; loaded/error state cannot be shared using that ID alone.
  const key = JSON.stringify([outfit.tenant_id ?? null, outfit.session_id, outfit.look_version_id, slot, ref?.asset_id ?? null, ref?.asset_version ?? null, ref?.image_sha256 ?? null, status]);
  return { status, ref, key };
}

export class ProductImageError extends Error {
  constructor(public code: "UNAVAILABLE" | "MIME" | "DIGEST" | "SIZE" | "DECODE") { super("单品参考图暂不可用，完整搭配与商品资料已保留。"); this.name = "ProductImageError"; }
}

/** Fetch only the immutable registered path. No cache and no alternate-image fallback. */
export async function fetchVerifiedProductImage(ref: ProductImageUseRef, options: { signal?: AbortSignal } = {}): Promise<Blob> {
  if (!parseProductImageUseRef(ref, ref)) throw new ProductImageError("UNAVAILABLE");
  const response = await fetch(appPath(ref.image_url), { credentials: "same-origin", cache: "no-store", redirect: "error", signal: options.signal });
  if (!response.ok || response.redirected) throw new ProductImageError("UNAVAILABLE");
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== ref.mime_type) throw new ProductImageError("MIME");
  if (response.headers.get("x-content-sha256") !== ref.image_sha256) throw new ProductImageError("DIGEST");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== ref.byte_size) throw new ProductImageError("SIZE");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
  if (digest !== ref.image_sha256) throw new ProductImageError("DIGEST");
  const blob = new Blob([bytes], { type: ref.mime_type });
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { throw new ProductImageError("DECODE"); }
  const dimensionsMatch = bitmap.width === ref.width && bitmap.height === ref.height;
  bitmap.close();
  if (!dimensionsMatch) throw new ProductImageError("SIZE");
  return blob;
}
