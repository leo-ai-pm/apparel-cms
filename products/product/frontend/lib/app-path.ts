/** Public same-origin path, fixed at build time together with next.config.basePath. */
export function appPath(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const pathname=path.split(/[?#]/,1)[0];
  if (!base || !path.startsWith("/") || path.startsWith("//") || pathname === base || pathname.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}
