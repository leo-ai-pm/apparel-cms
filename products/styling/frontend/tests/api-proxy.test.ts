import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const backend = "http://127.0.0.1:8036";
let remove: typeof import("../app/api/v1/[...path]/route").DELETE;
let get: typeof import("../app/api/v1/[...path]/route").GET;
let post: typeof import("../app/api/v1/[...path]/route").POST;
const context = () => ({ params: Promise.resolve({ path: ["cart", "P001"] }) });

beforeAll(async () => {
  vi.stubEnv("BACKEND_URL", backend);
  const proxy = await import("../app/api/v1/[...path]/route");
  remove = proxy.DELETE; get = proxy.GET; post = proxy.POST;
});

describe("消费者资料代理身份", () => {
  it("独立服务只转发配置的精确Cookie，不沿用主空间Cookie或篡改Origin", async () => {
    vi.stubEnv("CONSUMER_COOKIE_NAME", "styling_consumer_ef5aa3738ed7");
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
      vi.stubGlobal("fetch", fetcher);
      await get(new NextRequest("http://127.0.0.2:3061/api/v1/consumer-profile", { headers: {
        cookie: "styling_consumer_674b8bba8e8d=main; styling_consumer_ef5aa3738ed7=isolated; styling_consumer_ef5aa3738ed7_extra=ignore",
        origin: "http://127.0.0.2:3061",
      } }), { params: Promise.resolve({ path: ["consumer-profile"] }) });
      const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
      expect(headers.get("cookie")).toBe("styling_consumer_ef5aa3738ed7=isolated");
      expect(headers.get("origin")).toBe("http://127.0.0.2:3061");
    } finally { vi.stubEnv("CONSUMER_COOKIE_NAME", undefined); }
  });

  it("错误Cookie配置直接失败而不退回主身份或前缀通配", async () => {
    vi.stubEnv("CONSUMER_COOKIE_NAME", "styling_consumer_*");
    try {
      const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
      await expect(get(new NextRequest("http://127.0.0.2:3061/api/v1/consumer-profile"), { params: Promise.resolve({ path: ["consumer-profile"] }) })).rejects.toThrow("Invalid consumer cookie configuration");
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.stubEnv("CONSUMER_COOKIE_NAME", undefined); }
  });

  it("单品JPEG原字节及摘要头透传，禁缓存，不将异常响应替换成图片", async () => {
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const digest = "a".repeat(64);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/jpeg", "x-content-sha256": digest } })));
    const response = await get(new NextRequest("http://127.0.0.2:3061/api/v1/outfits/product-assets/example"), { params: Promise.resolve({ path: ["outfits", "product-assets", "example"] }) });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("x-content-sha256")).toBe(digest);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["GET", "POST", "DELETE"])("%s仅转发精确消费者与管理员Cookie，不放行相似前缀", async method => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal("fetch", fetcher);
    const request = new NextRequest("http://localhost:3037/api/v1/consumer-profile", { method, headers: {
      cookie: "styling_consumer_674b8bba8e8d=synthetic-consumer; styling_admin_v1=synthetic-admin; styling_consumer_other=ignored; styling_consumer_674b8bba8e8d_extra=ignored; unrelated=ignored",
    }, ...(method === "POST" ? { body: '{"patch":{}}' } : {}) });
    await (method === "GET" ? get : method === "POST" ? post : remove)(request, { params: Promise.resolve({ path: ["consumer-profile"] }) });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("cookie")).toBe("styling_admin_v1=synthetic-admin; styling_consumer_674b8bba8e8d=synthetic-consumer");
  });

  it("消费者初始化多个Set-Cookie保持分离并保留Expires、HttpOnly、Strict及Secure属性", async () => {
    const cookies = [
      "styling_consumer_674b8bba8e8d=synthetic-consumer; Expires=Fri, 09 Apr 2027 00:00:00 GMT; Path=/; HttpOnly; SameSite=Strict; Secure",
      "styling_admin_v1=synthetic-admin; Path=/; HttpOnly; SameSite=Strict",
    ];
    const headers = new Headers({ "content-type": "application/json" });
    cookies.forEach(cookie => headers.append("set-cookie", cookie));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers })));
    const response = await get(new NextRequest("http://localhost:3037/api/v1/consumer-profile"), { params: Promise.resolve({ path: ["consumer-profile"] }) });
    expect(response.headers.getSetCookie()).toEqual(cookies);
  });

  it("prepare原JSON字节不经代理补默认或改写", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal("fetch", fetcher);
    const body = '{\n "operation":"chat", "request_body":{"message":"隔离样例","request_conditions":{"budget_max_fen":null}}\n}';
    await post(new NextRequest("http://localhost:3037/api/v1/consumer-profile/prepare", { method: "POST", body }), { params: Promise.resolve({ path: ["consumer-profile", "prepare"] }) });
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1]?.body as ArrayBuffer)).toBe(body);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => { vi.unstubAllEnvs(); });

describe("DELETE API proxy", () => {
  it("preserves the session query and existing cookie, origin and public-host rules", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"cart":[]}'));
    vi.stubGlobal("fetch", fetcher);
    const query = "?session_id=synthetic%2Bcart%20A%26B&check=one%2Ftwo";
    const request = new NextRequest(`http://localhost:3037/api/v1/cart/P001${query}`, {
      method: "DELETE", headers: {
        "content-type": "application/json; charset=utf-8",
        cookie: "unrelated_private_cookie=ignored; styling_admin_v1=synthetic-admin-cookie",
        origin: "http://localhost:3037", host: "localhost:3037",
        "x-styling-public-host": "untrusted.example", authorization: "do-not-forward",
      },
    });
    await remove(request, context());
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(`${backend}/api/v1/cart/P001${query}`);
    expect(options?.method).toBe("DELETE");
    expect(options?.cache).toBe("no-store");
    const headers = new Headers(options?.headers);
    expect(headers.get("cookie")).toBe("styling_admin_v1=synthetic-admin-cookie");
    expect(headers.get("origin")).toBe("http://localhost:3037");
    expect(headers.get("x-styling-public-host")).toBe("localhost:3037");
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(headers.has("authorization")).toBe(false);
  });

  it("does not invent a session cookie or origin when they are absent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"cart":[]}'));
    vi.stubGlobal("fetch", fetcher);
    await remove(new NextRequest("http://localhost:3037/api/v1/cart/P001?session_id=synthetic", { method: "DELETE" }), context());
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("x-styling-public-host")).toBe(false);
  });

  it("never reads or sends a DELETE request body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"cart":[]}'));
    vi.stubGlobal("fetch", fetcher);
    const request = new NextRequest("http://localhost:3037/api/v1/cart/P001?session_id=synthetic", {
      method: "DELETE", body: "this body must not reach the backend",
    });
    const read = vi.spyOn(request, "arrayBuffer");
    await remove(request, context());
    expect(read).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("streams successful UTF-8 bytes and existing response headers without JSON reserialization", async () => {
    const bytes = new TextEncoder().encode('{\n  "cart": [], "note": "取消合成加购"\n}\n');
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, { headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": "styling_admin_v1=synthetic-new-cookie; HttpOnly; Path=/",
      "content-disposition": 'attachment; filename="synthetic-cart.json"',
    } })));
    const response = await remove(new NextRequest("http://localhost:3037/api/v1/cart/P001?session_id=synthetic", { method: "DELETE" }), context());
    expect(response.status).toBe(200);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(bytes));
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("set-cookie")).toBe("styling_admin_v1=synthetic-new-cookie; HttpOnly; Path=/");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="synthetic-cart.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it.each([401, 404, 502])("preserves upstream HTTP%i and its exact error body instead of manufacturing cart success", async status => {
    const body = '{\n "error": {"code": "TEST_ERROR", "message": "取消未完成"}\n}\n';
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status, headers: { "content-type": "application/json" },
    })));
    const response = await remove(new NextRequest("http://localhost:3037/api/v1/cart/P001?session_id=synthetic", { method: "DELETE" }), context());
    expect(response.status).toBe(status);
    expect(response.ok).toBe(false);
    expect(await response.text()).toBe(body);
  });

  it("keeps an upstream204 response empty", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
    const response = await remove(new NextRequest("http://localhost:3037/api/v1/cart/P001?session_id=synthetic", { method: "DELETE" }), context());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("propagates a failed upstream request without returning an empty successful cart", async () => {
    const failure = new Error("synthetic upstream unavailable");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(failure));
    await expect(remove(new NextRequest("http://localhost:3037/api/v1/cart/P001?session_id=synthetic", { method: "DELETE" }), context())).rejects.toBe(failure);
  });
});
