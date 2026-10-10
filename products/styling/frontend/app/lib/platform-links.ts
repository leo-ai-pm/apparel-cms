import { appPath } from "./app-path";

export type PlatformLink = {
  id: "outfit" | "product" | "design" | "cms";
  label: string;
  href: string;
  current: boolean;
};

function publicEntry(value: string | undefined, fallback: string): string {
  const href = value?.trim();
  if (!href || /[\\\u0000-\u0020]/.test(href)) return fallback;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const url = new URL(href);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? href : fallback;
  } catch { return fallback; }
}

// Direct NEXT_PUBLIC_* reads so Next can inline them. Empty values fall back to local defaults.
export function getPlatformLinks(current: PlatformLink["id"] | null = "outfit"): PlatformLink[] {
  return [
    // A consumer always stays on this frontend, including its configured basePath.
    { id: "outfit", label: "穿搭", href: appPath("/"), current: current === "outfit" },
    { id: "product", label: "产品", href: publicEntry(process.env.NEXT_PUBLIC_LINK_PRODUCT, "http://localhost:3000"), current: current === "product" },
    { id: "design", label: "设计", href: publicEntry(process.env.NEXT_PUBLIC_LINK_DESIGN, "http://localhost:5180"), current: current === "design" },
    { id: "cms", label: "CMS", href: publicEntry(process.env.NEXT_PUBLIC_LINK_CMS, "http://localhost:8001"), current: current === "cms" },
  ];
}
