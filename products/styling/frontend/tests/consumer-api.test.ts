import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCart, fetchProducts, fetchRecommendedIds, fetchTryons } from "../app/lib/api";

const cases = [
  {
    name: "历史搭配", call: () => fetchTryons("saved session"),
    path: "/api/v1/tryon?session_id=saved%20session", field: "tryons",
    error: "历史搭配暂时无法加载，请稍后重试。",
    rows: [{ task_id: "saved-task", status: "succeeded", result_url: "/tryon-results/saved.png", scene: "通勤" }],
  },
  {
    name: "商品明细", call: () => fetchProducts(["P001", "P008"]),
    path: "/api/v1/products?ids=P001%2CP008", field: "products",
    error: "商品明细暂时无法加载，请稍后重试。",
    rows: [{ product_id: "P001", name: "模拟衬衫", category: "上装", price: 159, color: "白" }],
  },
  {
    name: "模拟购物车", call: () => fetchCart("saved session"),
    path: "/api/v1/cart?session_id=saved%20session", field: "cart",
    error: "模拟购物车暂时无法加载，请稍后重试。", rows: ["P001"],
  },
  {
    name: "当前方案", call: () => fetchRecommendedIds("saved session"),
    path: "/api/v1/recommendations?session_id=saved%20session", field: "product_ids",
    error: "当前方案暂时无法加载，请稍后重试。", rows: ["P001", "P008"],
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe("consumer reads distinguish real failure from empty saved data", () => {
  for (const item of cases) {
    it.each([401, 503])(`${item.name} HTTP %i rejects safely without reading a private failure body`, async status => {
      const response = new Response(JSON.stringify({ error: { message: "private response fixture: do not show this body" } }), {
        status, headers: { "content-type": "application/json" },
      });
      const json = vi.spyOn(response, "json");
      const fetch = vi.fn(async () => response);
      vi.stubGlobal("fetch", fetch);

      await expect(item.call()).rejects.toThrow(item.error);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(item.path);
      expect(json).not.toHaveBeenCalled();
      expect(response.bodyUsed).toBe(false);
    });

    it(`${item.name} still returns an empty list for a successful empty backend result`, async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ [item.field]: [] }), { status: 200 }));
      vi.stubGlobal("fetch", fetch);

      await expect(item.call()).resolves.toEqual([]);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(item.path);
    });

    it(`${item.name} retains the successful response shape and existing encoded route`, async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ [item.field]: item.rows }), { status: 200 }));
      vi.stubGlobal("fetch", fetch);

      await expect(item.call()).resolves.toEqual(item.rows);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(item.path);
    });
  }

  it("an empty product ID selection remains a legitimate local empty result without an API request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(fetchProducts([])).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
