// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
let directory: string;
const script = fileURLToPath(new URL("../scripts/init-local-demo.mjs", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [script, "--directory", directory, ...args], { encoding: "utf8" });
const read = (name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "pa-init-test-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
describe("portable private initialization without business seed", () => {
  it("new clone initializes matched product reader config, private accounts and no DB or secret output", () => {
    const result = run(); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).business_seeded).toBe(false);
    const env = read("next-runtime-env.json"), config = read("next-config.json"), python = read("python-config.json"), pythonEnv = read("python-runtime-env.json"), accounts = read("normal-accounts.json");
    expect(env.WORKBENCH_DEMO_ACCESS).toBe("true"); expect(config.services).toEqual([]);
    expect(python.services[0]).toMatchObject({ purpose: "product_workbench_reader", source_instance_id: config.instance_id, target_instance_id: config.instance_id, authorized_scope: config.authorized_scope, token_sha256: createHash("sha256").update(config.backend_reader_token).digest("hex") });
    expect(pythonEnv.PARTNER_DB_PATH).toBe(join(directory, "intake.sqlite"));
    for (const name of readdirSync(directory)) { expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600); expect(name).not.toMatch(/sqlite|\.env/); }
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    for (const secret of [env.WORKBENCH_SESSION_SECRET, config.backend_reader_token, accounts.staff.password, accounts.manager.password]) expect(result.stdout + result.stderr).not.toContain(secret);
    expect(env.WORKBENCH_STAFF_USERNAME).toBe("product-staff-test"); expect(env.WORKBENCH_MANAGER_USERNAME).toBe("product-manager-test");
  });
  it("rerun keeps every credential byte and refuses origin changes", () => {
    expect(run().status).toBe(0); const before = readdirSync(directory).map(name => [name, readFileSync(join(directory, name))] as const);
    expect(JSON.parse(run().stdout).reused).toBe(true); expect(run("--origin", "http://localhost:3001").status).not.toBe(0);
    for (const [name, bytes] of before) expect(readFileSync(join(directory, name))).toEqual(bytes);
  });
  it.each(["users.sqlite", "cases.sqlite", "intake.sqlite", "reasoning.sqlite", "next-config.json"])("refuses existing %s without overwriting", name => {
    writeFileSync(join(directory, name), "keep-original", { mode: 0o600 }); expect(run().status).not.toBe(0);
    expect(readFileSync(join(directory, name), "utf8")).toBe("keep-original"); expect(existsSync(join(directory, "demo-init.json"))).toBe(false);
  });
  it("rejects remote origin and public directory", () => {
    expect(run("--origin", "https://public.example.test").status).not.toBe(0); expect(readdirSync(directory)).toEqual([]);
    chmodSync(directory, 0o755); expect(run().status).not.toBe(0); expect(readdirSync(directory)).toEqual([]);
  });
  it("test oracle is repo-relative and absent from all runtime source", () => {
    const test = readFileSync(new URL("./reasoning-rules.test.ts", import.meta.url), "utf8");
    expect(test).toContain('new URL("./fixtures/reasoning-expected-v1.json", import.meta.url)'); expect(test).not.toContain("/Users/");
    const expected = readFileSync(new URL("./fixtures/reasoning-expected-v1.json", import.meta.url));
    expect(createHash("sha256").update(expected).digest("hex")).toBe("a413bda6e22f1844425ad6f53a34c13ed1b244241632d289ed74900edd970346");
    for (const folder of ["../lib/", "../app/"]) {
      const base = fileURLToPath(new URL(folder, import.meta.url));
      for (const name of readdirSync(base, { recursive: true, encoding: "utf8" })) {
        if (!/\.(tsx?|mjs)$/.test(name)) continue;
        expect(readFileSync(join(base, name), "utf8"), name).not.toMatch(/reasoning-expected-v1|expected_cluster_id|expected_priority/);
      }
    }
  });
});
