import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Product } from "../app/lib/api";
import { SHOWCASE_CHIPS, SHOWCASE_GROUPS, SHOWCASE_PRODUCT_IDS } from "../app/lib/showcase-catalog";
import { ConsumerDiscovery } from "../components/consumer-discovery";

const products: Product[] = SHOWCASE_PRODUCT_IDS.map((product_id, index) => ({
  product_id, name: `目录${product_id}商品`, category: "上装", price: 100 + index, color: "白色",
}));
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});
const tileName = (product: Product) => `把${product.name}加入穿搭需求草稿`;

function stubCatalog(read: () => Response | Promise<Response>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.endsWith("/api/v1/products") || (init?.method && init.method !== "GET")) {
      throw new Error("Unexpected unit-test request");
    }
    return read();
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("消费者发现首页", () => {
  it("读取真实商品契约时显示等待，响应到达后才用实际名称与价格展示SKU", async () => {
    let finish!: (result: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const fetcher = stubCatalog(() => pending);
    const onPrefill = vi.fn();
    render(<ConsumerDiscovery onPrefill={onPrefill} disabled={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取示例商品…");
    expect(screen.queryByRole("button", { name: tileName(products[0]) })).not.toBeInTheDocument();
    expect(onPrefill).not.toHaveBeenCalled();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const url = new URL(String(fetcher.mock.calls[0][0]), "http://localhost");
    expect(url.searchParams.get("ids")?.split(",")).toEqual([...SHOWCASE_PRODUCT_IDS]);

    await act(async () => { finish(response({ products })); });
    expect((await screen.findAllByRole("button", { name: tileName(products[0]) }))[0]).toBeEnabled();
    expect(screen.queryByText("正在读取示例商品…")).not.toBeInTheDocument();
    expect(screen.getAllByText(products[0].name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`¥${products[0].price}`).length).toBeGreaterThan(0);
    expect(onPrefill).not.toHaveBeenCalled();
  });

  it("商品GET失败显示安全错误，显式重试才重新读取，保留自然语言预填能力", async () => {
    const failure = response({ error: { message: "private synthetic catalog trace" } }, 503);
    const readFailureBody = vi.spyOn(failure, "json");
    let available = false;
    const fetcher = stubCatalog(() => available ? response({ products }) : failure);
    const onPrefill = vi.fn();
    const user = userEvent.setup();
    render(<ConsumerDiscovery onPrefill={onPrefill} disabled={false} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("示例商品暂时无法读取，仍可直接描述需求。");
    expect(screen.queryByText(/private synthetic catalog trace/)).not.toBeInTheDocument();
    expect(readFailureBody).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: SHOWCASE_CHIPS[0].title }));
    expect(onPrefill).toHaveBeenCalledWith(SHOWCASE_CHIPS[0].prompt);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const chip = screen.getByRole("button", { name: SHOWCASE_CHIPS[0].title });
    fireEvent.error(within(chip).getByAltText(""));
    expect(within(chip).queryByAltText("")).not.toBeInTheDocument();

    available = true;
    await user.click(screen.getByRole("button", { name: "重试读取示例商品" }));
    expect((await screen.findAllByRole("button", { name: tileName(products[0]) }))[0]).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onPrefill).toHaveBeenCalledTimes(1);
    expect(within(chip).getByAltText("")).toBeInTheDocument();
  });

  it("缺SKU明确禁用，缺商品图保留实际名称价格并仍可预填", async () => {
    const missing = SHOWCASE_GROUPS[0].tiles[0];
    const present = products.find(product => product.product_id === SHOWCASE_GROUPS[0].tiles[1].productId)!;
    stubCatalog(() => response({ products: products.filter(product => product.product_id !== missing.productId) }));
    const onPrefill = vi.fn();
    const user = userEvent.setup();
    render(<ConsumerDiscovery onPrefill={onPrefill} disabled={false} />);
    const showcase = screen.getByRole("region", { name: "穿搭场景与示例商品" });
    const tile = (await within(showcase).findAllByRole("button", { name: tileName(present) }))[0];
    const missingTile = screen.getByRole("button", { name: `${missing.label}：商品资料暂缺` });
    expect(missingTile).toBeDisabled();
    await user.click(missingTile);
    expect(onPrefill).not.toHaveBeenCalled();

    fireEvent.error(within(tile).getByRole("img", { name: present.name }));
    expect(within(tile).getByText("商品图片暂缺")).toBeInTheDocument();
    expect(within(tile).getByText(present.name)).toBeInTheDocument();
    expect(within(tile).getByText(`¥${present.price}`)).toBeInTheDocument();
    expect(tile).toBeEnabled();
    await user.click(tile);
    expect(onPrefill).toHaveBeenCalledTimes(1);
    expect(onPrefill.mock.calls[0][0]).toContain(present.name);
  });

  it("辅助提示与真实SKU可用键盘预填草稿，操作不发送聊天或其他业务请求", async () => {
    const fetcher = stubCatalog(() => response({ products }));
    const onPrefill = vi.fn();
    const user = userEvent.setup();
    render(<ConsumerDiscovery onPrefill={onPrefill} disabled={false} />);
    const tile = (await screen.findAllByRole("button", { name: tileName(products[0]) }))[0];
    const chip = screen.getByRole("button", { name: SHOWCASE_CHIPS[0].title });
    chip.focus();
    await user.keyboard("{Enter}");
    expect(onPrefill).toHaveBeenLastCalledWith(SHOWCASE_CHIPS[0].prompt);
    tile.focus();
    await user.keyboard("{Enter}");
    expect(onPrefill).toHaveBeenCalledTimes(2);
    expect(onPrefill.mock.calls[1][0]).toContain(products[0].name);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("恢复或生成锁定期间所有提示与SKU暂停预填，解除锁定后可继续", async () => {
    stubCatalog(() => response({ products }));
    const onPrefill = vi.fn();
    const user = userEvent.setup();
    const view = render(<ConsumerDiscovery onPrefill={onPrefill} disabled />);
    const tile = (await screen.findAllByRole("button", { name: tileName(products[0]) }))[0];
    for (const sku of screen.getAllByRole("button", { name: /^把.+加入穿搭需求草稿$/ })) expect(sku).toBeDisabled();
    for (const chip of SHOWCASE_CHIPS) expect(screen.getByRole("button", { name: chip.title })).toBeDisabled();
    for (const group of SHOWCASE_GROUPS) expect(screen.getByRole("button", { name: group.title })).toBeDisabled();
    await user.click(tile);
    await user.click(screen.getByRole("button", { name: SHOWCASE_CHIPS[0].title }));
    expect(onPrefill).not.toHaveBeenCalled();

    view.rerender(<ConsumerDiscovery onPrefill={onPrefill} disabled={false} />);
    const chip = screen.getByRole("button", { name: SHOWCASE_CHIPS[0].title });
    expect(chip).toBeEnabled();
    await user.click(chip);
    expect(onPrefill).toHaveBeenCalledWith(SHOWCASE_CHIPS[0].prompt);
    view.rerender(<ConsumerDiscovery onPrefill={onPrefill} disabled />);
    for (const sku of screen.getAllByRole("button", { name: /^把.+加入穿搭需求草稿$/ })) expect(sku).toBeDisabled();
    await user.click(screen.getByRole("button", { name: SHOWCASE_CHIPS[0].title }));
    expect(onPrefill).toHaveBeenCalledTimes(1);
  });
});
