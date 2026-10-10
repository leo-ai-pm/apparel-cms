import { requirePerson } from "@/lib/auth";
import { actReasoning, getReasoningAction } from "@/lib/reasoning-workflow";
import { body, reasoningJson, reasoningFailure } from "@/lib/reasoning-http";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { try { const person = requirePerson(request, true); const result = actReasoning(person, (await context.params).id, await body(request, 10000)); return reasoningJson(result.response, result.status); } catch (error) { return reasoningFailure(error); } }
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { const person = requirePerson(request); return reasoningJson(getReasoningAction(person, (await context.params).id, new URL(request.url).searchParams.get("action_id") ?? "")); } catch (error) { return reasoningFailure(error); } }
