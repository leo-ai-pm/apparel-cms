// Type-only aliases of the backend-owned formal DTO. No server code is bundled.
export type {EvidenceRef,CanonicalFeedback,RoleCount,RuleMethod as Method,ReasoningGroup as Group,ReasoningResult as AnalysisResult,AnalysisVersion as Analysis,AnalysisBinding as ExactVersion,ReasoningTask as Task,ReasoningInput as InputVersion,ReasoningSubmission as Submission,ReasoningDecision as Decision,TaskDetail,ReasoningList as TaskList,ReasoningHistory as History} from '@/lib/reasoning-types';
import type {ReasoningGroup,ReasoningHistory} from '@/lib/reasoning-types';
export type Statement=ReasoningGroup['facts'][number];
export type HistoryItem=ReasoningHistory['items'][number];
