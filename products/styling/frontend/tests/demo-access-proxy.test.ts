import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/v1/[...path]/route";
const origin = "http://personal-preview.localhost:3084", admin = "styling_admin_partner_20261010", consumer = "styling_consumer_369b705103c3";
beforeEach(() => {
  for (const [name, value] of Object.entries({ PERSONAL_PREVIEW_PROXY_MODE: "1", PERSONAL_PREVIEW_ADMIN_COEXIST: "1", ADMIN_CONTEXT_MODE: "1", ADMIN_COOKIE_NAME: admin, CONSUMER_COOKIE_NAME: consumer, PERSONAL_PREVIEW_PUBLIC_ORIGIN: origin, ADMIN_PUBLIC_ORIGIN: origin, BACKEND_URL: "http://127.0.0.1:8090" })) vi.stubEnv(name, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(["consumer", "styling-manager"])("enter %s forwards and accepts only that role's exact cookie", async role => {
  const allowed = role === "consumer" ? consumer : admin; const headers = new Headers(); headers.append("set-cookie", `${admin}=manager; Path=/; HttpOnly; SameSite=Strict`); headers.append("set-cookie", `${consumer}=visitor; Path=/; HttpOnly; SameSite=Lax`);
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { headers })); vi.stubGlobal("fetch", fetcher);
  const body = JSON.stringify({ role });
  const req = new NextRequest(`${origin}/api/v1/demo-access/enter`, { method: "POST", headers: { origin, "content-type": "application/json", cookie: `${consumer}=consumer1; ${admin}=admin1; unrelated=x; ${allowed}=duplicate` }, body });
  const result = await POST(req, { params: Promise.resolve({ path: ["demo-access", "enter"] }) });
  const options = fetcher.mock.calls[0][1]; expect(new Headers(options.headers).get("cookie")).toBe(`${allowed}=${role === "consumer" ? "consumer1" : "admin1"}; ${allowed}=duplicate`); expect(new TextDecoder().decode(options.body)).toBe(body);
  expect(result.headers.getSetCookie()).toHaveLength(1); expect(result.headers.getSetCookie()[0]).toMatch(new RegExp(`^${allowed}=`)); expect(result.headers.get("cache-control")).toBe("no-store");
});
it("malformed role body is forwarded untouched without selecting a manager identity", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 422 })); vi.stubGlobal("fetch", fetcher);
  const body = '{"role":"consumer","role":"styling-manager"}';
  const result = await POST(new NextRequest(`${origin}/api/v1/demo-access/enter`, { method: "POST", headers: { origin, cookie: `${admin}=admin; ${consumer}=consumer` }, body }), { params: Promise.resolve({ path: ["demo-access", "enter"] }) });
  expect(result.status).toBe(422); expect(new TextDecoder().decode(fetcher.mock.calls[0][1].body)).toBe(body); expect(new Headers(fetcher.mock.calls[0][1].headers).get("cookie")).toBe(`${consumer}=consumer`);
});
it("foreign Origin or mixed Bearer never reaches enter", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  for (const headers of [{ origin: "http://foreign.example" }, { origin, authorization: "Bearer forbidden" }] as Record<string, string>[]) {
    const result = await POST(new NextRequest(`${origin}/api/v1/demo-access/enter`, { method: "POST", headers, body: '{"role":"styling-manager"}' }), { params: Promise.resolve({ path: ["demo-access", "enter"] }) }); expect(result.status).toBe(403);
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it("capability GET remains GET and does not forward manager cookies", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetcher);
  await GET(new NextRequest(`${origin}/api/v1/demo-access`, { headers: { cookie: `${admin}=admin` } }), { params: Promise.resolve({ path: ["demo-access"] }) }); expect(fetcher.mock.calls[0][1].method).toBe("GET"); expect(new Headers(fetcher.mock.calls[0][1].headers).has("cookie")).toBe(false);
});
