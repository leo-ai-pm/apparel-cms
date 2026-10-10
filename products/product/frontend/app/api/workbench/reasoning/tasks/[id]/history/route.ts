import { requirePerson } from "@/lib/auth";
import { getReasoningHistory } from "@/lib/reasoning-workflow";
import { reasoningJson, reasoningFailure } from "@/lib/reasoning-http";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { const person = requirePerson(request); return reasoningJson(getReasoningHistory(person, (await context.params).id, new URL(request.url).searchParams.get("cursor"))); } catch (error) { return reasoningFailure(error); } }
