import type { EvidenceRecord } from "@/features/workspace/types";

export const draft: EvidenceRecord = {
  id: 1, package_id: null, version: "v1", status: "draft",
  signal_ids: ["SIG-TEST-1", "SIG-TEST-2"],
  sample_count: { intent: 1, simulated_cart: 0, real_purchase: 0 },
  attribution: { supply_gap: true, image_gap: false, style_demand: false },
  dedup_key: "通勤-下装-缺货", dedup_rule: "同场景+同品类+同缺口类型合并",
  source: "测试信号", constraints: ["秋装"], requirement_desc: "",
  priority: "P3", priority_basis: "当前只有意向信号，继续观察",
  created_at: "2026-09-26T10:00:00", published_at: null,
};
