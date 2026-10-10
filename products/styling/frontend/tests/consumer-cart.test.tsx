import { legacyConsumerRoute } from "./consumer-test-routes";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionId } from "../app/lib/api";
import { StylingPreview } from "../components/styling-preview";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json" },
});

function savedCartFixture() {
  let finish!: (result: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const sessionId = getSessionId();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const extra = legacyConsumerRoute(input, init); if (extra) return extra;
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v1/cart/P001" && init?.method === "DELETE") return pending;
    if (init?.method && init.method !== "GET") throw new Error("Unexpected test write request");
    if (url.pathname === `/api/v1/sessions/${sessionId}/messages`) return response({ messages: [{ role: "assistant", content: "已保存的通勤搭配" }] });
    if (url.pathname === "/api/v1/tryon") return response({ tryons: [] });
    if (url.pathname === "/api/v1/recommendations") return response({ product_ids: ["P001"] });
    if (url.pathname === "/api/v1/products") return response({ products: [{ product_id: "P001", name: "白色基础衬衫", category: "上装", price: 159, color: "白色" }] });
    if (url.pathname === "/api/v1/cart") return response({ cart: ["P001"] });
    throw new Error(`Unexpected test read request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { finish, fetcher, sessionId };
}

describe("消费者取消模拟加购", () => {
  it("等待真实取消响应期间保留已加购状态，成功后才更新并防止重复提交", async () => {
    const { finish, fetcher, sessionId } = savedCartFixture();
    const user = userEvent.setup();
    render(<StylingPreview />);
    const added = await screen.findByRole("button", { name: "已加购 ✓" });
    expect(added).toHaveAttribute("aria-pressed", "true");

    await user.dblClick(added);
    const pending = screen.getByRole("button", { name: "提交中…" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "＋ 加购" })).not.toBeInTheDocument();
    const deletes = fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe(`/api/v1/cart/P001?session_id=${encodeURIComponent(sessionId)}`);
    expect(deletes[0][1]?.body).toBeUndefined();

    await act(async () => { finish(response({ cart: [] })); });
    const add = await screen.findByRole("button", { name: "＋ 加购" });
    expect(add).toBeEnabled();
    expect(add).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("真实取消失败后保留已加购状态，并显示安全错误而不回显后端私有内容", async () => {
    const { finish, fetcher } = savedCartFixture();
    const failure = response({ error: { message: "private backend trace: synthetic-secret" } }, 502);
    const readFailureBody = vi.spyOn(failure, "json");
    const user = userEvent.setup();
    render(<StylingPreview />);
    await user.click(await screen.findByRole("button", { name: "已加购 ✓" }));
    expect(screen.getByRole("button", { name: "提交中…" })).toHaveAttribute("aria-pressed", "true");

    await act(async () => { finish(failure); });
    expect(await screen.findByRole("alert")).toHaveTextContent("取消加购失败，请稍后重试");
    const added = screen.getByRole("button", { name: "已加购 ✓" });
    expect(added).toBeEnabled();
    expect(added).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "＋ 加购" })).not.toBeInTheDocument();
    expect(screen.queryByText(/private backend trace|synthetic-secret/)).not.toBeInTheDocument();
    expect(readFailureBody).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
});
