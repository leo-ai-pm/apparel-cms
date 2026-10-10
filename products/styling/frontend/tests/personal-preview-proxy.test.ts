import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "../app/api/v1/[...path]/route";

// Controlled fetch fixtures only; the exact runtime Cookie and live service remain a separate delivery.
const origin = "http://personal-preview.localhost:3084";
const backend = "http://127.0.0.1:8084";
const cookieName = "styling_consumer_aabbcc112233";
const handlers = { GET, POST, DELETE };
type Method = keyof typeof handlers;
const methods: Method[] = ["GET", "POST", "DELETE"];
const ctx = (path = ["personal-preview", "tasks"]) => ({ params: Promise.resolve({ path }) });
function request(method: Method = "GET", headers: Record<string, string> = {}, body?: BodyInit) {
  return new NextRequest(`${origin}/api/v1/personal-preview/tasks`, { method, headers, ...(body === undefined ? {} : { body }) });
}
function mockUpstream(response = new Response("{}")) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response); vi.stubGlobal("fetch", fetcher); return fetcher;
}

beforeEach(() => {
  vi.stubEnv("PERSONAL_PREVIEW_PROXY_MODE", "1"); vi.stubEnv("PERSONAL_PREVIEW_PUBLIC_ORIGIN", origin);
  vi.stubEnv("CONSUMER_COOKIE_NAME", cookieName); vi.stubEnv("BACKEND_URL", backend); vi.stubEnv("ADMIN_CONTEXT_MODE", undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("personal preview isolated proxy identity (mock fetch only)", () => {
  it.each(methods)("%s forwards only the exact raw consumer Cookie and trusted configured host", async method => {
    const fetcher = mockUpstream();
    await handlers[method](request(method, {
      origin, cookie: `styling_admin_v1=admin; styling_admin_sac_20261010=otheradmin; styling_consumer_674b8bba8e8d=otherowner; ${cookieName}_extra=ignore; unrelated=ignore; ${cookieName}=consumer%3Dvalue`,
      host: "attacker.example", "x-styling-public-host": "attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https",
    }, method === "POST" ? "{}" : undefined), ctx());
    const [url, options] = fetcher.mock.calls[0]; const headers = new Headers(options?.headers);
    expect(url).toBe(`${backend}/api/v1/personal-preview/tasks`); expect(options?.method).toBe(method);
    expect(headers.get("cookie")).toBe(`${cookieName}=consumer%3Dvalue`); expect(headers.get("origin")).toBe(origin);
    expect(headers.get("x-styling-public-host")).toBe("personal-preview.localhost:3084");
    expect(headers.has("host")).toBe(false); expect(headers.has("x-forwarded-host")).toBe(false); expect(headers.has("x-forwarded-proto")).toBe(false);
    expect(options?.cache).toBe("no-store"); expect(options?.redirect).toBe("error");
  });

  it("preserves duplicate exact Cookie occurrences for authoritative rejection without choosing an identity", async () => {
    const fetcher = mockUpstream(new Response('{"error":{"code":"PROFILE_OWNER_INVALID"}}', { status: 403 }));
    const response = await GET(request("GET", { cookie: `${cookieName}=first; unrelated=x; ${cookieName}=second; ${cookieName}x` }), ctx());
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("cookie")).toBe(`${cookieName}=first; ${cookieName}=second`);
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("allows an Origin-less initial GET without inventing a Cookie or identity", async () => {
    const fetcher = mockUpstream(); await GET(request(), ctx(["consumer-profile"])); const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.has("cookie")).toBe(false); expect(headers.has("origin")).toBe(false); expect(headers.get("x-styling-public-host")).toBe("personal-preview.localhost:3084");
  });

  it.each(methods)("%s rejects an Authorization identity before forwarding or reading a body", async method => {
    const fetcher = mockUpstream(); const input = request(method, { origin, authorization: "Bearer synthetic-other-owner", cookie: `${cookieName}=consumer` }, method === "POST" ? "private bytes" : undefined); const read = vi.spyOn(input, "arrayBuffer");
    const response = await handlers[method](input, ctx()); expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { code: "PROFILE_OWNER_INVALID" } });
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(fetcher).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it("does not treat an empty Authorization header as an absent identity mechanism", async () => {
    const fetcher = mockUpstream(); const response = await GET(request("GET", { authorization: "" }), ctx()); expect(response.status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(methods)("%s rejects a foreign Origin instead of stripping or replacing it", async method => {
    const fetcher = mockUpstream(); const input = request(method, { origin: "http://attacker.example", cookie: `${cookieName}=consumer` }, method === "POST" ? "private bytes" : undefined); const read = vi.spyOn(input, "arrayBuffer");
    const response = await handlers[method](input, ctx()); expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { code: "PREVIEW_PROXY_ORIGIN_INVALID" } });
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(fetcher).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"] as const)("%s requires an explicit exact Origin", async method => {
    const fetcher = mockUpstream(); const response = await handlers[method](request(method), ctx()); expect(response.status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["null", `${origin}/`, "https://personal-preview.localhost:3084", "http://personal-preview.localhost:3085", `${origin}, http://attacker.example`])("rejects a non-exact supplied Origin %s", async supplied => {
    const fetcher = mockUpstream(); const response = await POST(request("POST", { origin: supplied }, "{}"), ctx()); expect(response.status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("personal preview proxy configuration and legacy isolation", () => {
  it.each([
    ["PERSONAL_PREVIEW_PROXY_MODE", "true"], ["PERSONAL_PREVIEW_PROXY_MODE", ""],
    ["CONSUMER_COOKIE_NAME", undefined], ["CONSUMER_COOKIE_NAME", "styling_consumer_*"], ["CONSUMER_COOKIE_NAME", "styling_consumer_AABBCC112233"], ["CONSUMER_COOKIE_NAME", "styling_consumer_aabbcc11223"],
    ["PERSONAL_PREVIEW_PUBLIC_ORIGIN", undefined], ["PERSONAL_PREVIEW_PUBLIC_ORIGIN", "not-an-origin"], ["PERSONAL_PREVIEW_PUBLIC_ORIGIN", `${origin}/path`], ["PERSONAL_PREVIEW_PUBLIC_ORIGIN", `${origin}/`], ["PERSONAL_PREVIEW_PUBLIC_ORIGIN", "http://user:pass@personal-preview.localhost:3084"], ["PERSONAL_PREVIEW_PUBLIC_ORIGIN", "ftp://personal-preview.localhost:3084"],
    ["BACKEND_URL", undefined], ["BACKEND_URL", "not-an-origin"], ["BACKEND_URL", `${backend}/private`], ["BACKEND_URL", "http://user:pass@127.0.0.1:8084"],
    ["ADMIN_CONTEXT_MODE", "1"], ["ADMIN_CONTEXT_MODE", "unexpected"],
  ])("fails closed without fallback when %s=%s", async (key, value) => {
    vi.stubEnv(key!, value); const fetcher = mockUpstream(); const input = request("POST", { origin }, "private bytes"); const read = vi.spyOn(input, "arrayBuffer");
    const response = await POST(input, ctx()); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: "PREVIEW_PROXY_CONFIGURATION_INVALID" } });
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(fetcher).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, "0"])("preserves the existing non-preview proxy when mode=%s", async mode => {
    vi.stubEnv("PERSONAL_PREVIEW_PROXY_MODE", mode); vi.stubEnv("PERSONAL_PREVIEW_PUBLIC_ORIGIN", "invalid-but-unused");
    const upstreamCookies = ["styling_admin_v1=unchanged; Path=/; HttpOnly", `${cookieName}=unchanged; Path=/; HttpOnly`];
    const headers = new Headers(); upstreamCookies.forEach(value => headers.append("set-cookie", value)); const fetcher = mockUpstream(new Response("{}", { headers }));
    const response = await POST(request("POST", { authorization: "legacy-ignored", host: "legacy.localhost:3061", cookie: `styling_admin_v1=admin; ${cookieName}=consumer` }, "{}"), ctx(["consumer-profile"]));
    const forwarded = new Headers(fetcher.mock.calls[0][1]?.headers); expect(forwarded.get("cookie")).toBe(`styling_admin_v1=admin; ${cookieName}=consumer`); expect(forwarded.has("authorization")).toBe(false); expect(forwarded.get("x-styling-public-host")).toBe("legacy.localhost:3061"); expect(response.headers.getSetCookie()).toEqual(upstreamCookies);
  });
});

describe("personal preview proxy original bytes and private responses", () => {
  it("preserves forbidden POST query parameters for the authoritative closed-query rejection", async () => {
    const fetcher = mockUpstream(new Response('{"error":{"code":"PREVIEW_INVALID_REQUEST","message":"invalid query"}}', { status: 422 }));
    const input = new NextRequest(`${origin}/api/v1/personal-preview/confirmations?owner=first&owner=second`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
    const response = await POST(input, ctx(["personal-preview", "confirmations"]));
    expect(fetcher.mock.calls[0][0]).toBe(`${backend}/api/v1/personal-preview/confirmations?owner=first&owner=second`);
    expect(response.status).toBe(422);
  });
  it.each([undefined, "1"])("cancels an oversized upload based on actual streamed bytes with Content-Length=%s", async length => {
    const limit = 5 * 1024 * 1024 + 64 * 1024; const cancel = vi.fn(); let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(pulls === 1 ? limit : 1)); }, cancel }, { highWaterMark: 0 });
    const input = request("POST", { origin, ...(length === undefined ? {} : { "content-length": length }) }, stream); const readWhole = vi.spyOn(input, "arrayBuffer"); const fetcher = mockUpstream();
    const response = await POST(input, ctx()); expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ error: { code: "PREVIEW_UPLOAD_TOO_LARGE" } }); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cancel).toHaveBeenCalledTimes(1); expect(pulls).toBe(2); expect(readWhole).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized upload before pulling its body", async () => {
    const pull = vi.fn(), cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }); const fetcher = mockUpstream();
    const response = await POST(request("POST", { origin, "content-length": String(5 * 1024 * 1024 + 64 * 1024 + 1) }, stream), ctx());
    expect(response.status).toBe(413); expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards an upload at the total byte boundary unchanged and in original chunk order", async () => {
    const limit = 5 * 1024 * 1024 + 64 * 1024; const bytes = new Uint8Array(limit); bytes.set(new TextEncoder().encode('--fixture\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n--fixture\r\nContent-Disposition: form-data; name="photo"\r\n\r\n'));
    bytes.set([255, 0, 128, 13, 10], limit - 5); const chunks = [bytes.slice(0, 1024), bytes.slice(1024)]; const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); }, cancel }, { highWaterMark: 0 }); const fetcher = mockUpstream(new Response("{}", { status: 202 }));
    const response = await POST(request("POST", { origin, "content-type": "multipart/form-data; boundary=fixture", "content-length": String(limit) }, stream), ctx()); const actual = fetcher.mock.calls[0][1]?.body as ArrayBuffer;
    expect(response.status).toBe(202); expect(actual.byteLength).toBe(limit); expect(Buffer.from(actual).equals(Buffer.from(bytes))).toBe(true); expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps a bounded stream read failure as safe 503 without forwarding a partial upload", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("synthetic-private-stream-error")); } }); const fetcher = mockUpstream();
    const response = await POST(request("POST", { origin }, stream), ctx()); expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.text()).not.toContain("synthetic-private"); expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps metadata before the binary photo with its exact multipart boundary and bytes", async () => {
    const boundary = "synthetic-preview-boundary"; const contentType = `multipart/form-data; boundary=${boundary}`;
    const start = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"request_id":"synthetic-original"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n`);
    const binary = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10, 128]); const end = new TextEncoder().encode(`\r\n--${boundary}--\r\n`); const bytes = new Uint8Array([...start, ...binary, ...end]); const fetcher = mockUpstream(new Response('{"duplicate":false}', { status: 202 }));
    const response = await POST(request("POST", { origin, "content-type": contentType }, bytes), ctx()); const options = fetcher.mock.calls[0][1]; expect(new Uint8Array(options?.body as ArrayBuffer)).toEqual(bytes); expect(new Headers(options?.headers).get("content-type")).toBe(contentType); expect(response.status).toBe(202);
  });

  it("keeps raw JSON confirmation bytes and does not add identity, target, or token fields", async () => {
    const raw = '{\n "confirmed_photo_rights": true, "confirmed_ai_reference": true\n}\n'; const fetcher = mockUpstream(new Response("{}", { status: 201 })); await POST(request("POST", { origin, "content-type": "application/json; charset=utf-8" }, raw), ctx(["personal-preview", "confirmations"]));
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as ArrayBuffer)).toBe(raw);
  });

  it("preserves only exact scoped Set-Cookie entries individually with all attributes and expirations", async () => {
    const accepted = [`${cookieName}=first; Expires=Fri, 09 Apr 2027 00:00:00 GMT; Path=/; HttpOnly; SameSite=Strict; Secure`, `${cookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`];
    const headers = new Headers(); [accepted[0], "styling_admin_v1=admin; Path=/; HttpOnly", "styling_consumer_674b8bba8e8d=another-scope; Path=/; HttpOnly", `${cookieName}_suffix=ignore; Path=/`, "unrelated=ignore; Path=/", accepted[1]].forEach(value => headers.append("set-cookie", value)); mockUpstream(new Response("{}", { headers }));
    const response = await GET(request(), ctx(["consumer-profile"])); expect(response.headers.getSetCookie()).toEqual(accepted); expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves private result bytes, content type, and no-store without exposing upstream location", async () => {
    const bytes = new Uint8Array([255, 216, 0, 128, 255, 217]); mockUpstream(new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=999999", location: "https://private-provider.invalid/result", "x-content-sha256": "a".repeat(64) } }));
    const response = await GET(request(), ctx(["personal-preview", "tasks", "synthetic-task", "result"])); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes); expect(response.headers.get("content-type")).toBe("image/jpeg"); expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-content-sha256")).toBe("a".repeat(64)); expect(response.headers.has("location")).toBe(false);
  });

  it.each([403, 404, 409, 410, 413, 415, 422, 429, 503])("preserves upstream %i and original safe error bytes without manufacturing success", async status => {
    const body = '{\n "error": {"code":"PREVIEW_SYNTHETIC_FAILURE","message":"受控失败"}\n}\n'; mockUpstream(new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "public" } }));
    const response = await GET(request(), ctx()); expect(response.status).toBe(status); expect(await response.text()).toBe(body); expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves GET query bytes for selection and pagination", async () => {
    const query = "?session_id=synthetic%2BA&look_version_id=LV%2F1&cursor=next%3Dpage"; const fetcher = mockUpstream(); await GET(new NextRequest(`${origin}/api/v1/personal-preview/availability${query}`), ctx(["personal-preview", "availability"])); expect(fetcher.mock.calls[0][0]).toBe(`${backend}/api/v1/personal-preview/availability${query}`);
  });

  it("does not read or forward an unsupported DELETE body", async () => {
    const input = request("DELETE", { origin }, "must-not-forward"); const read = vi.spyOn(input, "arrayBuffer"); const fetcher = mockUpstream(); await DELETE(input, ctx()); expect(read).not.toHaveBeenCalled(); expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("returns a safe no-store failure on network or redirect rejection without leaking private diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic-private-cookie/token/photo/provider-url")); vi.stubGlobal("fetch", fetcher); const response = await POST(request("POST", { origin }, "synthetic-private-body"), ctx()); const text = await response.text();
    expect(response.status).toBe(503); expect(text).toContain("PREVIEW_PROXY_UNAVAILABLE"); expect(text).not.toContain("synthetic-private"); expect(response.headers.get("cache-control")).toBe("no-store"); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("keeps the existing body reader for other routes and safely handles its failure", async () => {
    const fetcher = mockUpstream(); const input = request("POST", { origin }, "synthetic-private-body"); const read = vi.spyOn(input, "arrayBuffer").mockRejectedValue(new Error("synthetic-private-read")); const response = await POST(input, ctx(["personal-preview", "confirmations"])); expect(read).toHaveBeenCalledTimes(1); expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await response.text()).not.toContain("synthetic-private"); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("explicit combined consumer/admin runtime: credentials remain separate", () => {
  const adminCookie = "styling_admin_partner_20261010";
  function combined() { vi.stubEnv("PERSONAL_PREVIEW_ADMIN_COEXIST", "1"); vi.stubEnv("ADMIN_CONTEXT_MODE", "1"); vi.stubEnv("ADMIN_COOKIE_NAME", adminCookie); vi.stubEnv("ADMIN_PUBLIC_ORIGIN", origin); }
  it.each(["GET", "POST"] as const)("%s routes admin paths using only trusted admin Cookie and preserves query", async method => {
    combined(); const responseHeaders = new Headers(); responseHeaders.append("set-cookie", `${adminCookie}=new; Path=/; HttpOnly`); responseHeaders.append("set-cookie", `${cookieName}=discard; Path=/; HttpOnly`);
    const fetcher = mockUpstream(new Response("{}", { headers: responseHeaders })); const input = new NextRequest(`${origin}/api/v1/admin/auth/login?extra=1&extra=2`, { method, headers: { origin, cookie: `${adminCookie}=admin; ${cookieName}=consumer; styling_admin_v1=legacy`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    const response = await handlers[method](input, ctx(["admin", "auth", "login"])); expect(fetcher.mock.calls[0][0]).toBe(`${backend}/api/v1/admin/auth/login?extra=1&extra=2`);
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers); expect(headers.get("cookie")).toBe(`${adminCookie}=admin`); expect(headers.get("origin")).toBe(origin); expect(headers.get("x-styling-public-host")).toBe("personal-preview.localhost:3084");
    expect(response.headers.getSetCookie()).toEqual([`${adminCookie}=new; Path=/; HttpOnly`]);
  });
  it("still routes photo/profile requests with consumer Cookie alone", async () => {
    combined(); const fetcher = mockUpstream(); await GET(request("GET", { origin, cookie: `${adminCookie}=admin; ${cookieName}=consumer` }), ctx(["consumer-profile"]));
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("cookie")).toBe(`${cookieName}=consumer`);
  });
  it("rejects combined origins mismatch and mixed admin Authorization", async () => {
    combined(); vi.stubEnv("ADMIN_PUBLIC_ORIGIN", "http://another.localhost:3084"); const fetcher = mockUpstream(); expect((await GET(request(), ctx(["admin", "auth", "me"]))).status).toBe(503); expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv("ADMIN_PUBLIC_ORIGIN", origin); expect((await GET(request("GET", { authorization: "Bearer ignored" }), ctx(["admin", "auth", "me"]))).status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  });
});
