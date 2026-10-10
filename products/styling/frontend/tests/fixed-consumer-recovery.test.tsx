import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionId } from "../app/lib/api";
import { StylingPreview } from "../components/styling-preview";
import { isBusinessWrite, legacyConsumerRoute } from "./consumer-test-routes";
import { outfit, session } from "./fixed-outfit-fixtures";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/#outfit"); });

function pendingFixture(status: "running" | "failed" | "succeeded") {
  const sid = getSessionId();
  const request = { session_id: sid, request_id: "persisted-original", message: "预算500元，通勤，上衣M裤子M鞋38", budget: "", scene: "通勤" };
  const key = `styling.pending-chat.v1:${sid}`;
  sessionStorage.setItem(key, JSON.stringify(request));
  return { sid, request, key, record: {
    recorded: true, request_id: request.request_id, session_id: sid, status,
    outcome: status === "succeeded" ? "no_match" : null, error_code: status === "failed" ? "CATALOG_REFERENCE_UNSUPPORTED" : null,
    result: status === "succeeded" ? { session_id: sid, request_id: request.request_id, content: "500元在当前固定图库没有匹配，保留原条件。", outcome: "no_match", outfit: null, fixed_session_id: "fixed-session" } : null,
    effective_outfit: false,
  } };
}
function routes(options: { record?: unknown; fixed?: unknown; oldMessages?: Promise<Response>; chat?: (init: RequestInit) => Promise<Response> } = {}) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.startsWith("/api/v1/generation-requests/")) return json(options.record ?? {}, options.record ? 200 : 404);
    if (path.startsWith("/api/v1/outfits/sessions/") && options.fixed) return json(options.fixed);
    if (path === "/api/v1/chat" && options.chat && init) return options.chat(init);
    const extra = legacyConsumerRoute(input, init); if (extra) return extra;
    if (path.endsWith("/messages")) return options.oldMessages ?? json({ messages: [] });
    if (path === "/api/v1/tryon") return json({ tryons: [] });
    if (path === "/api/v1/recommendations") return json({ product_ids: [] });
    if (path === "/api/v1/products") return json({ products: [] });
    if (path === "/api/v1/cart") return json({ cart: [] });
    throw new Error(`Unexpected protocol test request: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("consumer fixed generation recovery", () => {
  it("refresh automatically queries the pending identity, exposes its controls, and never sends another demand", async () => {
    const fixture = pendingFixture("running"); const calls = routes({ record: fixture.record });
    render(<StylingPreview />);
    expect(await screen.findByRole("button", { name: "查询原请求结果" })).toBeVisible();
    expect(screen.getByRole("button", { name: "按原编号重试发送" })).toBeVisible();
    await waitFor(() => expect(calls.mock.calls.filter(([input]) => String(input).includes("/generation-requests/"))).toHaveLength(1));
    expect(screen.getByRole("textbox")).toHaveValue(fixture.request.message);
    expect(JSON.parse(sessionStorage.getItem(fixture.key)!)).toEqual(fixture.request);
    expect(calls.mock.calls.filter(isBusinessWrite)).toHaveLength(0);
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "按原编号重试发送" }));
    expect(await screen.findByText("原请求仍在处理或未记录终态，请继续查询，不重复发送。")).toBeVisible();
    expect(calls.mock.calls.filter(isBusinessWrite)).toHaveLength(0);
  });

  it("a persisted failed request clears pending controls but preserves its requirement and real failure", async () => {
    const fixture = pendingFixture("failed"); const calls = routes({ record: fixture.record });
    render(<StylingPreview />);
    expect(await screen.findByText(/你引用的是 P 编号灵感商品/)).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue(fixture.request.message);
    expect(screen.queryByRole("button", { name: "查询原请求结果" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(fixture.key)).toBeNull();
    expect(calls.mock.calls.filter(isBusinessWrite)).toHaveLength(0);
  });

  it("a new explicit expression gets a new ID and clears the previous no-match status while processing", async () => {
    const fixture = pendingFixture("succeeded"); const pending = deferred<Response>();
    const calls = routes({ record: fixture.record, chat: () => pending.promise });
    render(<StylingPreview />);
    expect(await screen.findByText("当前固定目录没有符合这次要求的完整搭配，原方案保留。")).toBeVisible();
    const user = userEvent.setup(); const input = screen.getByRole("textbox");
    await user.clear(input); await user.type(input, "这是新表达，预算800元，通勤，M M 38");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.queryByText("当前固定目录没有符合这次要求的完整搭配，原方案保留。")).not.toBeInTheDocument();
    const writes = calls.mock.calls.filter(isBusinessWrite);
    expect(writes).toHaveLength(1);
    const body = JSON.parse(String(writes[0][1]?.body));
    expect(body.request_id).not.toBe(fixture.request.request_id);
    expect(body.session_id).toBe(fixture.sid);
    await act(async () => {
      pending.resolve(new Response(`event: error\ndata: ${JSON.stringify({ session_id: fixture.sid, request_id: body.request_id, error: { code: "MODEL_TIMEOUT", message: "controlled test failure" } })}\n\n`));
    });
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue(body.message);
  });

  it("fixed messages survive a late legacy read; viewing history stays read-only and blocks ambiguous generation", async () => {
    const first = outfit();
    const current = { ...outfit(), look_version_id: "lv-2", version_no: 2, parent_look_version_id: "lv-1" };
    const fixed = { ...session(), history: [first, current], messages: [{ role: "assistant", content: "固定会话中最新的真实记录" }], state: { ...session().state, current_look_version_id: "lv-2", look_version_ids: ["lv-1", "lv-2"] } };
    const legacy = deferred<Response>(); const calls = routes({ fixed, oldMessages: legacy.promise });
    render(<StylingPreview />);
    expect(await screen.findByText("固定会话中最新的真实记录")).toBeVisible();
    await act(async () => { legacy.resolve(json({ messages: [{ role: "assistant", content: "迟到的旧照片文字记录" }] })); });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    expect(screen.queryByText("迟到的旧照片文字记录")).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "历史对话" }));
    await user.click(screen.getByRole("button", { name: "查看版本 1" }));
    expect(await screen.findByText("仅查看历史 · 版本 1")).toBeVisible();
    await user.type(screen.getByRole("textbox"), "保留正在看的鞋，换上衣");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("正在查看历史版本。请先回到当前方案，再继续表达换搭需求；草稿保留。")).toBeVisible();
    expect(calls.mock.calls.filter(isBusinessWrite)).toHaveLength(0);
    expect(screen.getByRole("textbox")).toHaveValue("保留正在看的鞋，换上衣");
    await user.click(screen.getByRole("button", { name: "回到当前方案继续对话" }));
    expect(await screen.findByText("当前方案 · 版本 2")).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("保留正在看的鞋，换上衣");
    expect(calls.mock.calls.filter(isBusinessWrite)).toHaveLength(0);
  });
});
