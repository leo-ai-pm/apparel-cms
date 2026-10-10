import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StylingPreview } from "../components/styling-preview";
import { emptyConsumerProfile, legacyConsumerRoute, preparedProfileFixture } from "./consumer-test-routes";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const saved = { ...emptyConsumerProfile, profile_id: "profile-cpf16", profile_version: 1, status: "saved", default_budget_fen: 150000,
  base_profile: { height_cm: 175, weight_kg: 70, usual_sizes: { top: { system: "clothing_alpha", value: "XL" }, bottom: { system: "clothing_alpha", value: "XL" }, shoes: { system: "cn_shoe", value: "40" } } },
  updated_at: "2026-10-10T00:00:00Z", expires_at: "2027-04-08T00:00:00Z" };
const pending = { profile_action_id: "pending-profile-cpf16", operation: "update", expected_profile_version: 1, patch: { base_profile: { height_cm: 180 } }, explicit_save: true };
const key = "styling.pending-profile.v1:/";
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/#outfit"); });

function fixture({ missingScene = false }: { missingScene?: boolean } = {}) {
  const stored = JSON.stringify({ body: pending, owner: { profile_id: saved.profile_id, scope_kind: saved.scope_kind } });
  sessionStorage.setItem(key, stored);
  const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/v1/consumer-profile") return json(saved);
    if (path.startsWith("/api/v1/consumer-profile/operations/")) return json({ error: { code: "PROFILE_OPERATION_NOT_FOUND" } }, 404);
    if (path === "/api/v1/consumer-profile/mutations") return json({ error: { code: "PROFILE_STORAGE_UNAVAILABLE" } }, 503);
    if (path === "/api/v1/consumer-profile/prepare") {
      const request = JSON.parse(String(init?.body));
      const prepared = preparedProfileFixture(request.request_id, 1);
      const binding = { ...prepared.profile_binding, profile_id: saved.profile_id };
      return json({ ...prepared, profile_binding: binding, snapshot: { ...prepared.snapshot, ...binding } });
    }
    if (path === "/api/v1/chat") {
      const body = JSON.parse(String(init?.body));
      return new Response(`event: done\ndata: ${JSON.stringify({ session_id: body.session_id, request_id: body.request_id, content: missingScene ? "请补充本次使用场景" : "本次条件已按独立请求处理", outcome: "clarification", outfit: null,
        ...(missingScene ? { profile_context: { field_sources: {}, missing_fields: ["scene"], clarification: { field: "scene", next_field: "scene", question: "这次会在哪个场景穿？" } } } : {}),
      })}\n\n`);
    }
    const standard = legacyConsumerRoute(input, init); if (standard) return standard;
    return json({ messages: [{ role: "assistant", content: "请告诉我本次需求" }], tryons: [], products: [], product_ids: [], cart: [], items: [] });
  });
  vi.stubGlobal("fetch", calls);
  render(<StylingPreview />);
  return { calls, stored };
}

const posts = (calls: ReturnType<typeof fixture>["calls"], path: string) => calls.mock.calls.filter(([input, init]) => new URL(String(input), "http://localhost").pathname === path && init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
async function ready() {
  await screen.findByRole("button", { name: "仅按完整本次条件发送" });
  await waitFor(() => expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument());
  return screen.getByRole("textbox", { name: "说说你的穿搭需求" });
}

async function choose(user: ReturnType<typeof userEvent.setup>, field: "top" | "bottom" | "shoes" | "budget_fen") {
  await user.selectOptions(screen.getByRole("combobox", { name: "选择一项补充" }), field);
  if (field === "top" || field === "bottom") {
    await user.click(within(screen.getByRole("group", { name: field === "top" ? "上衣常穿尺码" : "下装常穿尺码" })).getByRole("button", { name: "M" }));
  } else if (field === "shoes") {
    const input = screen.getByRole("textbox", { name: "直接输入常穿鞋码（中国码）" });
    fireEvent.change(input, { target: { value: "38" } }); fireEvent.blur(input);
  } else await user.click(screen.getByRole("button", { name: "¥800" }));
  await user.click(screen.getByRole("button", { name: "填入本次草稿" }));
}
async function allChoices(user: ReturnType<typeof userEvent.setup>) {
  for (const field of ["top", "bottom", "shoes", "budget_fen"] as const) await choose(user, field);
}

describe("CPF-16 保存待确认时的完整本次条件路径（受控接口替身）", () => {
  it("只用本次三尺码预算场景准备和发送，保留pending保存原体且不重放mutation", async () => {
    const { calls, stored } = fixture(); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "明天通勤，想要轻松一点");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await allChoices(user);
    const submit = screen.getByRole("button", { name: "仅按完整本次条件发送" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await screen.findByText("本次条件已按独立请求处理");
    const preparations = posts(calls, "/api/v1/consumer-profile/prepare");
    const chats = posts(calls, "/api/v1/chat");
    expect(preparations).toHaveLength(1); expect(chats).toHaveLength(1);
    const { profile_binding, ...original } = chats[0];
    expect(preparations[0].request_body).toEqual(original);
    expect(original.request_conditions).toEqual({ budget_max_fen: 80000, request_profile_overrides: { usual_sizes: {
      top: { system: "clothing_alpha", value: "M" }, bottom: { system: "clothing_alpha", value: "M" }, shoes: { system: "cn_shoe", value: "38" },
    } } });
    expect(profile_binding).toEqual({ ...preparedProfileFixture(original.request_id, 1).profile_binding, profile_id: saved.profile_id });
    expect(original).not.toHaveProperty("budget"); expect(original).not.toHaveProperty("scene");
    expect(JSON.stringify(original)).not.toMatch(/height_cm|weight_kg|150000|\bXL\b/);
    expect(posts(calls, "/api/v1/consumer-profile/mutations")).toHaveLength(0);
    expect(calls.mock.calls.some(([url]) => String(url).includes("/consumer-profile/operations/"))).toBe(false);
    expect(sessionStorage.getItem(key)).toBe(stored);
    const events = posts(calls, "/api/v1/consumer-events");
    expect(events.filter(body => body.event_name === "message_submit")).toHaveLength(1);
    expect(events.every(body => !/height_cm|weight_kg|usual_sizes|budget_max_fen/.test(JSON.stringify(body)))).toBe(true);
  });

  it("本次预算尚未明确时保持禁用，不用已保存1500元补齐", async () => {
    const { calls } = fixture(); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "明天通勤");
    for (const field of ["top", "bottom", "shoes"] as const) await choose(user, field);
    const button = screen.getByRole("button", { name: "仅按完整本次条件发送" });
    expect(button).toBeDisabled(); await user.click(button);
    expect(posts(calls, "/api/v1/consumer-profile/prepare")).toHaveLength(0);
    expect(posts(calls, "/api/v1/chat")).toHaveLength(0);
    expect(posts(calls, "/api/v1/consumer-profile/mutations")).toHaveLength(0);
  });

  it("即使已保存三尺码齐全，本次未明确的单个尺码也不能借用", async () => {
    const { calls } = fixture(); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "日常通勤");
    for (const field of ["top", "shoes", "budget_fen"] as const) await choose(user, field);
    expect(screen.getByRole("button", { name: "仅按完整本次条件发送" })).toBeDisabled();
    expect(posts(calls, "/api/v1/consumer-profile/prepare")).toHaveLength(0);
  });

  it("缺场景仍按本次明确尺码预算独立请求，由服务端真实clarification追问", async () => {
    const { calls } = fixture({ missingScene: true }); const input = await ready(); const user = userEvent.setup();
    await user.type(input, "想要宽松一点"); await allChoices(user);
    expect(screen.getByRole("button", { name: "仅按完整本次条件发送" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "仅按完整本次条件发送" }));
    await screen.findByText("请补充本次使用场景");
    expect(screen.getByRole("region", { name: "补充使用场景" })).toBeVisible();
    expect(posts(calls, "/api/v1/consumer-profile/prepare")[0].request_body.request_conditions).not.toHaveProperty("scene");
    expect(posts(calls, "/api/v1/chat")[0].request_conditions).not.toHaveProperty("scene");
    expect(posts(calls, "/api/v1/consumer-profile/mutations")).toHaveLength(0);
  });

  it.each(["周末出游", "不要通勤，用于舞台演出"])("场景原话‘%s’不被客户端改写成通勤", async text => {
    const { calls } = fixture(); const input = await ready(); const user = userEvent.setup();
    await user.type(input, text); await allChoices(user);
    expect(screen.getByRole("button", { name: "仅按完整本次条件发送" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "仅按完整本次条件发送" }));
    await screen.findByText("本次条件已按独立请求处理");
    const body = posts(calls, "/api/v1/chat")[0];
    expect(body.message).toContain(text);
    expect(body.request_conditions).not.toHaveProperty("scene"); expect(body).not.toHaveProperty("scene");
    expect(posts(calls, "/api/v1/consumer-profile/prepare")[0].request_body.message).toBe(body.message);
    expect(posts(calls, "/api/v1/consumer-profile/mutations")).toHaveLength(0);
  });
});
