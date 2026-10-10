import type { NextRequest } from "next/server";
import { authErrorResponse, requirePerson, prepareDemoRequest, setDemoResponseCookie } from "@/lib/auth";

export function GET(request: NextRequest) {
  try {
    const prepared = prepareDemoRequest(request);
    return setDemoResponseCookie(Response.json({ ...requirePerson(prepared.request), capabilities: { paid_models: false } }, { headers: { "Cache-Control": "private, no-store" } }), prepared.cookie);
  } catch (error) { return authErrorResponse(error); }
}
