import { spawn } from "node:child_process";

const server = spawn(process.execPath, [`${process.env.NEXT_DIST_DIR ?? ".next"}/standalone/server.js`], {
  stdio: "inherit",
  env: { ...process.env, HOSTNAME: process.env.HOSTNAME ?? "0.0.0.0", PORT: process.env.PORT ?? "3010" },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
server.on("error", () => { console.error("预览启动失败，请先运行 npm run build。"); process.exitCode = 1; });
server.on("exit", (code) => { process.exitCode = code ?? 0; });
