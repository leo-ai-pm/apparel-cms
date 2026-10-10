import { NextResponse, type NextRequest } from "next/server";
import { AuthError, authErrorResponse, recheckPerson, requirePerson, sameHostUrl } from "@/lib/auth";
import { createStaffInvite } from "@/lib/users-db";

export function POST(request: NextRequest) {
  try {
    const person = requirePerson(request, true);
    if (person.user.role !== "manager") throw new AuthError("FORBIDDEN", "仅产品负责人可以邀请成员。", 403);
    if (person.access?.mode === "demo") throw new AuthError("LOGIN_FROZEN", "演示访问期间账号注册已冻结。", 409);
    recheckPerson(person);
    const invite = createStaffInvite(person.user.username);
    return NextResponse.json({ code: invite.code, link: sameHostUrl(request, "/register").toString(), expiresAt: invite.expiresAt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return authErrorResponse(error); }
}
