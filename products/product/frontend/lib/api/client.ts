import { appPath } from "@/lib/app-path";

const messages: Record<string, string> = {
  NO_API_KEY: "数据源连接尚未配置，请联系维护人员。",
  CMS_UNREACHABLE: "暂时无法连接穿搭型号数据源，请稍后重试。已保存的草稿仍然保留。",
  CMS_ERROR: "数据后台未接受本次请求，请核对信号后重试。",
  DRAFT_NOT_FOUND: "草稿不存在或已经回传，请刷新列表查看最新记录。",
  PACKAGE_NOT_FOUND: "未找到这份证据包，请刷新列表后重试。",
  INVALID_INPUT: "提交内容不完整，请检查需求描述和约束。",
};

export class ApiError extends Error {
  constructor(public code: string, message: string, public retryable = true) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "暂时无法完成操作，请稍后重试。";
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalidResponse(): never {
  throw new ApiError("INVALID_RESPONSE", "返回的数据不完整，请刷新后重试。");
}

export async function request<T>(path: string, parse: (value: unknown) => T, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  // 后端 CMS 最多三次 10 秒请求；浏览器等待需覆盖这段时间。
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(appPath(`/api${path}`), {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      cache: "no-store",
      signal: controller.signal,
    });
    let data: unknown;
    try { data = await response.json(); } catch {
      throw new ApiError("SERVICE_UNAVAILABLE", "工作台服务暂时不可用，请稍后重试。");
    }
    if (!response.ok) {
      const code = isObject(data) && isObject(data.error) && typeof data.error.code === "string" ? data.error.code : "REQUEST_FAILED";
      throw new ApiError(code, messages[code] || "请求未完成，请刷新记录后重试。", response.status >= 500);
    }
    return parse(data);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError("TIMEOUT", "等待超时，操作可能仍在进行。请先刷新记录确认结果，再决定是否重试。");
    }
    throw new ApiError("NETWORK_ERROR", "连接中断，请检查网络后刷新记录。已保存的草稿仍然保留。");
  } finally {
    clearTimeout(timeout);
  }
}
