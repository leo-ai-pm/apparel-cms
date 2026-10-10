import { NextResponse, type NextRequest } from "next/server";
import { authenticate, assertFormOrigin, AuthError, authErrorResponse, createSession, sameHostUrl, SESSION_COOKIE, sessionCookieOptions, sessionToken, demoAccessEnabled } from "@/lib/auth";
import { readAuthForm } from "@/lib/partner-auth-form";

export async function POST(request: NextRequest) {
  try {
    assertFormOrigin(request);
    if (demoAccessEnabled()) throw new AuthError("LOGIN_FROZEN", "演示访问期间无需登录，请直接选择员工或负责人入口", 409);
    const previousToken = sessionToken(request);
    const form = await readAuthForm(request, ["username", "password"]);
    const username = String(form.get("username") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");
    const user = authenticate(username, password);
    if (!user) return NextResponse.redirect(sameHostUrl(request, "/login?error=invalid"), { status: 303 });
    const token = createSession(user, previousToken);
    const response = NextResponse.redirect(sameHostUrl(request, "/workbench"), { status: 303 });
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
    return response;
  } catch (error) { return authErrorResponse(error); }
}
