import { readFileSync, lstatSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const frontend = path.dirname(path.dirname(fileURLToPath(import.meta.url))), mode = process.argv[2];
if (!["next", "python"].includes(mode)) throw new Error("Use run-local.mjs next|python [--directory private-path]");
const at = process.argv.indexOf("--directory"), directory = at < 0 ? path.join(homedir(), ".local/share/product-agent-demo") : process.argv[at + 1];
if (!directory || !path.isAbsolute(directory)) throw new Error("Private absolute directory required");
function privateJson(name) { const file = path.join(directory, name), stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("Private configuration file required"); return JSON.parse(readFileSync(file, "utf8")); }
const meta = privateJson("demo-init.json"); if (meta.owner !== "product-agent-local-demo/1") throw new Error("Initializer ownership mismatch");
const variables = privateJson(mode === "next" ? "next-runtime-env.json" : "python-runtime-env.json");
if (!Object.keys(variables).every(key => mode === "next" ? key.startsWith("WORKBENCH_") || key === "NEXT_TELEMETRY_DISABLED" : key.startsWith("PARTNER_"))) throw new Error("Unexpected configuration variables");
const env = Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR", "SYSTEMROOT"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])); Object.assign(env, variables);
if (mode === "next") {
  const flag = process.env.WORKBENCH_DEMO_ACCESS ?? variables.WORKBENCH_DEMO_ACCESS;
  if (flag !== "true" && flag !== "false") throw new Error("WORKBENCH_DEMO_ACCESS must be true or false");
  env.WORKBENCH_DEMO_ACCESS = flag; env.NODE_ENV = "production";
}
const backend = path.join(frontend, "../backend"), python = path.join(backend, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
if (mode === "python" && !existsSync(python)) throw new Error("Install backend/.venv from requirements.txt first");
const port = String(new URL(mode === "next" ? meta.origin : meta.backend).port || "80");
const child = mode === "next" ? spawn(process.execPath, [path.join(frontend, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", port], { cwd: frontend, env, stdio: "inherit" }) : spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", port], { cwd: backend, env, stdio: "inherit" });
for (const event of ["SIGINT", "SIGTERM"]) process.on(event, () => child.kill(event));
child.on("exit", (code) => process.exit(code ?? 1));
