import { requirePerson } from "@/lib/auth";
import { importReasoning } from "@/lib/reasoning-workflow";
import { body, reasoningJson, reasoningFailure } from "@/lib/reasoning-http";
export async function POST(request: Request) { try { const person = requirePerson(request, true); const result = importReasoning(person, await body(request)); return reasoningJson(result.response, result.status); } catch (error) { return reasoningFailure(error); } }
