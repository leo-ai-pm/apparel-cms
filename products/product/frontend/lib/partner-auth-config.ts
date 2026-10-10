import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { AuthError } from "./partner-auth-error";

export type AuthConfig = { instance_id: string; authorized_scope: string; origin: string };
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/;
function invalid(): never { throw new AuthError("NOT_CONFIGURED", "人员身份配置不可用，请联系维护人员。", 503); }

function parseUnique(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
  let offset = 0;
  const visit = (depth: number) => {
    if (depth > 40) invalid();
    const token = tokens[offset++];
    if (token === "{") {
      const seen = new Set<string>();
      while (tokens[offset] !== "}") {
        const key = JSON.parse(tokens[offset++]) as string;
        if (seen.has(key)) invalid();
        seen.add(key); offset++; visit(depth + 1);
        if (tokens[offset] !== ",") break;
        offset++;
      }
      offset++;
    } else if (token === "[") {
      while (tokens[offset] !== "]") {
        visit(depth + 1);
        if (tokens[offset] !== ",") break;
        offset++;
      }
      offset++;
    }
  };
  visit(0);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  return parsed;
}

export function readAuthConfig(): AuthConfig {
  try {
    const file = process.env.WORKBENCH_CONFIG_FILE || "";
    if (!path.isAbsolute(file)) invalid();
    const stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536) invalid();
    const data = parseUnique(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)));
    const { instance_id, authorized_scope, origin } = data;
    if (typeof instance_id !== "string" || !identifier.test(instance_id)
      || typeof authorized_scope !== "string" || !identifier.test(authorized_scope) || typeof origin !== "string") invalid();
    const url = new URL(origin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
    if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) invalid();
    return { instance_id, authorized_scope, origin };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    invalid();
  }
}
