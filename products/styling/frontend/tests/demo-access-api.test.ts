import { afterEach, describe, expect, it, vi } from "vitest";
import { enterDemo, fetchDemoCapability, parseDemoCapability } from "../app/lib/demo-access";
import { parseAdminIdentity, sameAdminIdentity } from "../app/lib/admin-context";
const caps = { contract_version: "styling_demo_access_v1", mode: "local_demo", login_required: false, shared_demo: true, roles: [{ role: "consumer", entry_path: "/" }, { role: "styling-manager", entry_path: "/admin" }] };
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("demo access closed contract (controlled responses)", () => {
  it("validates demo and ordinary modes without making consumer authentication mandatory", () => {
    expect(parseDemoCapability(caps).roles).toHaveLength(2);
    expect(parseDemoCapability({ ...caps, mode: "public_demo" }).mode).toBe("public_demo");
    expect(parseDemoCapability({ ...caps, mode: "authenticated", login_required: true, shared_demo: false }).mode).toBe("authenticated");
  });
  it.each([
    { ...caps, token: "forbidden" }, { ...caps, mode: "unknown" }, { ...caps, login_required: true }, { ...caps, shared_demo: false },
    { ...caps, roles: [] }, { ...caps, roles: [caps.roles[0], caps.roles[0]] },
    { ...caps, mode: "public_demo", login_required: true }, { ...caps, mode: "public_demo", shared_demo: false },
    { ...caps, mode: "public_demo", roles: [] },
    { ...caps, roles: [{ role: "consumer", entry_path: "/admin" }, caps.roles[1]] },
    { ...caps, roles: [{ ...caps.roles[0], scope: "forbidden" }, caps.roles[1]] },
  ])("rejects inconsistent roles, paths or extra identity fields %#", value => expect(() => parseDemoCapability(value)).toThrow());
  it("GET is read-only and enter submits only role with no token/subject", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(caps)).mockResolvedValueOnce(response({ contract_version: caps.contract_version, role: "styling-manager", entry_path: "/admin" })); vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    await fetchDemoCapability(signal); await enterDemo("styling-manager", signal);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" }); expect(fetcher.mock.calls[0][1].body).toBeUndefined();
    expect(fetcher.mock.calls[1][1].body).toBe('{"role":"styling-manager"}');
  });
  it.each([response(caps, 200, { "cache-control": "public" }), response(caps, 200, { "content-type": "text/html" }), response(caps, 201), response({ ...caps, token: "secret" })])("never mounts on unverified response %#", async value => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(value)); await expect(fetchDemoCapability(new AbortController().signal)).rejects.toThrow();
  });
  it("rejects duplicate JSON keys and never echoes upstream identity details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"mode":"local_demo","mode":"authenticated"}', { headers: { "content-type": "application/json", "cache-control": "no-store" } })));
    await expect(fetchDemoCapability(new AbortController().signal)).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "DEMO_ACCESS_DISABLED", message: "private secret" } }, 403)));
    await expect(enterDemo("consumer", new AbortController().signal)).rejects.toThrow(/演示模式已关闭/);
  });
  it("rejects wrong-role or token-bearing enter acknowledgements", async () => {
    for (const body of [{ contract_version: caps.contract_version, role: "consumer", entry_path: "/" }, { contract_version: caps.contract_version, role: "styling-manager", entry_path: "/admin", token: "forbidden" }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body))); await expect(enterDemo("styling-manager", new AbortController().signal)).rejects.toThrow();
    }
  });
  it("strict me accepts only the added enum; changed auth method is a different identity", () => {
    const expires_at = new Date(Date.now() + 3600000).toISOString();
    const value = { identity_contract: "styling_admin_identity_v1", subject: "styling-demo-manager", role: "styling-manager", audience: "personal_styling", scope: "test", source_instance_id: "test", auth_method: "demo_server", approval_identity_kind: "account_bound", expires_at, authorization_context: { context_contract: "styling_admin_context_v1", context_id: "a".repeat(43), expires_at } };
    const demo = parseAdminIdentity(value)!; expect(demo).not.toBeNull();
    const normal = parseAdminIdentity({ ...value, auth_method: "password_single_account" })!; expect(sameAdminIdentity(demo, normal)).toBe(false);
    expect(parseAdminIdentity({ ...value, auth_method: "untrusted" })).toBeNull(); expect(parseAdminIdentity({ ...value, token: "extra" })).toBeNull();
  });
});
