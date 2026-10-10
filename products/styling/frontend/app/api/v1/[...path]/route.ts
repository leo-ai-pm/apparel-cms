import { NextRequest } from "next/server";
import { parseAdminJson } from "@/app/lib/admin-context";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8010";

type PersonalPreviewConfiguration = { cookieName: string; publicOrigin: string; publicHost: string; backend: string; adminCookieName?: string };

function personalPreviewConfiguration(): PersonalPreviewConfiguration | null {
  const mode = process.env.PERSONAL_PREVIEW_PROXY_MODE;
  if (mode === undefined || mode === "0") return null;
  const combined = process.env.PERSONAL_PREVIEW_ADMIN_COEXIST === "1" && process.env.ADMIN_CONTEXT_MODE === "1";
  if (mode !== "1" || (!combined && process.env.ADMIN_CONTEXT_MODE !== undefined && process.env.ADMIN_CONTEXT_MODE !== "0")) {
    throw new Error("Invalid personal preview proxy mode configuration");
  }
  const cookieName = process.env.CONSUMER_COOKIE_NAME;
  const publicOrigin = process.env.PERSONAL_PREVIEW_PUBLIC_ORIGIN;
  const backend = process.env.BACKEND_URL;
  if (!cookieName || !/^styling_consumer_[a-f0-9]{12}$/.test(cookieName) || !publicOrigin || !backend) {
    throw new Error("Invalid personal preview proxy configuration");
  }
  const publicUrl = new URL(publicOrigin), backendUrl = new URL(backend);
  if (![publicUrl, backendUrl].every(url => ["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
    || publicUrl.origin !== publicOrigin || backendUrl.origin !== backend) {
    throw new Error("Invalid personal preview proxy configuration");
  }
  const admin = combined ? adminContextConfiguration() : null;
  if (combined && (!admin || process.env.ADMIN_PUBLIC_ORIGIN !== publicOrigin)) throw new Error("Inconsistent combined proxy origins");
  return { cookieName, publicOrigin, publicHost: publicUrl.host, backend, ...(admin ? { adminCookieName: admin.cookieName } : {}) };
}

function exactCookieName(cookie: string, allowedName: string): boolean {
  const equals = cookie.indexOf("=");
  return equals > 0 && cookie.slice(0, equals) === allowedName;
}

function previewProxyError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

const PREVIEW_UPLOAD_LIMIT = 5 * 1024 * 1024 + 64 * 1024;

async function readPreviewUpload(req: NextRequest): Promise<ArrayBuffer | Response> {
  const tooLarge = () => previewProxyError(413, "PREVIEW_UPLOAD_TOO_LARGE", "照片上传内容超过允许大小。");
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > PREVIEW_UPLOAD_LIMIT) {
    await req.body?.cancel().catch(() => undefined);
    return tooLarge();
  }
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PREVIEW_UPLOAD_LIMIT) {
        await reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

/** Isolated consumer deployment only; the legacy and ADMINCTX branches below retain their own policy. */
async function personalPreviewProxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }, method: "GET" | "POST" | "DELETE"): Promise<Response | null> {
  let config: PersonalPreviewConfiguration | null;
  try { config = personalPreviewConfiguration(); }
  catch { return previewProxyError(503, "PREVIEW_PROXY_CONFIGURATION_INVALID", "本人效果服务的代理配置尚未就绪。"); }
  if (!config) return null;
  // The HTTPS deployment trusts its configured public Host, never client Forwarded headers.
  if (new URL(config.publicOrigin).protocol === "https:"
    && (req.headers.get("host") ?? req.nextUrl.host).toLowerCase() !== config.publicHost) {
    return previewProxyError(403, "PREVIEW_PROXY_HOST_INVALID", "请求站点不符合服务的公开入口配置。");
  }
  const { path } = await ctx.params;
  const adminRequest = !!config.adminCookieName && path[0] === "admin";
  if (req.headers.has("authorization")) {
    if (adminRequest) return Response.json({ error: { code: "ADMIN_AUTH_REQUIRED", message: "管理会话不接受Bearer身份或混合身份", retryable: false } }, { status: 401, headers: { "cache-control": "no-store" } });
    return previewProxyError(403, "PROFILE_OWNER_INVALID", "本人效果服务不接受此身份或混合身份，请重新确认当前身份。");
  }
  const origin = req.headers.get("origin");
  if ((origin !== null && origin !== config.publicOrigin) || (method !== "GET" && origin !== config.publicOrigin)) {
    return previewProxyError(403, "PREVIEW_PROXY_ORIGIN_INVALID", "请求来源不符合本人效果服务的配置。");
  }
  try {
    // Preserve original bytes, including multipart order and strict JSON rejected upstream.
    const upload = method === "POST" && path.length === 2 && path[0] === "personal-preview" && path[1] === "tasks";
    const body = method === "POST" ? await (upload ? readPreviewUpload(req) : req.arrayBuffer()) : undefined;
    if (body instanceof Response) return body;
    let allowedCookieName = adminRequest ? config.adminCookieName! : config.cookieName;
    if (config.adminCookieName && method === "POST" && path.length === 2 && path[0] === "demo-access" && path[1] === "enter" && body) {
      try {
        const value = parseAdminJson(new TextDecoder().decode(body));
        if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && "role" in value && value.role === "styling-manager") allowedCookieName = config.adminCookieName;
      } catch { /* Invalid or duplicate JSON stays untouched for authoritative rejection. */ }
    }
    const headers = new Headers({ "content-type": req.headers.get("content-type") ?? "application/json" });
    // Raw header filtering preserves all occurrences of the exact name for upstream ambiguity checks.
    const cookies = (req.headers.get("cookie") ?? "").split(";").map(part => part.trim())
      .filter(part => exactCookieName(part, allowedCookieName));
    if (cookies.length) headers.set("cookie", cookies.join("; "));
    if (origin !== null) headers.set("origin", origin);
    headers.set("x-styling-public-host", config.publicHost);
    // Do not parse FormData or serialize JSON: preserve metadata-first multipart order and original bytes.
    // Preserve unexpected/duplicate parameters for the backend's closed-query rejection.
    const query = req.nextUrl.search;
    const upstream = await fetch(`${config.backend}/api/v1/${path.join("/")}${query}`, {
      method, headers, ...(body === undefined ? {} : { body }), cache: "no-store", redirect: "error",
    });
    return new Response(upstream.body, { status: upstream.status, headers: passthroughHeaders(upstream, allowedCookieName) });
  } catch {
    // Do not echo an upstream URL, Cookie, confirmation token, or request body in a proxy error.
    return previewProxyError(503, "PREVIEW_PROXY_UNAVAILABLE", "本人效果服务暂时无法连接，请查询原请求状态后再操作。");
  }
}

/** Deployment-only binding. Never derive the new service's trusted host from a client header. */
function adminContextConfiguration(): { cookieName: string; publicHost: string } | null {
  const mode = process.env.ADMIN_CONTEXT_MODE;
  if (mode === undefined || mode === "0") return null;
  if (mode !== "1") throw new Error("Invalid admin context mode configuration");
  const cookieName = process.env.ADMIN_COOKIE_NAME;
  const origin = process.env.ADMIN_PUBLIC_ORIGIN;
  if (!cookieName || !/^styling_admin_[A-Za-z0-9_]{1,100}$/.test(cookieName) || cookieName === "styling_admin_v1" || !origin) {
    throw new Error("Invalid admin context proxy configuration");
  }
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("Invalid admin context proxy configuration"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error("Invalid admin context proxy configuration");
  }
  return { cookieName, publicHost: parsed.host };
}

function consumerCookieName(): string {
  const configured = process.env.CONSUMER_COOKIE_NAME ?? "styling_consumer_674b8bba8e8d";
  if (!/^styling_consumer_[a-f0-9]{12}$/.test(configured)) throw new Error("Invalid consumer cookie configuration");
  return configured;
}

function rejectMixedAdminIdentity(req: NextRequest): Response | null {
  if (!adminContextConfiguration() || !req.headers.has("authorization")) return null;
  // Do not silently turn a mixed-identity request into an accepted cookie request.
  return Response.json({ error: { code: "ADMIN_AUTH_REQUIRED", message: "管理会话不接受Bearer身份或混合身份", retryable: false } },
    { status: 401, headers: { "cache-control": "no-store" } });
}

function passthroughHeaders(upstream: Response, allowedCookieName?: string): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  headers.set("content-type", contentType ?? "application/json");
  headers.set("cache-control", "no-store");
  headers.set("x-accel-buffering", "no");
  for (const cookie of upstream.headers.getSetCookie()) {
    if (!allowedCookieName || exactCookieName(cookie.trimStart(), allowedCookieName)) headers.append("set-cookie", cookie);
  }
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) headers.set("content-disposition", disposition);
  const nosniff = upstream.headers.get("x-content-type-options");
  if (nosniff) headers.set("x-content-type-options", nosniff);
  const digest = upstream.headers.get("x-content-sha256");
  if (digest) headers.set("x-content-sha256", digest);
  for (const name of ["x-styling-admin-action-contract", "x-styling-admin-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function requestHeaders(req: NextRequest): Headers {
  const headers = new Headers({ "content-type": req.headers.get("content-type") ?? "application/json" });
  const admin = adminContextConfiguration();
  // Preserve duplicate occurrences of the exact allowed name so upstream can reject
  // ambiguous authentication; NextRequest.cookies would silently collapse them.
  const cookies = admin
    ? (req.headers.get("cookie") ?? "").split(";").map(part => part.trim())
      .filter(part => part.slice(0, part.indexOf("=")) === admin.cookieName)
    : ["styling_admin_v1", consumerCookieName()]
      .flatMap(name => { const cookie = req.cookies.get(name); return cookie ? [`${name}=${cookie.value}`] : []; });
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  const origin = req.headers.get("origin");
  if (origin) headers.set("origin", origin);
  const host = admin?.publicHost ?? req.headers.get("host");
  if (host) headers.set("x-styling-public-host", host);
  return headers;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const preview = await personalPreviewProxy(req, ctx, "GET"); if (preview) return preview;
  const rejected = rejectMixedAdminIdentity(req); if (rejected) return rejected;
  const { path } = await ctx.params;
  // 转发查询参数（如 /api/v1/tryon?session_id=xxx）
  const upstream = await fetch(`${BACKEND}/api/v1/${path.join("/")}${req.nextUrl.search}`, { method: "GET", headers: requestHeaders(req), cache: "no-store", redirect: "error" });
  return new Response(upstream.body, { status: upstream.status, headers: passthroughHeaders(upstream) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const preview = await personalPreviewProxy(req, ctx, "POST"); if (preview) return preview;
  const rejected = rejectMixedAdminIdentity(req); if (rejected) return rejected;
  const { path } = await ctx.params;
  // 用 arrayBuffer 保留二进制（multipart 文件上传需原样转发，不能用 text）
  const body = await req.arrayBuffer();
  const upstream = await fetch(`${BACKEND}/api/v1/${path.join("/")}`, {
    method: "POST",
    headers: requestHeaders(req),
    body,
    cache: "no-store",
    redirect: "error",
  });
  return new Response(upstream.body, { status: upstream.status, headers: passthroughHeaders(upstream) });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const preview = await personalPreviewProxy(req, ctx, "DELETE"); if (preview) return preview;
  const rejected = rejectMixedAdminIdentity(req); if (rejected) return rejected;
  const { path } = await ctx.params;
  // Cart removal identifies the session in the query; DELETE has no request body.
  const upstream = await fetch(`${BACKEND}/api/v1/${path.join("/")}${req.nextUrl.search}`, {
    method: "DELETE", headers: requestHeaders(req), cache: "no-store", redirect: "error",
  });
  return new Response(upstream.body, { status: upstream.status, headers: passthroughHeaders(upstream) });
}
