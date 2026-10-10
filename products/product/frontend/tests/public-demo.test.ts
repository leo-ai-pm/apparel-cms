// @vitest-environment node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoAccessState } from "@/lib/demo-access-store";
import { hashPassword, requirePerson, recheckPerson, sessionCookieOptions, sameHostUrl } from "@/lib/auth";
import { GET as me } from "@/app/api/auth/me/route";
import { GET as entry } from "@/app/api/auth/demo/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as sample } from "@/app/api/workbench/reasoning/sample/route";
vi.mock("server-only", () => ({}));
const origin = "https://public-product.example.test", prefix = "/v2/product";
let folder: string, config: Record<string, unknown>, configFile: string;
const request = (role = "staff", cookie = "", method = "GET") => new NextRequest(origin + prefix + "/api/auth/me", { method, headers: { "X-Workbench-Demo-Role": role, ...(cookie ? { cookie } : {}) } });
function rewrite() { writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 }); }
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "pa-public-auth-")); configFile = join(folder, "config.json");
  config = { instance_id: "product-public-20261010", authorized_scope: "public-three-agent-20261010", origin }; rewrite();
  const env = { WORKBENCH_CONFIG_FILE: configFile, WORKBENCH_USERS_DB: join(folder, "users.sqlite"), WORKBENCH_CASES_DB: join(folder, "cases.sqlite"), WORKBENCH_REASONING_DB: join(folder, "reasoning.sqlite"), WORKBENCH_DEMO_SESSIONS_DB: join(folder, "demo.sqlite"), WORKBENCH_STAFF_USERNAME: "product-public-staff", WORKBENCH_MANAGER_USERNAME: "product-public-manager", WORKBENCH_STAFF_PASSWORD_HASH: hashPassword("isolated-public-password"), WORKBENCH_MANAGER_PASSWORD_HASH: hashPassword("isolated-public-password"), WORKBENCH_SESSION_SECRET: randomBytes(32).toString("hex"), WORKBENCH_STAFF_ENABLED: "true", WORKBENCH_MANAGER_ENABLED: "true", WORKBENCH_DEMO_ACCESS: "true", WORKBENCH_DEMO_ACCESS_MODE: "public", WORKBENCH_DEMO_PUBLIC_ORIGIN: origin, NEXT_PUBLIC_BASE_PATH: prefix };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(folder, { recursive: true, force: true }); });

describe("explicit exact HTTPS public demo with independent scope", () => {
  it.each(["staff", "manager"])("bootstraps %s with Secure prefix cookie and actual public identity", async role => {
    const response = me(request(role)); expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Path=/v2/product;"); expect(response.headers.get("set-cookie")).toContain("; Secure"); expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const person = await response.json(); expect(person.context).toMatchObject({ subject: "product-public-" + role, instance_id: "product-public-20261010", scope: "public-three-agent-20261010" });
    const landing = entry(new NextRequest(origin + prefix + "/api/auth/demo?demo_role=" + role)); expect(landing.headers.get("location")).toBe(origin + prefix + "/workbench?demo_role=" + role);
    expect(person.access).toEqual({ mode: "demo", synthetic_identity: true, role });
  });
  it.each([undefined, "local", "bad"])("%s mode does not relax default localhost guard", mode => {
    vi.stubEnv("WORKBENCH_DEMO_ACCESS_MODE", mode); expect(demoAccessState).toThrowError(expect.objectContaining({ code: "DEMO_NOT_CONFIGURED" }));
  });
  it.each(["missing_origin", "wrong_origin", "http", "scope", "instance", "prefix", "wildcard"])("rejects public configuration %s", kind => {
    if (kind === "missing_origin") vi.stubEnv("WORKBENCH_DEMO_PUBLIC_ORIGIN", undefined);
    if (kind === "wrong_origin") vi.stubEnv("WORKBENCH_DEMO_PUBLIC_ORIGIN", "https://other.example.test");
    if (kind === "wildcard") vi.stubEnv("WORKBENCH_DEMO_PUBLIC_ORIGIN", "https://*.example.test");
    if (kind === "http") { config.origin = "http://localhost:3191"; vi.stubEnv("WORKBENCH_DEMO_PUBLIC_ORIGIN", String(config.origin)); }
    if (kind === "scope") config.authorized_scope = "old-private-scope";
    if (kind === "instance") config.instance_id = "product-partner-20261010";
    if (kind === "prefix") vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/product"); rewrite();
    expect(demoAccessState).toThrowError(expect.objectContaining({ code: "DEMO_NOT_CONFIGURED" }));
  });
  it("both role cookies remain independent and exact external Origin/CSRF still guard writes", async () => {
    const staffResponse = me(request()), managerResponse = me(request("manager"));
    const staff = await staffResponse.json(), manager = await managerResponse.json();
    const cookie = [staffResponse, managerResponse].map(r => r.headers.get("set-cookie")!.split(";")[0]).join("; ");
    expect(requirePerson(request("staff", cookie)).context).toEqual(staff.context); expect(requirePerson(request("manager", cookie)).context).toEqual(manager.context);
    const writing = request("staff", cookie, "POST"); writing.headers.set("Origin", "https://other.example.test"); writing.headers.set("X-CSRF-Token", staff.csrf_token);
    expect((await logout(writing)).status).toBe(403); writing.headers.set("Origin", origin); writing.headers.delete("X-CSRF-Token"); expect((await logout(writing)).status).toBe(403);
    expect(recheckPerson(manager).context).toEqual(manager.context);
    vi.stubEnv("WORKBENCH_DEMO_ACCESS", "false"); expect(() => recheckPerson(staff)).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });
  it("manager can read 12 marked public test inputs without seeding any business task", async () => {
    const response = me(request("manager")), cookie = response.headers.get("set-cookie")!.split(";")[0];
    const info = await sample(request("manager", cookie)).json(); const batch = JSON.parse(Buffer.from(info.input_base64, "base64").toString());
    expect(batch.items).toHaveLength(12); expect(batch.test_data).toBe(true);
    expect(sample(request("staff", me(request()).headers.get("set-cookie")!.split(";")[0])).status).toBe(403);
    expect(sessionCookieOptions.path).toBe(prefix); expect(sameHostUrl(request(), "/workbench").href).toBe(origin + prefix + "/workbench");
  });
});

describe("private public configuration and real Node owned initialization", () => {
  it("generates paired configs, initializes four empty owned DBs, and never outputs a secret", () => {
    const keys = ["session_secret", "product_workbench_reader", "styling_sender", "styling_product_verifier", "design_package_reader", "design_event_writer", "design_asset_reader"];
    const secrets = Object.fromEntries(keys.map(k => [k, randomBytes(32).toString("hex")])); const file = join(folder, "secrets.json"); writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const configDir = join(folder, "public-config"), dataDir = join(folder, "public-data"), script = fileURLToPath(new URL("../scripts/configure-public-demo.mjs", import.meta.url));
    const args = [script, "--origin", origin, "--data-dir", dataDir, "--config-dir", configDir, "--secrets-file", file];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" }); expect(result.status, result.stderr).toBe(0);
    for (const secret of Object.values(secrets)) expect(result.stdout + result.stderr).not.toContain(secret);
    const nextConfig = JSON.parse(readFileSync(join(configDir, "next-config.json"), "utf8")), python = JSON.parse(readFileSync(join(configDir, "python-config.json"), "utf8"));
    expect(nextConfig.backend_url).toBe("http://127.0.0.1:8191"); expect(nextConfig.services.map((s: { purpose: string }) => s.purpose)).toEqual(["design_package_reader", "design_event_writer"]);
    expect(python.services[1].verification.base_url).toBe("http://127.0.0.1:8190");
    const initScript = fileURLToPath(new URL("../scripts/init-public-databases.cjs", import.meta.url));
    const init = spawnSync(process.execPath, ["--conditions=react-server", initScript, "--env-file", join(configDir, "next-runtime-env.json")], { encoding: "utf8" }); expect(init.status, init.stderr).toBe(0);
    for (const [name, table] of [["users.sqlite", "users"], ["cases.sqlite", "partner_cases"], ["reasoning.sqlite", "pmr_tasks"], ["demo-access.sqlite", "demo_sessions"]]) {
      const db = new DatabaseSync(join(dataDir, name), { readOnly: true }); expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0); db.close();
    }
    const before = readFileSync(join(configDir, "next-runtime-env.json")); expect(spawnSync(process.execPath, args).status).toBe(0); expect(readFileSync(join(configDir, "next-runtime-env.json"))).toEqual(before);
    args[args.indexOf(origin)] = "https://changed.example.test"; expect(spawnSync(process.execPath, args).status).not.toBe(0); expect(readFileSync(join(configDir, "next-runtime-env.json"))).toEqual(before);
  });
});
