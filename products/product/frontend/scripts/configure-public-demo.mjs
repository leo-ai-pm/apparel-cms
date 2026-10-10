import { randomBytes, scryptSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const origin = option("--origin", "https://s357brv8j8f9gdhvbu9a9.apigateway-cn-beijing.volceapi.com");
const data = option("--data-dir", "/srv/contest/data/three-agent-public-20261010/product");
const config = option("--config-dir", "/srv/contest/secrets/three-agent-public-20261010/product");
const secretsFile = option("--secrets-file");
const url = new URL(origin);
if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Exact public HTTPS origin required");
if (![data, config, secretsFile].every(v => typeof v === "string" && path.isAbsolute(v)) || data === config) throw new Error("Separate private absolute directories and secrets file required");
const info = lstatSync(secretsFile);
if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 65536) throw new Error("Private secrets input required");
const keys = ["session_secret", "product_workbench_reader", "styling_sender", "styling_product_verifier", "design_package_reader", "design_event_writer", "design_asset_reader"];
const bytes = readFileSync(secretsFile), secrets = JSON.parse(bytes.toString("utf8"));
if (!secrets || Object.keys(secrets).length !== keys.length || !keys.every(key => /^[A-Za-z0-9_-]{32,256}$/.test(secrets[key] ?? "")) || new Set(Object.values(secrets)).size !== keys.length) throw new Error("Seven distinct private keys required");
for (const directory of [data, config]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); const s = lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077)) throw new Error("Private directory permissions required");
}
const identity = { owner: "product-public-demo/1", origin, data, config, secret_input_sha256: createHash("sha256").update(bytes).digest("hex") };
const marker = path.join(config, "public-init.json");
if (existsSync(marker)) {
  if (JSON.stringify(JSON.parse(readFileSync(marker, "utf8"))) !== JSON.stringify(identity)) throw new Error("Existing public configuration differs; never overwrite");
  console.log(JSON.stringify({ configured: true, reused: true, config_directory: config, data_directory: data })); process.exit(0);
}
if (readdirSync(data).length || readdirSync(config).length) throw new Error("Fresh empty public directories required; no original data overwritten");
const instance = "product-public-20261010", scope = "public-three-agent-20261010", styling = "styling-public-20261010", design = "design-public-20261010";
const hash = token => createHash("sha256").update(token).digest("hex");
const write = (name, value) => writeFileSync(path.join(config, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const passwordHash = password => { const salt = randomBytes(16).toString("hex"); return salt + ":" + scryptSync(password, salt, 64).toString("hex"); };
const accounts = { staff: { username: "product-public-staff", password: randomBytes(32).toString("base64url") }, manager: { username: "product-public-manager", password: randomBytes(32).toString("base64url") } };
write("next-config.json", { instance_id: instance, authorized_scope: scope, origin, design_instance_id: design, backend_url: "http://127.0.0.1:8191", backend_reader_token: secrets.product_workbench_reader, design_asset_base_url: "http://127.0.0.1:8192", design_asset_reader_token: secrets.design_asset_reader, services: [
  { subject: "design-public-package-reader", purpose: "design_package_reader", source_instance_id: design, target_instance_id: instance, authorized_scope: scope, token: secrets.design_package_reader },
  { subject: "design-public-event-writer", purpose: "design_event_writer", source_instance_id: design, target_instance_id: instance, authorized_scope: scope, token: secrets.design_event_writer },
] });
write("next-runtime-env.json", { WORKBENCH_CONFIG_FILE: path.join(config, "next-config.json"), WORKBENCH_USERS_DB: path.join(data, "users.sqlite"), WORKBENCH_CASES_DB: path.join(data, "cases.sqlite"), WORKBENCH_INTAKE_DB: path.join(data, "intake.sqlite"), WORKBENCH_REASONING_DB: path.join(data, "reasoning.sqlite"), WORKBENCH_DEMO_SESSIONS_DB: path.join(data, "demo-access.sqlite"), WORKBENCH_STAFF_USERNAME: accounts.staff.username, WORKBENCH_MANAGER_USERNAME: accounts.manager.username, WORKBENCH_STAFF_PASSWORD_HASH: passwordHash(accounts.staff.password), WORKBENCH_MANAGER_PASSWORD_HASH: passwordHash(accounts.manager.password), WORKBENCH_SESSION_SECRET: secrets.session_secret, WORKBENCH_DEMO_ACCESS: "true", WORKBENCH_DEMO_ACCESS_MODE: "public", WORKBENCH_DEMO_PUBLIC_ORIGIN: origin, NEXT_PUBLIC_BASE_PATH: "/v2/product", NEXT_TELEMETRY_DISABLED: "1" });
write("python-config.json", { config_version: 1, instance_id: instance, authorized_scope: scope, allow_loopback_http: true, services: [
  { subject: "product-public-workbench-reader", purpose: "product_workbench_reader", source_instance_id: instance, target_instance_id: instance, authorized_scope: scope, token_sha256: hash(secrets.product_workbench_reader), enabled: true },
  { subject: "styling-public-sender", purpose: "styling_sender", source_instance_id: styling, target_instance_id: instance, authorized_scope: scope, token_sha256: hash(secrets.styling_sender), enabled: true, operations: ["deliver", "lookup", "supplement"], verification: { subject: "product-public-verifier", purpose: "product_verifier", source_instance_id: styling, target_instance_id: instance, authorized_scope: scope, base_url: "http://127.0.0.1:8190", token: secrets.styling_product_verifier } },
] });
write("python-runtime-env.json", { PARTNER_MODE: "managed", PARTNER_CONFIG_FILE: path.join(config, "python-config.json"), PARTNER_DB_PATH: path.join(data, "intake.sqlite") });
write("normal-accounts.json", accounts); write("public-init.json", identity);
console.log(JSON.stringify({ configured: true, reused: false, config_directory: config, data_directory: data, business_seeded: false, python_required: true, staff_entry: origin + "/v2/product/demo/staff", manager_entry: origin + "/v2/product/demo/manager" }));
