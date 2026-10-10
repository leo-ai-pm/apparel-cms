import { createElement } from "react";
import type { ImageProps } from "next/image";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlatformPage from "../app/platform/page";
import { getPlatformLinks, type PlatformLink } from "../app/lib/platform-links";
import { PlatformBar } from "../components/platform-bar";

vi.mock("next/image", () => ({
  default: ({ src, alt, width, height }: ImageProps) => createElement("img", {
    src: typeof src === "string" ? src : "default" in src ? src.default.src : src.src,
    alt,
    width,
    height,
  }),
}));

const publicEnvironment = [
  "NEXT_PUBLIC_BASE_PATH",
  "NEXT_PUBLIC_LINK_OUTFIT",
  "NEXT_PUBLIC_LINK_PRODUCT",
  "NEXT_PUBLIC_LINK_DESIGN",
  "NEXT_PUBLIC_LINK_CMS",
] as const;

const partners = [
  { id: "product", environment: "NEXT_PUBLIC_LINK_PRODUCT", fallback: "http://localhost:3000" },
  { id: "design", environment: "NEXT_PUBLIC_LINK_DESIGN", fallback: "http://localhost:5180" },
  { id: "cms", environment: "NEXT_PUBLIC_LINK_CMS", fallback: "http://localhost:8001" },
] as const;

function link(id: PlatformLink["id"]) {
  const entry = getPlatformLinks().find(item => item.id === id);
  expect(entry).toBeDefined();
  return entry!;
}

beforeEach(() => {
  for (const environment of publicEnvironment) vi.stubEnv(environment, undefined);
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("platform entry addresses", () => {
  it("uses verified local defaults when public partner configuration is absent or empty", () => {
    expect(link("outfit").href).toBe("/");
    for (const partner of partners) {
      expect(link(partner.id).href).toBe(partner.fallback);
      vi.stubEnv(partner.environment, "");
      expect(link(partner.id).href).toBe(partner.fallback);
    }
  });

  it.each(["", "/styling"])("keeps outfit on this frontend with base path %j despite a legacy external setting", base => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", base);
    vi.stubEnv("NEXT_PUBLIC_LINK_OUTFIT", "https://legacy.example.test/old-outfit");
    expect(link("outfit").href).toBe(`${base}/`);
  });

  it.each(["outfit", "product", "design", "cms", null] as const)("marks only the requested current application %j", current => {
    expect(getPlatformLinks(current).filter(item => item.current).map(item => item.id))
      .toEqual(current === null ? [] : [current]);
  });

  it.each([
    "http://127.0.0.1:5300/workbench?mode=review#pending",
    "https://partner.example.test/workbench?mode=review#pending",
    "/product/workbench?mode=review#pending",
  ])("accepts a public HTTP(S) address or same-origin absolute path: %s", href => {
    for (const partner of partners) {
      vi.stubEnv(partner.environment, href);
      expect(link(partner.id).href).toBe(href);
    }
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///private/internal.html",
    "//external.example.test/workbench",
    "relative/workbench",
    "https://user:password@partner.example.test/workbench",
    "http://user@partner.example.test/workbench",
    "http://[",
    "https://partner.example.test/path with spaces",
    "/\\external.example.test/workbench",
    "/product\n/workbench",
  ])("falls back for unsafe or malformed configuration: %j", href => {
    for (const partner of partners) {
      vi.stubEnv(partner.environment, href);
      expect(link(partner.id).href).toBe(partner.fallback);
    }
  });
});

describe("consumer platform navigation", () => {
  it.each(["", "/styling"])("offers public destinations without CMS or admin links at base path %j", base => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", base);
    render(<PlatformBar />);
    expect(screen.getByRole("link", { name: "鞋服 AI 协作平台" })).toHaveAttribute("href", `${base}/platform`);
    const navigation = within(screen.getByRole("navigation", { name: "公开产品导航" }));
    const outfit = navigation.getByRole("link", { name: "穿搭" });
    expect(outfit).toHaveAttribute("href", `${base}/`);
    expect(outfit).toHaveAttribute("aria-current", "page");
    expect(outfit).not.toHaveAttribute("target");
    expect(navigation.getAllByRole("link")).toHaveLength(3);
    expect(screen.queryByRole("link", { name: /CMS|穿搭管理/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").some(item => /\/admin(?:[/?#]|$)/.test(item.getAttribute("href") || ""))).toBe(false);
  });

  it("opens partner destinations in a new tab with opener isolation", () => {
    vi.stubEnv("NEXT_PUBLIC_LINK_PRODUCT", "https://product.example.test/workbench");
    vi.stubEnv("NEXT_PUBLIC_LINK_DESIGN", "/design/workbench");
    render(<PlatformBar />);
    for (const [label, href] of [["产品", "https://product.example.test/workbench"], ["设计", "/design/workbench"]]) {
      const entry = screen.getByRole("link", { name: label });
      expect(entry).toHaveAttribute("href", href);
      expect(entry).toHaveAttribute("target", "_blank");
      expect(entry.getAttribute("rel")?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
      expect(entry).not.toHaveAttribute("aria-current");
    }
  });
});

describe("unified platform representative page", () => {
  it.each(["", "/styling"])("keeps consumer and authorized team actions in their correct areas at base path %j", base => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", base);
    render(<PlatformPage />);
    expect(screen.getByRole("link", { name: "开始穿搭对话" })).toHaveAttribute("href", `${base}/`);
    const team = within(screen.getByRole("region", { name: "团队审核与协作" }));
    expect(team.getByRole("link", { name: "进入穿搭管理" })).toHaveAttribute("href", `${base}/admin`);
    expect(team.getByText("需要管理员授权")).toBeInTheDocument();
    expect(team.getByRole("link", { name: "打开CMS现有页面" })).toHaveAttribute("href", "http://localhost:8001");
    const products = within(screen.getByRole("region", { name: "从个人穿搭，到产品与设计" }));
    expect(products.queryByRole("link", { name: /CMS|穿搭管理/ })).not.toBeInTheDocument();
  });

  it("labels every linked partner surface as existing and unverified business behavior", () => {
    const configured = {
      product: "https://product.example.test/current",
      design: "/design/current",
      cms: "http://127.0.0.1:8001/current",
    };
    for (const partner of partners) vi.stubEnv(partner.environment, configured[partner.id]);
    render(<PlatformPage />);
    for (const [name, href] of [
      ["打开产品现有页面", configured.product],
      ["打开设计现有页面", configured.design],
      ["打开CMS现有页面", configured.cms],
    ]) {
      const entry = screen.getByRole("link", { name });
      expect(entry).toHaveAttribute("href", href);
      expect(entry).toHaveAttribute("target", "_blank");
      expect(entry.getAttribute("rel")?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
      const context = entry.closest("article") || entry.parentElement;
      expect(context).toHaveTextContent("现有页面 · 本轮业务未验收");
    }
  });

  it("identifies the accessible AI image as visual intent rather than a SKU recommendation", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/styling");
    render(<PlatformPage />);
    const image = screen.getByRole("img", { name: /风格意向/ });
    expect(image).toHaveAttribute("src", "/styling/images/editorial-styling.png");
    expect(image.closest("figure")).toHaveTextContent("AI 生成风格意向图");
    expect(image.closest("figure")).toHaveTextContent("用于视觉氛围，非推荐SKU结果");
  });

  it("renders navigation and representative content without making business requests", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<PlatformPage />);
    render(<PlatformBar />);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
