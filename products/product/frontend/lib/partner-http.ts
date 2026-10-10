import { randomUUID } from "node:crypto";
import { WorkbenchError } from "./partner-workflow";
export function json(value: unknown, status = 200) { if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024)
    throw new WorkbenchError("TOO_LARGE", "响应超过列表容量，请缩小查询范围", 413); return Response.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
export function failure(error: unknown) {
    const e = error as {
        code?: string;
        status?: number;
        statusCode?: number;
        message?: string;
        retryable?: boolean;
    };
    const status = e.status ?? e.statusCode ?? 500;
    const known = Number.isInteger(status) && status >= 400 && status <= 599 && typeof e.code === "string";
    return json({ error: { code: known ? e.code : "INTERNAL_ERROR", message: known ? e.message : "服务暂时不可用", retryable: known ? Boolean(e.retryable) : true }, request_id: randomUUID() }, known ? status : 500);
}
export async function body(request: Request, max = 2 * 1024 * 1024) {
    if (Number(request.headers.get("content-length")) > max)
        throw new WorkbenchError("TOO_LARGE", "请求过大", 413);
    const reader = request.body?.getReader();
    if (!reader)
        throw new WorkbenchError("INVALID_INPUT", "缺少请求正文");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.length;
        if (size > max) {
            await reader.cancel();
            throw new WorkbenchError("TOO_LARGE", "请求过大", 413);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}
