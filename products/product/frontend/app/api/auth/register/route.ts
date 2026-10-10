import { NextResponse, type NextRequest } from "next/server";
import { assertFormOrigin, AuthError, authErrorResponse, createSession, hashPassword, reservedUsernames, sameHostUrl, SESSION_COOKIE, sessionCookieOptions, sessionToken, demoAccessEnabled } from "@/lib/auth";
import { registerStaff } from "@/lib/users-db";
import { readAuthForm } from "@/lib/partner-auth-form";

export async function POST(request: NextRequest) {
  try {
    assertFormOrigin(request);
    if (demoAccessEnabled()) throw new AuthError("LOGIN_FROZEN", "演示访问期间不注册账号，请直接使用角色入口", 409);
    const previousToken = sessionToken(request);
    const form = await readAuthForm(request, ["username", "displayName", "password", "confirm", "code"]);
    const username = String(form.get("username") || "").trim().toLowerCase();
    const displayName = String(form.get("displayName") || "").trim();
    const password = String(form.get("password") || "");
    const confirm = String(form.get("confirm") || "");
    const code = String(form.get("code") || "").trim();
    const errorUrl = (reason: string) => NextResponse.redirect(sameHostUrl(request, `/register?error=${reason}`), { status: 303 });
    if (!/^[a-z0-9._-]{3,32}$/.test(username) || displayName.length < 2 || displayName.length > 30 || password.length < 12 || password.length > 128 || password !== confirm) return errorUrl("fields");
    if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return errorUrl("invite");
    const result = registerStaff(username, displayName, hashPassword(password), code, reservedUsernames());
    if (result !== "ok") return errorUrl(result);
    const token = createSession({ username, role: "staff" }, previousToken);
    const response = NextResponse.redirect(sameHostUrl(request, "/workbench"), { status: 303 });
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
    return response;
  } catch (error) { return authErrorResponse(error); }
}
