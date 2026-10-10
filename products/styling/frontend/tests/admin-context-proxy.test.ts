import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "../app/api/v1/[...path]/route";

const url = "http://admin-context.localhost:3071/api/v1/admin/me";
const ctx = (path = ["admin", "me"]) => ({ params: Promise.resolve({ path }) });
beforeEach(() => {
  vi.stubEnv("ADMIN_CONTEXT_MODE", "1");
  vi.stubEnv("ADMIN_COOKIE_NAME", "styling_admin_sac_20261010");
  vi.stubEnv("ADMIN_PUBLIC_ORIGIN", "http://admin-context.localhost:3071");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("ADMINCTX private same-origin proxy (mock fetch only)", () => {
  it.each(["GET", "POST", "DELETE"])("%s forwards only new exact cookie and overwrites spoofed trusted host", async method => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    const request = new NextRequest(url, { method, headers: {
      cookie: "styling_admin_v1=old; styling_consumer_ef5aa3738ed7=consumer; styling_admin_sac_20261010=synthetic; styling_admin_sac_20261010_more=ignore; other=ignore",
      host: "spoofed.example", "x-styling-public-host": "spoofed.example",
      "x-forwarded-host": "spoofed.example", origin: "http://admin-context.localhost:3071",
    }, ...(method === "POST" ? { body: "{}" } : {}) });
    await (method === "GET" ? GET : method === "POST" ? POST : DELETE)(request, ctx());
    const options = fetcher.mock.calls[0][1];
    const headers = new Headers(options?.headers);
    expect(headers.get("cookie")).toBe("styling_admin_sac_20261010=synthetic");
    expect(headers.get("origin")).toBe("http://admin-context.localhost:3071");
    expect(headers.get("x-styling-public-host")).toBe("admin-context.localhost:3071");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-forwarded-host")).toBe(false);
    expect(options?.cache).toBe("no-store");
    expect(options?.redirect).toBe("error");
  });

  it.each(["GET", "POST", "DELETE"])("%s rejects mixed identity locally without forwarding credentials or body", async method => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const response = await (method === "GET" ? GET : method === "POST" ? POST : DELETE)(new NextRequest(url, { method,
      headers: { authorization: "Bearer synthetic", cookie: "styling_admin_sac_20261010=synthetic" },
      ...(method === "POST" ? { body: '{"synthetic":true}' } : {}),
    }), ctx());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "ADMIN_AUTH_REQUIRED", retryable: false } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves duplicate exact cookies for authoritative upstream rejection instead of choosing one", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{"code":"ADMIN_AUTH_REQUIRED"}}', { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(new NextRequest(url, { headers: { cookie: "styling_admin_sac_20261010=first; unrelated=x; styling_admin_sac_20261010=second" } }), ctx());
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("cookie")).toBe("styling_admin_sac_20261010=first; styling_admin_sac_20261010=second");
    expect(response.status).toBe(401);
  });

  it.each([undefined, "http://unapproved.example"])("never invents or strips incoming origin (%s)", async origin => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await GET(new NextRequest(url, { headers: origin ? { origin } : {} }), ctx());
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get("origin")).toBe(origin ?? null);
    expect(headers.get("cookie")).toBeNull();
  });

  it.each([
    ["ADMIN_CONTEXT_MODE", "unexpected"], ["ADMIN_COOKIE_NAME", undefined],
    ["ADMIN_COOKIE_NAME", "styling_admin_*"] , ["ADMIN_COOKIE_NAME", "styling_admin_v1"],
    ["ADMIN_PUBLIC_ORIGIN", undefined], ["ADMIN_PUBLIC_ORIGIN", "http://example.test/path"],
    ["ADMIN_PUBLIC_ORIGIN", "http://user:pass@example.test"], ["ADMIN_PUBLIC_ORIGIN", "not-an-origin"],
  ])("invalid %s configuration fails before any upstream access", async (key, value) => {
    vi.stubEnv(key!, value);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(GET(new NextRequest(url), ctx())).rejects.toThrow(/Invalid admin context/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains original action bytes, multiple cookie attributes, correlation and raw download digest headers", async () => {
    const requestId = "00000000-0000-4000-8000-000000000001";
    const body = '{\n "admin_action_contract":"styling_admin_action_v1", "request_id":"' + requestId + '", "expected_admin_context":{"context_contract":"styling_admin_context_v1","context_id":"' + "A".repeat(43) + '"}\n}';
    const cookies = [
      "styling_admin_sac_20261010=synthetic; Expires=Fri, 09 Oct 2026 23:00:00 GMT; HttpOnly; SameSite=Strict; Path=/",
      "styling_admin_sac_20261010=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/",
    ];
    const headers = new Headers({ "content-type": "application/json", "x-styling-admin-action-contract": "styling_admin_action_v1", "x-styling-admin-request-id": requestId, "x-content-sha256": "a".repeat(64), "content-disposition": 'attachment; filename="frozen.json"' });
    cookies.forEach(cookie => headers.append("set-cookie", cookie));
    const raw = '{ "frozen": true }\n';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(raw, { headers }));
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(new NextRequest(url, { method: "POST", body }), ctx(["admin", "logout"]));
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as ArrayBuffer)).toBe(body);
    expect(await response.text()).toBe(raw);
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.get("x-styling-admin-action-contract")).toBe("styling_admin_action_v1");
    expect(response.headers.get("x-styling-admin-request-id")).toBe(requestId);
    expect(response.headers.get("x-content-sha256")).toBe("a".repeat(64));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
