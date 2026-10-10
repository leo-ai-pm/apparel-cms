import { NextResponse, type NextRequest } from "next/server";
import { authErrorResponse, demoAccessEnabled, pageDemoRole, prepareDemoRequest, sameHostUrl, setDemoResponseCookie } from "@/lib/auth";
export function GET(request: NextRequest) {
  try {
    const role = pageDemoRole(request);
    if (!demoAccessEnabled()) return NextResponse.redirect(sameHostUrl(request, "/login"), { status: 303, headers: { "Cache-Control": "private, no-store" } });
    const prepared = prepareDemoRequest(request, role);
    return setDemoResponseCookie(NextResponse.redirect(sameHostUrl(request, `/workbench?demo_role=${role}`), { status: 303, headers: { "Cache-Control": "private, no-store" } }), prepared.cookie);
  } catch (error) { return authErrorResponse(error); }
}
