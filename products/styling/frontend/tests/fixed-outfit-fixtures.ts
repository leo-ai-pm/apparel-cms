// Controlled protocol fixture. It is not a model result or a claim of real demand.
export const binding = {
  catalog_version: "test-catalog", inventory_snapshot_id: "test-inventory", look_asset_version: "test-assets",
  rule_set_version: "test-rules", attribute_vocabulary_version: "test-vocab",
};
export function outfit() {
  const slots = ["top", "bottom", "shoes"] as const;
  const skus = ["M1-T-M", "M1-B-M", "M1-S-38"];
  return {
    contract_version: "0.1.0", session_id: "fixed-session", look_id: "M1-LOOK-1", look_version_id: "lv-1", version_no: 1,
    parent_look_version_id: null, restored_from_look_version_id: null,
    items: Object.fromEntries(slots.map((slot, index) => [slot, {
      sku_id: skus[index], product_id: `M1-product-${slot}`, name: `模拟${slot}`, slot,
      size: { system: slot === "shoes" ? "cn_shoe" : "clothing_alpha", value: slot === "shoes" ? "38" : "M" },
      price_fen: [24900, 27900, 26900][index], is_simulated: true,
    }])),
    sku_ids: skus, item_prices_fen: Object.fromEntries(skus.map((id, index) => [id, [24900, 27900, 26900][index]])), total_price_fen: 79700,
    image_url: "/api/v1/outfits/assets/M1-LOOK-1", image_sha256: "a".repeat(64), look_asset_version: "test-assets",
    model_asset_version: "test-model", model_identity_id: "test-identity", pose_id: "test-pose", background_id: "test-background",
    view: "front_full_body", resources: { ...binding }, origin: { origin_type: "ai_generated", rights_confirmed: true },
    rights_confirmed: true, acceptance_status: "accepted_by_user", is_simulated: true,
    image_kind: "fixed_model_complete_outfit", disclaimer: "AI搭配示意图，不代表用户本人实际试穿或尺码效果",
    created_at: "2025-01-01T01:00:00Z",
    inventory_snapshot: { recorded: true, inventory_snapshot_id: "test-inventory", captured_at: "2025-01-01T00:00:00Z", valid_until: "2025-01-01T12:00:00Z", sha256: "b".repeat(64), is_simulated: true },
  };
}
export function session() {
  return {
    contract_version: "0.1.0", session_id: "fixed-session", is_simulated: true,
    state: { session_id: "fixed-session", state_revision: 1, current_look_version_id: "lv-1", look_version_ids: ["lv-1"] },
    history: [outfit()], messages: [{ role: "assistant", content: "本夹具仅测试协议" }], cart: [], cart_items: [], events: [], conversation_revision: 2,
  };
}
export function result() {
  return { ...session(), outcome: "action_completed", outfit: null, decision: { status: "action_completed", request_id: "test-action" }, response: { text: "模拟操作已完成" } };
}
