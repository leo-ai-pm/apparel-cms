import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCompleteOutfit, parseFixedActionResult, parseFixedOutfit, parseFixedSession } from "../app/lib/fixed-outfits";
import { fetchVerifiedProductImage, getFrozenProductImage, parseProductImageUseRef, PRODUCT_IMAGE_DISCLAIMER, type ProductImageUseRef } from "../app/lib/product-images";
import { outfit, result, session } from "./fixed-outfit-fixtures";

const slots = ["top", "bottom", "shoes"] as const;
const expected = { tenant_id: "tenant-demo", catalog_version: "test-catalog", product_id: "M1-product-top", sku_id: "M1-T-M" };
function reference(slot: typeof slots[number] = "top"): ProductImageUseRef {
  const item = outfit().items[slot];
  return {
    asset_id: `PIMG-${slot}-v1`, asset_version: 1, tenant_id: expected.tenant_id, catalog_version: expected.catalog_version,
    product_id: item.product_id, sku_id: item.sku_id, sku_ids: [item.sku_id], kind: "product_single_image", representation: "style_color_reference",
    image_url: `/api/v1/outfits/product-assets/PIMG-${slot}-v1`, image_sha256: "c".repeat(64), mime_type: "image/jpeg", width: 1024, height: 1024, byte_size: 108972,
    state: "agent_checked_preview", user_review: "pending", origin: { origin_type: "ai_generated", source_name: "Controlled test", source_ref: "test-source", is_simulated: true, rights_confirmed: true },
    registration: { registered_at: "2026-10-10T01:00:00+08:00" }, is_simulated: true, disclaimer: PRODUCT_IMAGE_DISCLAIMER,
  };
}
function frozen() {
  const value = outfit();
  const refs = { top: reference("top"), bottom: reference("bottom"), shoes: reference("shoes") };
  return { ...value, tenant_id: expected.tenant_id,
    items: Object.fromEntries(slots.map(slot => [slot, { ...value.items[slot], image_use_ref: structuredClone(refs[slot]), image_url: refs[slot].image_url }])),
    product_image_display: { recorded: true, status: "recorded", look_version_id: value.look_version_id, image_refs: refs, is_simulated: true },
  };
}

describe("registered single-product references", () => {
  it("requires the exact product/SKU/tenant/catalog while retaining preview and pending review", () => {
    expect(parseProductImageUseRef(reference(), expected)).toEqual(reference());
    for (const field of ["product_id", "sku_id", "tenant_id", "catalog_version"] as const) {
      expect(parseProductImageUseRef(reference(), { ...expected, [field]: "other" })).toBeNull();
    }
  });
  it.each([
    ["SKU set", { sku_ids: ["M1-T-S"] }], ["extended SKU coverage", { sku_ids: ["M1-T-M", "M1-T-S"] }],
    ["wrong asset path", { image_url: "/api/v1/outfits/product-assets/other" }], ["complete-look fallback", { image_url: "/api/v1/outfits/assets/M1-LOOK-1" }],
    ["external image", { image_url: "https://example.com/product.jpg" }], ["path traversal", { asset_id: "../private" }],
    ["query string", { image_url: "/api/v1/outfits/product-assets/PIMG-top-v1?latest=1" }], ["uppercase digest", { image_sha256: "C".repeat(64) }],
    ["invalid digest", { image_sha256: "bad" }], ["SVG", { mime_type: "image/svg+xml" }],
    ["oversized pixels", { width: 1025 }], ["noninteger pixels", { height: 1.5 }], ["zero pixels", { width: 0 }],
    ["oversized bytes", { byte_size: 1048577 }], ["zero bytes", { byte_size: 0 }], ["noninteger version", { asset_version: 1.5 }],
    ["unchecked state", { state: "pending_check" }], ["unconfirmed acceptance", { user_review: "accepted_by_user" }],
    ["not simulated", { is_simulated: false }], ["incorrect kind", { kind: "fixed_model_complete_outfit" }],
    ["fit claim", { representation: "actual_fit" }], ["missing disclaimer", { disclaimer: "" }],
    ["missing rights", { origin: { ...reference().origin, rights_confirmed: false } }],
    ["real origin", { origin: { ...reference().origin, is_simulated: false } }],
    ["missing source", { origin: { ...reference().origin, source_ref: "" } }],
    ["unsupported origin", { origin: { ...reference().origin, origin_type: "scraped" } }],
    ["registration without timezone", { registration: { registered_at: "2026-10-10T01:00:00" } }],
    ["extra private field", { operation_token: "must-not-propagate" }],
  ])("refuses %s without inventing another image", (_name, patch) => {
    expect(parseProductImageUseRef({ ...reference(), ...patch }, expected)).toBeNull();
  });
});

describe("frozen product image sidecars", () => {
  it("keeps a legacy contract unchanged and never requests the current catalog", () => {
    const value = outfit(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const parsed = parseFixedOutfit(value);
    expect(parsed).toEqual(value); expect(parsed.product_image_display).toBeUndefined();
    expect(getFrozenProductImage(parsed, "top")).toMatchObject({ status: "history_unrecorded", ref: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses each version's own exact references without mutating its source or complete picture", () => {
    const value = frozen(); const original = structuredClone(value); const parsed = parseFixedOutfit(value);
    expect(value).toEqual(original); expect(parsed.image_url).toBe(value.image_url); expect(parsed.image_sha256).toBe(value.image_sha256);
    for (const slot of slots) expect(getFrozenProductImage(parsed, slot)).toMatchObject({ status: "available", ref: reference(slot) });
    expect(parsed.contract_version).toBe("0.1.0"); expect(parsed.total_price_fen).toBe(79700);
  });
  it.each(["item SKU", "item URL", "sidecar SKU", "sidecar SHA", "malformed item URL"])("isolates %s failure to one slot and keeps the full look valid", mismatch => {
    const value = frozen();
    if (mismatch === "item SKU") value.items.top.image_use_ref.sku_id = "M1-T-S";
    if (mismatch === "item URL") value.items.top.image_url = "/product-images/P001.png";
    if (mismatch === "sidecar SKU") value.product_image_display.image_refs.top.sku_id = "M1-T-S";
    if (mismatch === "sidecar SHA") value.product_image_display.image_refs.top.image_sha256 = "d".repeat(64);
    if (mismatch === "malformed item URL") Object.assign(value.items.top, { image_url: { bad: true } });
    const parsed = parseFixedOutfit(value);
    expect(isCompleteOutfit(parsed)).toBe(true); expect(parsed.image_url).toBe(value.image_url);
    expect(getFrozenProductImage(parsed, "top")).toMatchObject({ status: "unavailable", ref: null });
    expect(parsed.items.top.image_url).toBeNull();
    expect(getFrozenProductImage(parsed, "bottom").status).toBe("available"); expect(getFrozenProductImage(parsed, "shoes").status).toBe("available");
  });
  it("ignores current-looking refs on unrecorded history and malformed display envelopes", () => {
    const value = frozen(); value.product_image_display.recorded = false; value.product_image_display.status = "history_unrecorded";
    const parsed = parseFixedOutfit(value);
    for (const slot of slots) expect(getFrozenProductImage(parsed, slot)).toMatchObject({ status: "history_unrecorded", ref: null });
    const wrongVersion = frozen(); wrongVersion.product_image_display.look_version_id = "lv-2";
    const rejected = parseFixedOutfit(wrongVersion);
    expect(rejected.image_url).toBe(wrongVersion.image_url);
    for (const slot of slots) expect(getFrozenProductImage(rejected, slot).status).toBe("unavailable");
  });
  it("distinguishes never-registered slots from unavailable registered files", () => {
    const value = frozen(); Object.assign(value.items.top, { image_use_ref: null, image_url: null });
    Object.assign(value.product_image_display.image_refs, { top: null });
    expect(getFrozenProductImage(parseFixedOutfit(value), "top").status).toBe("not_recorded");
    value.product_image_display.status = "unavailable";
    expect(getFrozenProductImage(parseFixedOutfit(value), "top").status).toBe("unavailable");
    expect(getFrozenProductImage(parseFixedOutfit(value), "bottom").status).toBe("available");
  });
  it("isolates lv-1 loading state by session and tenant, not by version alone", () => {
    const a = parseFixedOutfit(frozen()); const b = parseFixedOutfit({ ...frozen(), session_id: "another-session" });
    expect(getFrozenProductImage(a, "top").key).not.toBe(getFrozenProductImage(b, "top").key);
    const foreign = frozen(); foreign.tenant_id = "another-tenant";
    expect(getFrozenProductImage(parseFixedOutfit(foreign), "top").ref).toBeNull();
  });
  it("session, action and direct outfit parsing apply the same per-slot downgrade", () => {
    const value = frozen(); value.items.top.image_use_ref.product_id = "wrong-product";
    const parsedSession = parseFixedSession({ ...session(), history: [value] });
    const parsedAction = parseFixedActionResult({ ...result(), history: [value], outcome: "complete_outfit", outfit: value });
    expect(parsedSession.history[0].items.top.image_use_ref).toBeNull();
    expect(parsedAction.outfit?.items.top.image_use_ref).toBeNull(); expect(parsedAction.outcome).toBe("complete_outfit");
  });
});

describe("verified product image transport", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const ref = () => ({ ...reference(), byte_size: bytes.length, image_sha256: digest });
  const response = (body = bytes, headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "image/jpeg", "x-content-sha256": digest, ...headers } });
  let decode: ReturnType<typeof vi.fn>;
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); decode = vi.fn().mockResolvedValue({ width: 1024, height: 1024, close: vi.fn() }); vi.stubGlobal("createImageBitmap", decode); });
  it("verifies bytes/header/decode before returning a blob, forwards abort and does not cache", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response())); vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController(); const blob = await fetchVerifiedProductImage(ref(), { signal: controller.signal });
    expect(blob.size).toBe(bytes.length); expect(blob.type).toBe("image/jpeg");
    expect(fetcher).toHaveBeenCalledWith(ref().image_url, expect.objectContaining({ cache: "no-store", redirect: "error", credentials: "same-origin", signal: controller.signal }));
    expect(decode).toHaveBeenCalledWith(blob); expect((await decode.mock.results[0].value).close).toHaveBeenCalledOnce();
    await fetchVerifiedProductImage(ref()); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["404", "redirect", "mime", "header", "length", "digest", "decode", "dimensions"])("rejects %s instead of displaying substituted bytes", async failure => {
    let res = response();
    if (failure === "404") res = new Response("missing", { status: 404 });
    if (failure === "redirect") Object.defineProperty(res, "redirected", { value: true });
    if (failure === "mime") res = response(bytes, { "content-type": "image/png" });
    if (failure === "header") res = response(bytes, { "x-content-sha256": "f".repeat(64) });
    if (failure === "length") res = response(new Uint8Array([1, 2]));
    if (failure === "digest") res = response(new Uint8Array([5, 6, 7, 8]));
    if (failure === "decode") decode.mockRejectedValue(new Error("decode failed"));
    if (failure === "dimensions") decode.mockResolvedValue({ width: 512, height: 1024, close: vi.fn() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    await expect(fetchVerifiedProductImage(ref())).rejects.toMatchObject({ name: "ProductImageError" });
  });
  it("does not fetch an invalid URL even if a caller casts it as a reference", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchVerifiedProductImage({ ...ref(), image_url: "https://example.com/image" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

afterEach(() => { vi.unstubAllGlobals(); });
