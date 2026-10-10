import { cp, mkdir } from "node:fs/promises";

const dist = process.env.NEXT_DIST_DIR ?? ".next";
await mkdir(`${dist}/standalone/${dist}`, { recursive: true });
await cp("public", `${dist}/standalone/public`, { recursive: true });
await cp(`${dist}/static`, `${dist}/standalone/${dist}/static`, { recursive: true });
console.log("Standalone static assets prepared.");
