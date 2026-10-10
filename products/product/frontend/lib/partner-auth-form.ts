import { AuthError } from "./partner-auth-error";

export async function readAuthForm(request: Request, allowed: readonly string[]): Promise<FormData> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("application/x-www-form-urlencoded") && !contentType.startsWith("multipart/form-data;"))
    throw new AuthError("INVALID_INPUT", "请使用登录或注册表单。", 422);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) throw new AuthError("INVALID_INPUT", "表单内容缺失。", 422);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new AuthError("INPUT_TOO_LARGE", "表单内容超过限制。", 413); }
    chunks.push(value);
  }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new AuthError("INVALID_INPUT", "表单格式不正确。", 422); }
  const seen = new Set<string>();
  for (const [key, value] of form) {
    if (!allowed.includes(key) || seen.has(key) || typeof value !== "string") throw new AuthError("INVALID_INPUT", "表单字段不正确。", 422);
    seen.add(key);
  }
  return form;
}
