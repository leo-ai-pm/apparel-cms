import { failure, body } from "./partner-http";
import { ensure } from "./reasoning-rules";
export { body };
export function reasoningJson(value: unknown, status = 200) { ensure(Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024 * 1024, "TOO_LARGE", 413, "响应过大，请缩小查询"); return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } }); }
export function reasoningFailure(error: unknown) { const response = failure(error); response.headers.set("Cache-Control", "private, no-store"); return response; }
