type Signal = { signal_id: string; scene?: string; feedback_type?: string; preference?: string; change_reason?: string };

// New managed workflows build only v2 packages from frozen, approved version groups.
export { makeApprovedPackage } from "./partner-protocol";

/** Legacy-only constructor retained for historical callers and fixtures. */
export function buildApprovedPackage(signal: Signal, draft: string, previousVersion?: string | null) {
  const count = { intent: 0, simulated_cart: 0, real_purchase: 0 };
  if (signal.feedback_type && signal.feedback_type in count) count[signal.feedback_type as keyof typeof count] = 1;
  const next = previousVersion && /^v\d+$/.test(previousVersion) ? Number(previousVersion.slice(1)) + 1 : 1;
  const package_id = `PKG-WB-${signal.signal_id}`;
  const version = `v${next}`;
  return {
    package_id, source_agent: "product" as const, signal_ids: [signal.signal_id],
    source: "穿搭型号 · 知需产品工作台",
    dedup_key: `${signal.scene || "未分类"}:${signal.feedback_type || "未分类"}`,
    dedup_rule: "按经人工核验的单条信号建包；不推断群体需求",
    sample_count: count,
    attribution: { supply_gap: signal.feedback_type === "out_of_stock", image_gap: signal.feedback_type === "missing_image", style_demand: !["out_of_stock", "missing_image"].includes(signal.feedback_type || "") },
    constraints: [signal.preference ? `用户偏好（待核实）：${signal.preference}` : "", signal.change_reason ? `更换原因（待核实）：${signal.change_reason}` : ""].filter(Boolean),
    requirement_desc: draft,
    version, status: "approved" as const,
  };
}
