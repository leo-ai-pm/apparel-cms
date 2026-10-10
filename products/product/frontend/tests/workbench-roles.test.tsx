import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductWorkbench } from "@/features/workbench-preview/product-workbench";

afterEach(() => vi.unstubAllGlobals());

function setup(role: "staff" | "manager") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ configured: false, tools: {} }) }));
  return render(<ProductWorkbench role={role} username={role === "staff" ? "product" : "manager"} displayName={role === "staff" ? "小林" : "产品负责人"} />);
}

describe("workbench role navigation", () => {
  it("keeps the product staff in their assigned work area", async () => {
    setup("staff");
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: /我的任务/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /审批中心/ })).not.toBeInTheDocument();
    await userEvent.setup().click(within(nav).getByRole("button", { name: /需求雷达/ }));
    expect(screen.getByRole("button", { name: /查看我的任务/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /审批中心/ })).not.toBeInTheDocument();
  });

  it("keeps the manager in the approval work area", async () => {
    setup("manager");
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: /审批中心/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /我的任务/ })).not.toBeInTheDocument();
    await userEvent.setup().click(within(nav).getByRole("button", { name: /需求雷达/ }));
    expect(screen.getByRole("button", { name: /查看审批中心/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /我的任务/ })).not.toBeInTheDocument();
  });

  it("guides the manager from an empty review queue to pending assignment", async () => {
    setup("manager");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /批准并交设计/ }));
    expect(screen.getByRole("heading", { name: "待终审已处理完" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /查看待分派/ }));
    expect(screen.getByRole("button", { name: /确认线索并分派/ })).toBeInTheDocument();
  });
});
