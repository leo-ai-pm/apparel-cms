import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DraftEditor } from "@/features/workspace/draft-editor";
import { draft } from "./fixtures";

function setup(busy: string | null = null) {
  const onPublish = vi.fn().mockResolvedValue(false);
  const onSave = vi.fn().mockResolvedValue(true);
  const onDirty = vi.fn();
  render(<DraftEditor draft={draft} busy={busy} onPublish={onPublish} onSave={onSave} onDirty={onDirty} />);
  return { onPublish, onSave, onDirty, user: userEvent.setup() };
}

describe("human confirmation", () => {
  it("blocks an empty description and focuses the field", async () => {
    const { user, onPublish } = setup();
    await user.click(screen.getByRole("button", { name: "确认并回传" }));
    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请填写需求描述");
    expect(screen.getByLabelText(/需求描述/)).toHaveFocus();
  });
  it("keeps edited fields on a failed publish", async () => {
    const { user, onPublish } = setup();
    await user.type(screen.getByLabelText(/需求描述/), "通勤秋装需求");
    await user.click(screen.getByLabelText(/认定为真实款式需求/));
    await user.click(screen.getByRole("button", { name: "确认并回传" }));
    expect(onPublish).toHaveBeenCalledWith({ requirement_desc: "通勤秋装需求", constraints: ["秋装"], style_demand: true, priority: "P3", priority_basis: draft.priority_basis });
    expect(screen.getByLabelText(/需求描述/)).toHaveValue("通勤秋装需求");
    expect(screen.getByText("有未保存的修改")).toBeInTheDocument();
  });
  it("saves incomplete drafts without publishing", async () => {
    const { user, onSave, onPublish } = setup();
    await user.type(screen.getByLabelText(/设计约束/), "\n预算500以内");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(onSave).toHaveBeenCalledWith({ requirement_desc: "", constraints: ["秋装", "预算500以内"], style_demand: false, priority: "P3", priority_basis: draft.priority_basis });
    expect(onPublish).not.toHaveBeenCalled();
    expect(screen.getByText("草稿已保存")).toBeInTheDocument();
  });
  it("disables edits and repeated submission while publishing", () => {
    setup("publish");
    expect(screen.getByRole("button", { name: "确认并回传" })).toBeDisabled();
    expect(screen.getByLabelText(/需求描述/)).toBeDisabled();
    expect(screen.getByLabelText(/认定为真实款式需求/)).not.toBeChecked();
  });
});
