import { NextResponse, type NextRequest } from "next/server";
import { authErrorResponse, requirePerson, revokeSession, SESSION_COOKIE, sessionCookieOptions, DEMO_COOKIES } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const person = requirePerson(request, true); revokeSession(person);
    const demo = person.access?.mode === "demo";
    const response = NextResponse.json({ logged_out: true, ...(demo ? { access: person.access, redirect_to: `/demo/${person.user.role}` } : {}) }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(demo ? DEMO_COOKIES[person.user.role] : SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
    return response;
  } catch (error) { return authErrorResponse(error); }
}
