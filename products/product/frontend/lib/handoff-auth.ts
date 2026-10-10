import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { NextRequest } from "next/server";
import { object, parseStrictJson, ProtocolError } from "./partner-protocol";

export type ServicePurpose = "design_package_reader" | "design_event_writer";
export type AuthorizedService = {
  subject: string; purpose: string; source_instance_id: string; target_instance_id: string; authorized_scope: string;
};
type ConfiguredService = AuthorizedService & { token: string };
export type PartnerConfig = {
  instance_id: string; authorized_scope: string; design_instance_id: string; services: ConfiguredService[];
  origin?: string; backend_url?: string; backend_reader_token?: string;
  design_asset_base_url?: string; design_asset_path?: string; design_asset_reader_token?: string;
  [key: string]: unknown;
};

function configuredString(value: unknown, max = 180): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

/** Server-only configuration. Never serialize this object into a user response. Reread for revocation. */
export function readPartnerConfig(): PartnerConfig {
  try {
    const file = process.env.WORKBENCH_CONFIG_FILE;
    if (!file || !isAbsolute(file)) throw new Error();
    const info = statSync(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 256 * 1024) throw new Error();
    const config = object(parseStrictJson(readFileSync(file), 256 * 1024));
    if (![config.instance_id, config.authorized_scope, config.design_instance_id].every(v => configuredString(v))) throw new Error();
    if (!Array.isArray(config.services)) throw new Error();
    const identities = new Set<string>();
    for (const entry of config.services) {
      const service = object(entry);
      const keys = ["subject", "purpose", "source_instance_id", "target_instance_id", "authorized_scope", "token"];
      if (Object.keys(service).length !== keys.length || !keys.every(key => Object.hasOwn(service, key))) throw new Error();
      if (!keys.filter(key => key !== "token").every(key => configuredString(service[key]))) throw new Error();
      if (!configuredString(service.token, 4096) || service.token.length < 32 || /\s/.test(service.token)) throw new Error();
      const identity = `${service.subject}\0${service.purpose}`;
      if (identities.has(identity)) throw new Error();
      identities.add(identity);
      if (["design_package_reader", "design_event_writer"].includes(service.purpose as string)) {
        // Service fields describe the HTTP caller -> receiving product, even when package data flows back.
        if (service.source_instance_id !== config.design_instance_id || service.target_instance_id !== config.instance_id || service.authorized_scope !== config.authorized_scope) throw new Error();
      }
    }
    return config as PartnerConfig;
  } catch {
    throw new ProtocolError("NOT_CONFIGURED", 503, "服务配对配置不可用");
  }
}

export function authorizeService(request: Pick<Request, "headers">, purpose: ServicePurpose): AuthorizedService {
  if (request.headers.has("x-workbench-demo-role") || /(?:^|;\s*)(?:zhixu_session|zhixu_demo_staff|zhixu_demo_manager)=/.test(request.headers.get("cookie") ?? "")) throw new ProtocolError("AUTH_IDENTITY_CONFLICT", 403, "人员身份不能调用服务交接接口");
  const config = readPartnerConfig();
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s,]+)$/.exec(header);
  if (!match) throw new ProtocolError("UNAUTHORIZED", 401, "服务身份无效");
  const supplied = createHash("sha256").update(match[1]).digest();
  const matches = config.services.filter(service => timingSafeEqual(supplied, createHash("sha256").update(service.token).digest()));
  if (!matches.length) throw new ProtocolError("UNAUTHORIZED", 401, "服务身份无效");
  const allowed = matches.filter(service => service.purpose === purpose);
  if (allowed.length !== 1) throw new ProtocolError("FORBIDDEN", 403, "服务用途不允许");
  const { token: _token, ...identity } = allowed[0];
  void _token;
  return identity;
}

/** Historical X-Handoff-Key flow is disabled whenever new managed configuration is selected. */
export function serviceAuthorized(request: NextRequest) {
  if (process.env.WORKBENCH_CONFIG_FILE) return false;
  const expected = process.env.DESIGN_HANDOFF_KEY || "";
  const supplied = request.headers.get("x-handoff-key") || "";
  if (expected.length < 32 || !supplied) return false;
  return timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(supplied).digest());
}
