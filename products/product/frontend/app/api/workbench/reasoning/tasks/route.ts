import { requirePerson } from "@/lib/auth";
import { listReasoning } from "@/lib/reasoning-workflow";
import { reasoningJson, reasoningFailure } from "@/lib/reasoning-http";
export function GET(request: Request) { try { return reasoningJson(listReasoning(requirePerson(request), new URL(request.url).searchParams.get("cursor"))); } catch (error) { return reasoningFailure(error); } }
