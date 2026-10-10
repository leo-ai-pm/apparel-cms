export type Attribution = { supply_gap: boolean; image_gap: boolean; style_demand: boolean };
export type SampleCount = { intent: number; simulated_cart: number; real_purchase: number };

export type EvidenceRecord = {
  id: number;
  package_id: string | null;
  version: string;
  status: string;
  signal_ids: string[];
  sample_count: SampleCount;
  attribution: Attribution;
  dedup_key: string;
  dedup_rule: string;
  source: string;
  constraints: string[];
  requirement_desc: string | null;
  priority: "P0" | "P1" | "P2" | "P3" | null;
  priority_basis: string | null;
  created_at: string;
  published_at: string | null;
};

export type DraftInput = { requirement_desc: string; constraints: string[]; style_demand: boolean; priority: "P0" | "P1" | "P2" | "P3"; priority_basis: string };
export type PullResult = { new_count: number; draft_id?: number };
export type PublishResult = { package: { package_id: string }; cms: { status: string } };
