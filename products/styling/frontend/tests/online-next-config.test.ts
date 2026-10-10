import { afterEach, expect, it, vi } from "vitest";
import AdminLogin from "../app/admin/login/page";
import Login from "../app/login/page";
import ConsumerLogin from "../app/platform/login/page";
const navigation = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: navigation.redirect }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each(["", "/v2/styling"])("Next configuration keeps media destinations at backend root for basePath %j", async base => {
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", base); vi.stubEnv("BACKEND_URL", "http://127.0.0.1:8190"); vi.resetModules();
  const { default: config } = await import("../next.config");
  expect(config.basePath).toBe(base); expect(config.output).toBe("standalone");
  expect(await config.rewrites!()).toEqual([
    { source: "/tryon-results/:path*", destination: "http://127.0.0.1:8190/tryon-results/:path*" },
    { source: "/product-images/:path*", destination: "http://127.0.0.1:8190/product-images/:path*" },
  ]);
});
it.each(["", "/v2/styling"])("legacy login bookmarks redirect within the deployment basePath %j", base => {
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", base); AdminLogin(); Login(); ConsumerLogin();
  expect(navigation.redirect.mock.calls.map(([path]) => path)).toEqual([`${base}/admin`, `${base}/admin`, `${base}/`]);
});
