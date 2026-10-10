import type { PersonContext } from "./auth";
export const REASONING_CONTRACT = "pa-product-reasoning/1.0.0";
export type FeedbackContext = { scene: string; variant: string; selected_size: string; listed_price_cny: number; currency: "CNY" };
export type FeedbackItem = { case_id: string; source_id: string; origin_event_id: string; product_id: string; context_id: string; context: FeedbackContext; raw_text: string; test_data: true; source_kind: "synthetic_test_feedback" };
export type FeedbackBatch = { schema_version: "pa-feedback-batch/1"; batch_id: string; input_revision: number; test_data: true; purpose: string; origin: string; source_identity_basis: string; items: FeedbackItem[] };
export type ReasonCode = "size_waist" | "fit_loose_preference" | "fit_slim_preference" | "budget_limit" | "unresolved";
export type EvidenceRef = { canonical_id: string; case_id: string; source_id: string; field: string; quote: string; occurrence_index: number };
export type CanonicalFeedback = FeedbackItem & { canonical_id: string; representative_case_id: string; member_case_ids: string[]; reason_codes: ReasonCode[]; positive_codes: string[]; negated_quotes: string[]; budget_limit_cny: number | null; duplicate_reason: string | null };
export type RoleCount = { canonical_feedback_count: number; unique_source_count: number };
export type ReasoningGroup = {
  group_id: string; reason_code: ReasonCode; title: string;
  scope: { product_id: string; variant: string; scene: string; selected_size: string | null; preference: "loose" | "slim" | null };
  support_refs: EvidenceRef[]; counterexample_refs: EvidenceRef[]; opposing_preference_refs: EvidenceRef[]; contextual_refs: EvidenceRef[];
  counts: { support: RoleCount; counterexample: RoleCount; opposing_preference: RoleCount; contextual: RoleCount };
  facts: { kind: string; text: string; evidence_refs: EvidenceRef[] }[];
  inferences: { kind: string; text: string; evidence_refs: EvidenceRef[] }[];
  unknowns: string[]; grouping_explanation: string;
  evidence_balance: { kind: "corroborated_self_report" | "mixed" | "opposing_preferences" | "single_source" | "insufficient"; reason: string };
  proposed_action: { stage: "verify_information" | "segmented_validation" | "clarify_first"; order_band: 1 | 2 | 3; action_kind: "size_information_check" | "budget_product_matching" | "preference_segment_validation" | "clarifying_question"; reason: string; evidence_refs: EvidenceRef[]; unknowns: string[]; change_conditions: string[]; alternative_considered: string; design_ready: false };
};
export type RuleMethod = { kind: "transparent_rules"; version: "pmr-rules/1"; rules_digest: string; rules: string[]; limitations: string[] };
export type ReasoningResult = { test_data: true; review_scope: "test_reasoning_only"; method: RuleMethod; counts: { raw_record_count: number; canonical_feedback_count: number; deduplicated_expression_count: number; unique_source_count: number; duplicate_record_count: number; session_count: null }; counting_explanation: string[]; canonical_feedback: CanonicalFeedback[]; groups: ReasoningGroup[]; limitations: string[] };
export type ReasoningState = "unassigned" | "assigned" | "draft" | "submitted" | "approved" | "returned";
export type ReasoningAction = "assign" | "analyze" | "submit" | "approve_reasoning" | "return_reasoning";
export type ReasoningTask = { task_id: string; batch_id: string; title: string; test_data: true; state: ReasoningState; task_revision: number; assignment_version: number; assignee: string | null; input_revision: number; input_digest: string; analysis_version_id: string | null; result_digest: string | null; submission_id: string | null; decision_id: string | null; updated_at: string; allowed_actions: ReasoningAction[] };
export type ReasoningInput = { input_revision: number; input_digest: string; input_base64: string; batch: FeedbackBatch; imported_by: string; imported_at: string };
export type AnalysisVersion = { analysis_version_id: string; input_revision: number; input_digest: string; method: RuleMethod; rule_digest: string; result: ReasoningResult; result_digest: string; created_by: string; created_at: string; assignment_version: number };
export type AnalysisBinding = { analysis_version_id: string; input_revision: number; input_digest: string; result_digest: string };
export type ReasoningSubmission = AnalysisBinding & { submission_id: string; submitted_by: string; submitted_at: string; assignment_version: number; test_data: true; review_scope: "test_reasoning_only" };
export type ReasoningDecision = AnalysisBinding & { decision_id: string; submission_id: string; decision: "approve_reasoning" | "return_reasoning"; reviewed_by: string; reviewed_at: string; assignment_version: number; final_priority: "P0" | "P1" | "P2" | "P3" | null; priority_reason: string | null; reason: string | null; test_data: true; review_scope: "test_reasoning_only" };
export type TaskDetail = { contract_version: typeof REASONING_CONTRACT; context: PersonContext; context_id: string; task: ReasoningTask; input: ReasoningInput; analysis: AnalysisVersion | null; submission: ReasoningSubmission | null; decision: ReasoningDecision | null };
export type ReasoningList = { contract_version: typeof REASONING_CONTRACT; context: PersonContext; context_id: string; tasks: ReasoningTask[]; assignees: { username: string; display_name: string }[]; has_more: boolean; next_cursor: string | null };
export type ReasoningHistory = { contract_version: typeof REASONING_CONTRACT; context: PersonContext; context_id: string; items: { record_type: "input" | "analysis" | "submission" | "decision" | "assignment"; record_id: string; data: unknown }[]; has_more: boolean; next_cursor: string | null };
export type ActionContext = { action_id: string; context_id: string; expected_context: PersonContext; expected_task_revision: number; assignment_version: number };
export type ImportBatchRequest = ActionContext & { input_base64: string };
export type ReasoningActionRequest = ActionContext & (
  { action: "assign"; assignee: string } |
  { action: "analyze"; input_revision: number; input_digest: string; method_version: "pmr-rules/1" } |
  ({ action: "submit" } & AnalysisBinding) |
  ({ action: "approve_reasoning"; submission_id: string; final_priority: "P0" | "P1" | "P2" | "P3"; priority_reason: string } & AnalysisBinding) |
  ({ action: "return_reasoning"; submission_id: string; reason: string } & AnalysisBinding)
);
