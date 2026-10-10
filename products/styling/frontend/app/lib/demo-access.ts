import { appPath } from "./app-path";
import { parseAdminJson } from "./admin-context";

export type DemoRole = "consumer" | "styling-manager";
export type DemoCapability = {
  contract_version: "styling_demo_access_v1"; mode: "local_demo" | "public_demo" | "authenticated";
  login_required: boolean; roles: { role: DemoRole; entry_path: "/" | "/admin" }[]; shared_demo: boolean;
};
const entry = (role: DemoRole) => role === "consumer" ? "/" : "/admin";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export class DemoAccessError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const invalid = () => new DemoAccessError(502, "DEMO_INVALID_RESPONSE", "演示访问响应无法核对，尚未进入工作区。请重新读取访问模式。");
export function parseDemoCapability(value: unknown): DemoCapability {
  if (!object(value) || !exact(value, ["contract_version", "mode", "login_required", "roles", "shared_demo"])
    || value.contract_version !== "styling_demo_access_v1" || !["local_demo", "public_demo", "authenticated"].includes(value.mode as string)
    || value.login_required !== (value.mode === "authenticated") || value.shared_demo !== (value.mode !== "authenticated") || !Array.isArray(value.roles)) throw invalid();
  const seen = new Set<string>();
  for (const role of value.roles) {
    if (!object(role) || !exact(role, ["role", "entry_path"]) || !["consumer", "styling-manager"].includes(role.role as string)
      || seen.has(role.role as string) || role.entry_path !== entry(role.role as DemoRole)) throw invalid();
    seen.add(role.role as string);
  }
  if (value.mode !== "authenticated" && seen.size !== 2) throw invalid();
  return value as unknown as DemoCapability;
}
async function request(path: string, signal: AbortSignal, role?: DemoRole): Promise<unknown> {
  let response: Response;
  try { response = await fetch(appPath(`/api/v1/demo-access${path}`), { method: role ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    headers: { Accept: "application/json", ...(role ? { "Content-Type": "application/json" } : {}) }, ...(role ? { body: JSON.stringify({ role }) } : {}) }); }
  catch (cause) { if (signal.aborted) throw cause; throw new DemoAccessError(0, "DEMO_NETWORK_ERROR", "访问模式暂时无法读取，请明确重试；不会代提交业务操作。"); }
  if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    || !response.headers.get("cache-control")?.split(",").some(v => v.trim().toLowerCase() === "no-store")) throw invalid();
  const raw = await response.text(); if (raw.length > 64000) throw invalid();
  const value = parseAdminJson(raw);
  if (!response.ok) {
    const code = object(value) && object(value.error) && typeof value.error.code === "string" ? value.error.code : "DEMO_ACCESS_FAILED";
    throw new DemoAccessError(response.status, code, code === "DEMO_ACCESS_DISABLED" ? "演示模式已关闭，请重新读取模式以恢复普通访问。" : "演示访问未建立，请重新读取模式；不会把接口失败当作已进入。");
  }
  if (response.status !== 200) throw invalid();
  return value;
}
export async function fetchDemoCapability(signal: AbortSignal): Promise<DemoCapability> { return parseDemoCapability(await request("", signal)); }
export async function enterDemo(role: DemoRole, signal: AbortSignal): Promise<void> {
  const value = await request("/enter", signal, role);
  if (!object(value) || !exact(value, ["contract_version", "role", "entry_path"]) || value.contract_version !== "styling_demo_access_v1" || value.role !== role || value.entry_path !== entry(role)) throw invalid();
}
