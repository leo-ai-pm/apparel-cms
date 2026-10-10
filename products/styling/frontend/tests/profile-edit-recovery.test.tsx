import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StylingPreview } from "../components/styling-preview";
import { resetConsumerProfileInitialization } from "../app/lib/consumer-profile";
import { emptyConsumerProfile, legacyConsumerRoute } from "./consumer-test-routes";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fixture() {
  const state = { context: "a", profile: { profile_id: null as string | null, profile_version: 0, status: "empty" }, mutation: undefined as undefined | ((init?: RequestInit) => Promise<Response>) };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/v1/consumer-profile") return json({ ...emptyConsumerProfile, ...state.profile, authorization_context: {
      context_contract: "consumer_profile_mutation_context_v1", context_id: `synthetic-context-${state.context}`, operation_token: `synthetic-private-token-${state.context}`,
      issued_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(),
    } });
    if (path === "/api/v1/consumer-profile/mutations") return state.mutation?.(init) ?? json({ error: { code: "PROFILE_STORAGE_UNAVAILABLE" } }, 503);
    if (path.includes("/consumer-profile/operations/")) return json({ error: { code: "PROFILE_OPERATION_NOT_FOUND" } }, 404);
    const standard = legacyConsumerRoute(input, init); if (standard) return standard;
    return json({ messages: [], tryons: [], product_ids: [], products: [], cart: [] });
  });
  vi.stubGlobal("fetch", fetcher); return { state, fetcher };
}
const mutations = (fetcher: ReturnType<typeof fixture>["fetcher"]) => fetcher.mock.calls.filter(([input, init]) => String(input).endsWith("/consumer-profile/mutations") && init?.method === "POST");
function selectSize(label: string, value: string) { fireEvent.click(within(screen.getByRole("group", { name: label })).getByRole("button", { name: value })); }
async function ready() { await waitFor(() => expect(screen.queryByText("正在恢复对话、图片和推荐记录…不会重新生成。")).not.toBeInTheDocument()); }
beforeEach(() => {
  resetConsumerProfileInitialization(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
});

describe("ACTX 范围切换后的显式编辑恢复", () => {
  it("A空主体草稿与后来抽屉编辑在B不可见，回A仅主动恢复才取回且不写业务接口", async () => {
    const { state, fetcher } = fixture(); render(<StylingPreview />); await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "说说你的穿搭需求" }), { target: { value: "A范围未发送的原话" } });
    fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    selectSize("上衣常穿尺码", "S"); fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    const originalMessage = (screen.getByRole("textbox", { name: "说说你的穿搭需求" }) as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" })); selectSize("上衣常穿尺码", "L"); selectSize("下装常穿尺码", "XL");
    await waitFor(() => expect(Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).some(key => key?.startsWith("styling.unsaved-profile-edit.v1:"))).toBe(true));
    state.context = "b"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(screen.getByRole("textbox", { name: "说说你的穿搭需求" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "恢复未保存的编辑" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "说说你的穿搭需求" }), { target: { value: "B自己的未发送编辑" } });
    state.context = "a"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    const recover = await screen.findByRole("button", { name: "恢复未保存的编辑" });
    expect(screen.getByRole("textbox", { name: "说说你的穿搭需求" })).toHaveValue(""); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(recover);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "说说你的穿搭需求" })).toHaveValue(originalMessage));
    expect(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "L" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("group", { name: "下装常穿尺码" })).getByRole("button", { name: "XL" })).toHaveAttribute("aria-pressed", "true");
    expect(mutations(fetcher)).toHaveLength(0);
    expect(fetcher.mock.calls.some(([url, init]) => init?.method === "POST" && /consumer-profile\/prepare$|\/chat$/.test(String(url)))).toBe(false);
    const backups = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!).filter(key => key.startsWith("styling.unsaved-profile-edit.v1:")).map(key => sessionStorage.getItem(key));
    expect(JSON.stringify(backups)).not.toContain("operation_token"); expect(JSON.stringify(backups)).not.toContain("synthetic-private-token");
    const events = fetcher.mock.calls.filter(([url]) => String(url).endsWith("consumer-events")).map(([, init]) => init?.body);
    expect(JSON.stringify(events)).not.toContain("synthetic-context"); expect(JSON.stringify(events)).not.toContain("synthetic-private-token");
  });

  it("403重挂载仍保留保存提交之后新增的编辑，回原context手动恢复不替换原pending", async () => {
    const { state, fetcher } = fixture(); let rejectSave!: (value: Response) => void;
    state.mutation = () => new Promise<Response>(resolve => { rejectSave = resolve; });
    render(<StylingPreview />); await ready(); fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    selectSize("上衣常穿尺码", "S"); fireEvent.click(screen.getByRole("button", { name: "保存我的资料" }));
    await waitFor(() => expect(mutations(fetcher)).toHaveLength(1));
    const original = JSON.parse(String(mutations(fetcher)[0][1]?.body));
    selectSize("上衣常穿尺码", "L"); selectSize("下装常穿尺码", "XL");
    await act(async () => { rejectSave(json({ error: { code: "PROFILE_OWNER_INVALID" } }, 403)); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "重新读取我的资料" })); await ready();
    fireEvent.click(await screen.findByRole("button", { name: "恢复未保存的编辑" }));
    await screen.findByRole("dialog", { name: "我的穿搭资料" });
    expect(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "L" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("group", { name: "下装常穿尺码" })).getByRole("button", { name: "XL" })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(sessionStorage.getItem("styling.pending-profile.v1:/")!).body).toEqual(original);
    expect(original.patch.base_profile.usual_sizes.top.value).toBe("S"); expect(mutations(fetcher)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "保存我的资料" })).toBeDisabled();
  });

  it("普通取消抽屉仍舍弃该次选择，不把取消内容在后来范围恢复时取回", async () => {
    const { state } = fixture(); render(<StylingPreview />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" })); selectSize("上衣常穿尺码", "L");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    state.context = "b"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    state.context = "a"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    expect(screen.queryByRole("button", { name: "恢复未保存的编辑" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    expect(within(screen.getByRole("group", { name: "上衣常穿尺码" })).getByRole("button", { name: "L" })).toHaveAttribute("aria-pressed", "false");
  });

  it("同context明确clear成功删除旧编辑备份，往返其他范围不会重新出现旧尺码", async () => {
    const { state, fetcher } = fixture(); state.profile = { profile_id: "synthetic-profile-a", profile_version: 1, status: "saved" };
    state.mutation = async init => {
      const body = JSON.parse(String(init?.body)); state.profile = { ...state.profile, profile_version: 2, status: "cleared" };
      return json({ profile_contract: "consumer_profile_v1", profile_action_id: body.profile_action_id, operation: "clear", profile_id: state.profile.profile_id,
        scope_kind: "device", version_before: 1, profile_version: 2, profile_status: "cleared", changed_field_names: [], status: "succeeded", created_at: new Date().toISOString() });
    };
    render(<StylingPreview />); await ready(); fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    selectSize("上衣常穿尺码", "S"); fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" })); selectSize("上衣常穿尺码", "L");
    fireEvent.click(screen.getByRole("button", { name: "清除已保存资料" })); fireEvent.click(screen.getByRole("button", { name: "确认清除已保存资料" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "说说你的穿搭需求" })).toHaveValue("");
    expect(mutations(fetcher)).toHaveLength(1);
    state.context = "b"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    state.context = "a"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    expect(screen.queryByRole("button", { name: "恢复未保存的编辑" })).not.toBeInTheDocument();
    const oldBackupKeys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!).filter(key => key.startsWith("styling.unsaved-profile-edit.v1:"));
    expect(oldBackupKeys).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox", { name: "说说你的穿搭需求" }), { target: { value: "清除之后重新明确输入的新需求" } });
    state.context = "b"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    state.context = "a"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    fireEvent.click(await screen.findByRole("button", { name: "恢复未保存的编辑" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "说说你的穿搭需求" })).toHaveValue("清除之后重新明确输入的新需求"));
    expect(mutations(fetcher)).toHaveLength(1);
  });

  it("共享设备明确清空本次选择也移除同范围备份", async () => {
    const { state } = fixture(); render(<StylingPreview />); await ready(); fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    selectSize("上衣常穿尺码", "S"); fireEvent.click(screen.getByRole("button", { name: "填入本次草稿" }));
    fireEvent.click(screen.getByRole("button", { name: "我的穿搭资料" }));
    fireEvent.click(screen.getByRole("button", { name: "清空本次选择" })); fireEvent.click(screen.getByRole("button", { name: "确认清空本次选择" }));
    expect(screen.getByRole("textbox", { name: "说说你的穿搭需求" })).toHaveValue("");
    state.context = "b"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    state.context = "a"; await act(async () => { window.dispatchEvent(new Event("focus")); }); await ready();
    expect(screen.queryByRole("button", { name: "恢复未保存的编辑" })).not.toBeInTheDocument();
  });
});
