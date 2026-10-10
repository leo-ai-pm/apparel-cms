import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AuthError, authErrorResponse, requirePerson, sameHostUrl, hasPersonnelIdentity, demoRole, demoAccessEnabled, pageDemoRole, prepareDemoRequest, setDemoResponseCookie } from "./lib/auth";

const personnelRoutes = new Set(["/api/workbench/signals", "/api/workbench/case", "/api/workbench/history", "/api/workbench/actions", "/api/workbench/template-preview"]);
const authRoutes = new Set(["/api/auth/login", "/api/auth/register", "/api/auth/me", "/api/auth/logout", "/api/auth/demo"]);
const serviceRoutes = new Set(["/api/design-link/packages", "/api/design-link/events"]);

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  let demoCookie: { name: string; value: string } | null = null;
  try {
    if (serviceRoutes.has(pathname)) {
      if (hasPersonnelIdentity(request)) throw new AuthError("AUTH_IDENTITY_CONFLICT", "人员会话不能调用服务交接接口。", 403);
      return NextResponse.next(); // Purpose-bound authentication remains in each service handler.
    }
    demoRole(request.headers.get("x-workbench-demo-role"));
    if (authRoutes.has(pathname)) return NextResponse.next(); // Each auth handler bootstraps or enforces its own Origin/session rule.
    const page = pathname === "/workbench" || pathname.startsWith("/workbench/") || pathname === "/team" || pathname.startsWith("/team/");
    const prepared = prepareDemoRequest(request, page ? pageDemoRole(request) : undefined); demoCookie = prepared.cookie;
    const person = requirePerson(prepared.request, !["GET", "HEAD", "OPTIONS"].includes(request.method));
    const proceed = () => setDemoResponseCookie(NextResponse.next({ request: { headers: prepared.request.headers } }), demoCookie);
    if (pathname === "/team" || pathname.startsWith("/team/") || pathname.startsWith("/api/team/")) {
      if (person.user.role !== "manager") throw new AuthError("FORBIDDEN", "仅产品负责人可查看成员管理。", 403);
      if (page || pathname === "/api/team/invites") return proceed();
    }
    if (page || personnelRoutes.has(pathname) || /^\/api\/workbench\/design-assets\/[^/]+\/[^/]+$/.test(pathname)
      || /^\/api\/workbench\/reasoning\/(tasks|batches|sample)$/.test(pathname)
      || /^\/api\/workbench\/reasoning\/tasks\/[^/]+(?:\/(?:actions|history))?$/.test(pathname)) return proceed();
    if (/^\/api\/workbench\/receipts\/[^/]+\/(payload|supplement)$/.test(pathname)) {
      if (person.user.role !== "manager") throw new AuthError("FORBIDDEN", "仅产品负责人可读取来源原件。", 403);
      return proceed();
    }
    if (pathname === "/api/agent/analyze" || pathname === "/api/agent/chat") throw new AuthError("CAPABILITY_UNAVAILABLE", "本轮未开放收费模型调用。", 503);
    throw new AuthError("LEGACY_ROUTE_DISABLED", "旧业务或未知接口已关闭，请使用当前工作台。", 403);
  } catch (error) {
    if (error instanceof AuthError && error.status === 401 && !pathname.startsWith("/api/")) return NextResponse.redirect(sameHostUrl(request, demoAccessEnabled() ? `/demo/${pageDemoRole(request)}` : "/login"));
    return setDemoResponseCookie(authErrorResponse(error), demoCookie);
  }
}
export const config = { matcher: ["/workbench/:path*", "/team/:path*", "/api/:path*"] };
