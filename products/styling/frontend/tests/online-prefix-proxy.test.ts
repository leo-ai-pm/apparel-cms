import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST, DELETE } from "../app/api/v1/[...path]/route";

const origin = "https://s357brv8j8f9gdhvbu9a9.apigateway-cn-beijing.volceapi.com";
const host = new URL(origin).host, prefix = "/v2/styling";
const consumer = "styling_consumer_aabbcc112233", admin = "styling_admin_public_20261010";
const backend = "http://127.0.0.1:8190";
const handlers = { GET, POST, DELETE };
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
beforeEach(() => {
  for (const [key, value] of Object.entries({ PERSONAL_PREVIEW_PROXY_MODE: "1", PERSONAL_PREVIEW_ADMIN_COEXIST: "1", ADMIN_CONTEXT_MODE: "1", PERSONAL_PREVIEW_PUBLIC_ORIGIN: origin, ADMIN_PUBLIC_ORIGIN: origin, CONSUMER_COOKIE_NAME: consumer, ADMIN_COOKIE_NAME: admin, BACKEND_URL: backend })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(["GET", "POST", "DELETE"] as const)("%s strips only the Next prefix and keeps query/role identity/original bytes", async method => {
  const headers = new Headers({ "content-type": "text/event-stream", "content-disposition": "attachment; filename=original.json", "x-content-sha256": "a".repeat(64) });
  const consumerCookie = `${consumer}=visitor; Path=/; HttpOnly; Secure; SameSite=Strict`;
  headers.append("set-cookie", consumerCookie); headers.append("set-cookie", `${admin}=manager; Path=/; Secure`);
  const bytes = new Uint8Array([0, 10, 255, 128, 13]); const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers })); vi.stubGlobal("fetch", fetcher);
  const body = new Uint8Array([1, 255, 128, 13, 10]);
  const result = await handlers[method](new NextRequest(`${origin}${prefix}/api/v1/consumer-profile?x=%2F&x=duplicate`, { method,
    headers: { host, origin, cookie: `${admin}=manager; ${consumer}=visitor; other=x`, "content-type": "application/octet-stream", "x-forwarded-host": "attacker.test", forwarded: "host=attacker.test;proto=http" },
    ...(method === "POST" ? { body } : {}) }), context(["consumer-profile"]));
  const [url, options] = fetcher.mock.calls[0]; const forwarded = new Headers(options.headers);
  expect(url).toBe(`${backend}/api/v1/consumer-profile?x=%2F&x=duplicate`); expect(forwarded.get("cookie")).toBe(`${consumer}=visitor`);
  expect(forwarded.get("x-styling-public-host")).toBe(host); expect(forwarded.has("forwarded")).toBe(false); expect(forwarded.has("x-forwarded-host")).toBe(false);
  if (method === "POST") expect(new Uint8Array(options.body)).toEqual(body);
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes); expect(result.headers.getSetCookie()).toEqual([consumerCookie]);
  expect(result.headers.get("content-disposition")).toBe("attachment; filename=original.json"); expect(result.headers.get("x-content-sha256")).toBe("a".repeat(64)); expect(result.headers.get("cache-control")).toBe("no-store");
});
it.each(["consumer", "styling-manager"] as const)("public enter %s filters request and response Cookie by exact role", async role => {
  const allowed = role === "consumer" ? consumer : admin; const headers = new Headers();
  headers.append("set-cookie", `${consumer}=visitor; Path=/; HttpOnly; Secure; SameSite=Strict`); headers.append("set-cookie", `${admin}=manager; Path=/; HttpOnly; Secure; SameSite=Strict`);
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { headers })); vi.stubGlobal("fetch", fetcher);
  const result = await POST(new NextRequest(`${origin}${prefix}/api/v1/demo-access/enter`, { method: "POST", headers: { host, origin, cookie: `${consumer}=visitor; ${admin}=manager; ${allowed}_extra=bad` }, body: JSON.stringify({ role }) }), context(["demo-access", "enter"]));
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("cookie")).toBe(`${allowed}=${role === "consumer" ? "visitor" : "manager"}`);
  expect(result.headers.getSetCookie()).toHaveLength(1); expect(result.headers.getSetCookie()[0]).toMatch(new RegExp(`^${allowed}=`));
});
it.each(["GET", "POST", "DELETE"] as const)("%s rejects wrong Host despite forged trusted forwarding headers", async method => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const result = await handlers[method](new NextRequest(`${origin}${prefix}/api/v1/admin/me`, { method, headers: { host: "attacker.test", origin, "x-forwarded-host": host, "x-styling-public-host": host, forwarded: `host=${host};proto=https` }, ...(method === "POST" ? { body: "private body" } : {}) }), context(["admin", "me"]));
  expect(result.status).toBe(403); expect(await result.json()).toMatchObject({ error: { code: "PREVIEW_PROXY_HOST_INVALID" } }); expect(fetcher).not.toHaveBeenCalled();
});
it.each([{}, { origin: "https://foreign.test" }, { origin, authorization: "Bearer forbidden" }] as Record<string, string>[])("public write rejects absent/foreign Origin or mixed Bearer before reading body %#", async extra => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const request = new NextRequest(`${origin}${prefix}/api/v1/demo-access/enter`, { method: "POST", headers: { host, ...extra }, body: '{"role":"consumer"}' }); const read = vi.spyOn(request, "arrayBuffer");
  const result = await POST(request, context(["demo-access", "enter"])); expect(result.status).toBe(403); expect(fetcher).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});
it("public admin API forwards only the exact admin Cookie and refuses Bearer rather than dropping it", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetcher);
  await GET(new NextRequest(`${origin}${prefix}/api/v1/admin/me`, { headers: { host, cookie: `${consumer}=visitor; ${admin}=manager` } }), context(["admin", "me"]));
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("cookie")).toBe(`${admin}=manager`);
  fetcher.mockClear(); const result = await GET(new NextRequest(`${origin}${prefix}/api/v1/admin/me`, { headers: { host, authorization: "Bearer invalid" } }), context(["admin", "me"])); expect(result.status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
});
