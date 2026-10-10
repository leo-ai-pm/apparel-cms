import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "@/features/workspace/workspace";
import { workspaceApi } from "@/features/workspace/api";
import { ApiError } from "@/lib/api/client";

vi.mock("@/features/workspace/api", () => ({ workspaceApi: { drafts: vi.fn(), packages: vi.fn(), pull: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

describe("workspace states", () => {
  it("distinguishes loading from empty, then reports no new signals", async () => {
    let finish: ((value: []) => void) | undefined;
    vi.mocked(workspaceApi.drafts).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(workspaceApi.packages).mockResolvedValue([]);
    vi.mocked(workspaceApi.pull).mockResolvedValue({ new_count: 0 });
    render(<Workspace />);
    expect(screen.getByText("正在读取工作记录…")).toBeInTheDocument();
    expect(screen.queryByText("目前没有待整理的草稿")).not.toBeInTheDocument();
    finish?.([]);
    expect(await screen.findByText("目前没有待整理的草稿")).toBeInTheDocument();
    vi.mocked(workspaceApi.drafts).mockResolvedValue([]);
    await userEvent.click(screen.getByRole("button", { name: "拉取信号" }));
    expect(await screen.findByText(/无新信号/)).toBeInTheDocument();
    expect(workspaceApi.pull).toHaveBeenCalledTimes(1);
  });
  it("provides retry and recovers after backend unavailability", async () => {
    vi.mocked(workspaceApi.drafts).mockRejectedValueOnce(new ApiError("NETWORK_ERROR", "连接中断")).mockResolvedValue([]);
    vi.mocked(workspaceApi.packages).mockResolvedValue([]);
    render(<Workspace />);
    expect(await screen.findByRole("alert")).toHaveTextContent("连接中断");
    expect(screen.getByRole("button", { name: "拉取信号" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "拉取信号" })).toBeEnabled();
  });
});
