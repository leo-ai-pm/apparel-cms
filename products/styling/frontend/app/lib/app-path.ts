/** Public same-origin path, fixed at build time together with next.config.basePath. */
export function appPath(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!base || !path.startsWith("/") || path.startsWith("//") || path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}

/** A standalone role demo under a prefix is independent of the legacy CMS account. */
export function isPrefixedDemoDeployment(): boolean {
  return !!process.env.NEXT_PUBLIC_BASE_PATH && process.env.NEXT_PUBLIC_DEMO_ACCESS_SUPPORTED === "1";
}
