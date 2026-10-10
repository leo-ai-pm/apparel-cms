import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appPath, isPrefixedDemoDeployment } from "../app/lib/app-path";
import { getPlatformLinks } from "../app/lib/platform-links";
import { StylingPreview } from "../components/styling-preview";
import PlatformPage from "../app/platform/page";
import { legacyConsumerRoute } from "./consumer-test-routes";

const prefix = "/v2/styling";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", prefix);
  vi.stubEnv("NEXT_PUBLIC_DEMO_ACCESS_SUPPORTED", "1");
  vi.stubEnv("NEXT_PUBLIC_LINK_PRODUCT", "/v2/product");
  vi.stubEnv("NEXT_PUBLIC_LINK_DESIGN", "/v2/design");
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => vi.unstubAllEnvs());

it.each(["/", "/admin", "/platform", "/images/editorial-styling.png", "/showcase-products/P001.png", "/tryon-results/outfit.png", "/product-images/SKU-1.png", "/api/v1/consumer-profile", "/api/v1/personal-preview/tasks/id/image?version=1"])("prefixes same-origin destination %s once", path => {
  expect(appPath(path)).toBe(`${prefix}${path}`); expect(appPath(appPath(path))).toBe(`${prefix}${path}`);
});
it.each(["https://example.test/image.png", "blob:local-image", "#outfit", "//example.test/path"])("preserves external/blob/hash path %s", path => expect(appPath(path)).toBe(path));
it("empty prefix and legacy account deployments keep their existing behavior", () => {
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", ""); expect(appPath("/api/v1/chat")).toBe("/api/v1/chat"); expect(isPrefixedDemoDeployment()).toBe(false);
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/styling"); vi.stubEnv("NEXT_PUBLIC_DEMO_ACCESS_SUPPORTED", "0"); expect(isPrefixedDemoDeployment()).toBe(false);
});
it("public navigation uses the three product prefixes and omits the legacy CMS destination", () => {
  expect(getPlatformLinks().filter(l => l.id !== "cms").map(l => l.href)).toEqual([`${prefix}/`, "/v2/product", "/v2/design"]);
  const { container } = render(<PlatformPage />);
  expect(screen.getByRole("link", { name: "进入穿搭管理" })).toHaveAttribute("href", `${prefix}/admin`);
  expect(screen.queryByRole("link", { name: /CMS/ })).not.toBeInTheDocument();
  expect([...container.querySelectorAll("a")].some(a => /localhost|127\.0\.0\.1/.test(a.getAttribute("href") ?? ""))).toBe(false);
  const source = screen.getByRole("img", { name: /风格意向/ }).getAttribute("src")!;
  expect(new URL(source, "http://localhost").searchParams.get("url") ?? source).toBe(`${prefix}/images/editorial-styling.png`);
});
it("prefixed public consumer mounts without the legacy platform account gate (controlled HTTP)", async () => {
  const caps = { contract_version: "styling_demo_access_v1", mode: "public_demo", login_required: false, shared_demo: true,
    roles: [{ role: "consumer", entry_path: "/" }, { role: "styling-manager", entry_path: "/admin" }] };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const path = new URL(url, "http://localhost").pathname;
    if (path === `${prefix}/api/v1/demo-access`) return json(caps);
    if (path === `${prefix}/api/v1/demo-access/enter`) return json({ contract_version: caps.contract_version, role: "consumer", entry_path: "/" });
    if (!path.startsWith(`${prefix}/api/v1/`)) throw new Error("unexpected unprefixed endpoint");
    return legacyConsumerRoute(path.slice(prefix.length), init) ?? json({ messages: [] });
  });
  vi.stubGlobal("fetch", fetcher); render(<StylingPreview />);
  await screen.findByRole("textbox"); expect(screen.getByLabelText("演示访问身份")).toHaveTextContent("公开合成演示");
  expect(fetcher.mock.calls.some(([input]) => String(input).includes("/platform/me"))).toBe(false);
  expect(fetcher.mock.calls.some(([input]) => String(input) === `${prefix}/api/v1/consumer-profile`)).toBe(true);
  expect(fetcher.mock.calls.some(([input, init]) => String(input).endsWith("/chat") && init?.method === "POST")).toBe(false);
});
