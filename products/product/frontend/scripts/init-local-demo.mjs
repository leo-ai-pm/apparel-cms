import { randomBytes, scryptSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const args = process.argv.slice(2);
function option(name, fallback) { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; }
const directory = option("--directory", path.join(homedir(), ".local/share/product-agent-demo"));
if (!directory || !path.isAbsolute(directory)) throw new Error("A private absolute directory is required");
const origin = option("--origin", "http://localhost:3000"), backend = option("--backend-url", "http://127.0.0.1:8000");
for (const value of [origin, backend]) { const u = new URL(value); if (u.origin !== value || u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error("Explicit local origins required"); }
mkdirSync(directory, { recursive: true, mode: 0o700 });
const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Private directory permissions required");
const marker = path.join(directory, "demo-init.json");
if (existsSync(marker)) {
  const meta = JSON.parse(readFileSync(marker, "utf8"));
  if (meta.owner !== "product-agent-local-demo/1" || meta.origin !== origin || meta.backend !== backend) throw new Error("Existing initializer ownership/configuration differs; no files overwritten");
  console.log(JSON.stringify({ initialized: true, reused: true, directory })); process.exit(0);
}
const names = ["next-config.json", "next-runtime-env.json", "python-config.json", "python-runtime-env.json", "normal-accounts.json", "users.sqlite", "cases.sqlite", "intake.sqlite", "reasoning.sqlite", "demo-access.sqlite"];
if (names.some(name => existsSync(path.join(directory, name)))) throw new Error("Existing configuration/database detected; no initialization or overwrite");
const secret = () => randomBytes(32).toString("base64url");
const passwordHash = password => { const salt = randomBytes(16).toString("hex"); return salt + ":" + scryptSync(password, salt, 64).toString("hex"); };
const accounts = { staff: { username: "product-staff-test", password: secret() }, manager: { username: "product-manager-test", password: secret() } };
const reader = secret(), instance = "product-demo-local", scope = "product-demo-local";
const write = (name, value) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
write("next-config.json", { instance_id: instance, authorized_scope: scope, origin, design_instance_id: "design-demo-local", backend_url: backend, backend_reader_token: reader, services: [] });
write("next-runtime-env.json", { WORKBENCH_CONFIG_FILE: path.join(directory, "next-config.json"), WORKBENCH_USERS_DB: path.join(directory, "users.sqlite"), WORKBENCH_CASES_DB: path.join(directory, "cases.sqlite"), WORKBENCH_REASONING_DB: path.join(directory, "reasoning.sqlite"), WORKBENCH_DEMO_SESSIONS_DB: path.join(directory, "demo-access.sqlite"), WORKBENCH_STAFF_USERNAME: accounts.staff.username, WORKBENCH_MANAGER_USERNAME: accounts.manager.username, WORKBENCH_STAFF_PASSWORD_HASH: passwordHash(accounts.staff.password), WORKBENCH_MANAGER_PASSWORD_HASH: passwordHash(accounts.manager.password), WORKBENCH_SESSION_SECRET: secret(), WORKBENCH_DEMO_ACCESS: "true", NEXT_TELEMETRY_DISABLED: "1" });
write("python-config.json", { config_version: 1, instance_id: instance, authorized_scope: scope, allow_loopback_http: true, services: [{ subject: "product-workbench-demo-reader", purpose: "product_workbench_reader", source_instance_id: instance, target_instance_id: instance, authorized_scope: scope, token_sha256: createHash("sha256").update(reader).digest("hex"), enabled: true }] });
write("python-runtime-env.json", { PARTNER_MODE: "managed", PARTNER_CONFIG_FILE: path.join(directory, "python-config.json"), PARTNER_DB_PATH: path.join(directory, "intake.sqlite") });
write("normal-accounts.json", accounts);
write("demo-init.json", { owner: "product-agent-local-demo/1", origin, backend, created_at: new Date().toISOString() });
console.log(JSON.stringify({ initialized: true, reused: false, directory, staff_entry: origin + "/demo/staff", manager_entry: origin + "/demo/manager", business_seeded: false }));
