/* eslint-disable @typescript-eslint/no-require-imports -- Private maintenance must load existing server TS modules via a CommonJS transpilation hook. */
// Server maintenance only. Use Node24 --conditions=react-server; no business rows or sessions seeded.
const fs = require("node:fs"), path = require("node:path"), ts = require("typescript");
const at = process.argv.indexOf("--env-file"), file = process.argv[at + 1];
if (at < 0 || !path.isAbsolute(file || "")) throw new Error("Private --env-file required");
const info = fs.lstatSync(file);
if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error("Private environment JSON required");
const env = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Object.entries(env).every(([key, value]) => (key.startsWith("WORKBENCH_") || ["NEXT_PUBLIC_BASE_PATH", "NEXT_TELEMETRY_DISABLED"].includes(key)) && typeof value === "string")) throw new Error("Unexpected environment fields");
Object.assign(process.env, env);
// Next supplies the server-only marker via its compiler alias rather than a root dependency.
// This private server maintenance entry uses the same bundled empty server marker.
const Module = require("node:module"), resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) { return resolve.call(this, name === "server-only" ? "next/dist/compiled/server-only/empty" : name, ...args); };
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const state = require("../lib/demo-access-store.ts").demoAccessState();
if (!state.enabled || process.env.WORKBENCH_DEMO_ACCESS_MODE !== "public") throw new Error("Only explicit public initialization supported");
require("../lib/users-db.ts").withIdentityDb(() => undefined);
require("../lib/partner-store.ts").partnerDatabase();
require("../lib/reasoning-store.ts").withReasoningDb(() => undefined);
console.log(JSON.stringify({ initialized: true, instance: "product-public-20261010", scope: "public-three-agent-20261010", node_databases: 4, business_seeded: false, next_python_step: "Initialize intake via backend/scripts/init_public_database.py and python-runtime-env.json" }));
