import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env.local");
const credentialsPath = resolve(root, ".local-login-credentials.txt");
let existing = "";
try { existing = readFileSync(envPath, "utf8"); } catch { /* first setup */ }
existing = existing.split("\n").filter((line) => !/^WORKBENCH_(SESSION_SECRET|STAFF_USERNAME|STAFF_PASSWORD_HASH|MANAGER_USERNAME|MANAGER_PASSWORD_HASH)=/.test(line)).join("\n").trimEnd();

const password = () => randomBytes(15).toString("base64url");
const hash = (value) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
};
const staffPassword = password();
const managerPassword = password();
const env = [
  `WORKBENCH_SESSION_SECRET=${randomBytes(32).toString("hex")}`,
  "WORKBENCH_STAFF_USERNAME=product",
  `WORKBENCH_STAFF_PASSWORD_HASH=${hash(staffPassword)}`,
  "WORKBENCH_MANAGER_USERNAME=manager",
  `WORKBENCH_MANAGER_PASSWORD_HASH=${hash(managerPassword)}`,
].join("\n");
writeFileSync(envPath, `${existing}\n${env}\n`, { mode: 0o600 });
chmodSync(envPath, 0o600);
writeFileSync(credentialsPath, `知需本机登录账号（请勿分享）\n\n产品人员\n账号：product\n密码：${staffPassword}\n\n产品负责人\n账号：manager\n密码：${managerPassword}\n\n重新运行配置脚本会更换密码并使已有登录失效。\n`, { mode: 0o600 });
chmodSync(credentialsPath, 0o600);
process.stdout.write(`已配置两个本机账号。请在 ${credentialsPath} 查看登录信息。\n`);
