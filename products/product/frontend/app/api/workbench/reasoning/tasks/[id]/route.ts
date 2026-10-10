import { requirePerson } from "@/lib/auth";
import { getReasoning } from "@/lib/reasoning-workflow";
import { reasoningJson, reasoningFailure } from "@/lib/reasoning-http";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { const person = requirePerson(request); return reasoningJson(getReasoning(person, (await context.params).id)); } catch (error) { return reasoningFailure(error); } }
