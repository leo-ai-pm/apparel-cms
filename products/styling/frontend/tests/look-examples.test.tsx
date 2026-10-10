import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOK_EXAMPLES, LOOK_EXAMPLE_SOURCE } from "../app/lib/look-examples";
import { ConsumerLookExamples } from "../components/consumer-look-examples";

// Independent assertions frozen from the accepted formal M1V2 catalog and look
// mapping. Candidate preview looks and the unrelated P001 catalog are excluded.
const accepted = [
  { id: "M1V2-LOOK-101", title: "通勤示例 01", skus: ["M1V2-T101-M", "M1V2-B101-M", "M1V2-S101-38"],
    names: ["模拟·奶油白不对称无袖剪裁上衣", "模拟·巧克力色垂坠双褶阔腿长裤", "模拟·酒红细带方头低跟鞋"], prices: [249, 279, 269], total: 797,
    filename: "look_101.png", sha256: "5ee139730b19ebfe9d520db0dd5ad390fd6cb12a7630f8e338abe7959d18119e" },
  { id: "M1V2-LOOK-112", title: "通勤示例 02", skus: ["M1V2-T102-M", "M1V2-B102-M", "M1V2-S101-38"],
    names: ["模拟·蓝白细条纹廓形短袖衬衫", "模拟·本白弧线廓形长牛仔裤", "模拟·酒红细带方头低跟鞋"], prices: [229, 259, 269], total: 757,
    filename: "look_112.png", sha256: "5c45d7fac17197ae521f9311b4c4f0bc695e88a32df11d8184783c5ff1ea361b" },
  { id: "M1V2-LOOK-113", title: "通勤示例 03", skus: ["M1V2-T102-M", "M1V2-B102-M", "M1V2-S102-38"],
    names: ["模拟·蓝白细条纹廓形短袖衬衫", "模拟·本白弧线廓形长牛仔裤", "模拟·象牙白薄底系带休闲鞋"], prices: [229, 259, 249], total: 737,
    filename: "look_113.png", sha256: "b234da92a52b85035022f6c0c8de29d944124d3e9ac8b0ccb98b69f7ffd2cb10" },
  { id: "M1V2-LOOK-116", title: "通勤示例 04", skus: ["M1V2-T102-M", "M1V2-B101-M", "M1V2-S101-38"],
    names: ["模拟·蓝白细条纹廓形短袖衬衫", "模拟·巧克力色垂坠双褶阔腿长裤", "模拟·酒红细带方头低跟鞋"], prices: [229, 279, 269], total: 777,
    filename: "look_116.png", sha256: "bcdf516c2078ada1c04780c922bcc26a77f64fd57f1b987ea39fcc08d3c63772" },
] as const;

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("独立固定模特示例", () => {
  it.each(accepted)("选择 $id 时保持自身SKU、尺码和历史目录价，完整大图对应原素材", async example => {
    const user = userEvent.setup();
    render(<ConsumerLookExamples />);
    await user.click(screen.getByRole("button", { name: `查看${example.title} ${example.id}` }));
    const list = screen.getByRole("list", { name: `${example.id}对应的历史SKU` });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    example.skus.forEach((sku, index) => {
      expect(within(rows[index]).getByText(sku)).toBeInTheDocument();
      expect(within(rows[index]).getByRole("heading", { name: example.names[index] })).toBeInTheDocument();
      expect(within(rows[index]).getByText(`¥${example.prices[index].toFixed(2)}`)).toBeInTheDocument();
      expect(within(rows[index]).getByText(index === 2 ? "尺码：38码（中国鞋码）" : "尺码：M（服装字母码）")).toBeInTheDocument();
      expect(within(rows[index]).getByText("历史目录价")).toBeInTheDocument();
    });
    expect(screen.getByText(`¥${example.total.toFixed(2)}`)).toBeInTheDocument();
    expect(screen.getByText("历史目录价合计")).toBeInTheDocument();
    const image = screen.getByRole("img", { name: `${example.title}：固定模特完整上身搭配示意图` });
    const imageUrl = new URL(image.getAttribute("src") ?? "", window.location.href);
    expect(imageUrl.pathname).toBe(`/look-examples/${example.filename}`);
    expect(imageUrl.origin).toBe(window.location.origin);
    expect(image).toHaveAttribute("width", "1024");
    expect(image).toHaveAttribute("height", "1536");
    expect(screen.getByRole("button", { name: `查看${example.title} ${example.id}` })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button").filter(button => button.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  it("四张公开副本保持正式已验收图的原始SHA，目录版本与已过期库存来源可追溯", () => {
    expect(LOOK_EXAMPLES.map(look => look.lookId)).toEqual(accepted.map(look => look.id));
    for (const example of accepted) {
      const bytes = readFileSync(resolve("public/look-examples", example.filename));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(example.sha256);
      expect(LOOK_EXAMPLES.find(look => look.lookId === example.id)?.imageSha256).toBe(example.sha256);
    }
    expect(LOOK_EXAMPLE_SOURCE.catalogVersion).toBe("catalog_m1_v2_001");
    expect(LOOK_EXAMPLE_SOURCE.lookAssetVersion).toBe("look_assets_m1_v2_002");
    expect(LOOK_EXAMPLE_SOURCE.inventoryValidUntil).toBe("2026-09-06T00:00:00+08:00");
    expect(LOOK_EXAMPLE_SOURCE.approvalId).toBe("user_visual_acceptance_20260905");
    expect(LOOK_EXAMPLES.flatMap(look => look.items).every(item => item.productId.startsWith("M1V2-P-") && item.skuId.startsWith("M1V2-"))).toBe(true);
  });

  it("浏览所有示例只改变本地选择，明确非当前推荐、旧目录不可加购且没有模型或业务请求", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(() => { throw new Error("Independent example must not request any model or business API"); });
    vi.stubGlobal("fetch", fetcher);
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
    render(<ConsumerLookExamples compact />);
    for (const example of accepted) await user.click(screen.getByRole("button", { name: `查看${example.title} ${example.id}` }));
    expect(screen.getByText(/已授权 AI 合成独立示例/)).toBeInTheDocument();
    expect(screen.getByText("非当前推荐")).toBeInTheDocument();
    expect(screen.getByText(/库存快照已于 2026 年 9 月 6 日.*到期，旧目录不可加购/)).toBeInTheDocument();
    expect(screen.getByText(/不代表当前库存或可售状态/)).toBeInTheDocument();
    expect(screen.getByText(/不代表实际试穿或尺码效果/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /加购|购买|生成|发送/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(fetcher).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    expect(screen.queryByText(/P001|P008|P017/)).not.toBeInTheDocument();
  });

  it("键盘Enter和Space能切换大图与对应信息", async () => {
    const user = userEvent.setup();
    render(<ConsumerLookExamples />);
    await user.tab();
    expect(screen.getByRole("button", { name: "查看通勤示例 01 M1V2-LOOK-101" })).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("figure", { name: "通勤示例 02" })).toBeInTheDocument();
    await user.tab();
    await user.keyboard(" ");
    expect(screen.getByRole("figure", { name: "通勤示例 03" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "M1V2-LOOK-113对应的历史SKU" })).toBeInTheDocument();
  });

  it("子路径部署只读本地四图且不会请求图片优化或外站", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/styling");
    const { container } = render(<ConsumerLookExamples />);
    const images = [...container.querySelectorAll("img")];
    expect(images).toHaveLength(5);
    expect(images.every(image => {
      const url = new URL(image.getAttribute("src") ?? "", window.location.href);
      return url.pathname.startsWith("/styling/look-examples/") && url.origin === window.location.origin;
    })).toBe(true);
    expect(images.every(image => !image.hasAttribute("srcset"))).toBe(true);
  });

  it("示例文件读取失败如实展示，不用当前推荐或另一张图替换", () => {
    render(<ConsumerLookExamples />);
    fireEvent.error(screen.getByRole("img", { name: "通勤示例 01：固定模特完整上身搭配示意图" }));
    expect(screen.getByRole("alert")).toHaveTextContent("示例图片暂时无法显示");
    expect(screen.getByRole("alert")).toHaveTextContent("不会替换为当前推荐图片");
    expect(screen.queryByRole("img", { name: "通勤示例 01：固定模特完整上身搭配示意图" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "M1V2-LOOK-101对应的历史SKU" })).toBeInTheDocument();
  });
});
