import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRecord, workspaceApi } from "@/features/workspace/api";
import { draft } from "./fixtures";

afterEach(() => { vi.unstubAllGlobals(); });

describe("API boundary", () => {
  it("accepts records and preserves unknown states for a visible fallback", () => {
    expect(parseRecord({ ...draft, status: "future_state" }).status).toBe("future_state");
  });
  it.each([
    { ...draft, sample_count: { ...draft.sample_count, intent: -1 } },
    { ...draft, attribution: { ...draft.attribution, style_demand: "true" } },
    { ...draft, signal_ids: [42] },
  ])("rejects malformed external records", (data) => {
    expect(() => parseRecord(data)).toThrow("返回的数据不完整");
  });
  it("does not expose raw server error content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "CMS_ERROR", message: "sensitive upstream diagnostic" } }), { status: 502 })));
    await expect(workspaceApi.pull()).rejects.toMatchObject({ code: "CMS_ERROR", message: "数据后台未接受本次请求，请核对信号后重试。" });
  });
  it("normalizes proxy HTML failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream failure", { status: 502 })));
    await expect(workspaceApi.drafts()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
  it("normalizes disconnections without automatically retrying mutations", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("network"));
    vi.stubGlobal("fetch", fetcher);
    await expect(workspaceApi.pull()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses same-origin URLs and treats save as a separate action", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(draft)));
    vi.stubGlobal("fetch", fetcher);
    await workspaceApi.save(1, { requirement_desc: "", constraints: [], style_demand: false, priority: "P3", priority_basis: "当前只有意向信号" });
    expect(fetcher).toHaveBeenCalledWith("/api/drafts/1", expect.objectContaining({ method: "PATCH" }));
  });
});
