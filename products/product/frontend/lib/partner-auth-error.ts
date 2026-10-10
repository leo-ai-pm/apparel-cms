import { randomUUID } from "node:crypto";

export class AuthError extends Error {
  constructor(public code: string, message: string, public status = 403, public retryable = false) {
    super(message);
    this.name = "AuthError";
  }
}

export function authErrorResponse(error: unknown): Response {
  const safe = error instanceof AuthError ? error : new AuthError("STORAGE_UNAVAILABLE", "身份服务暂时不可用，请稍后重试。", 503, true);
  return Response.json({ error: { code: safe.code, message: safe.message, retryable: safe.retryable }, request_id: randomUUID() },
    { status: safe.status, headers: { "Cache-Control": "no-store" } });
}
