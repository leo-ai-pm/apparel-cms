import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FixedOutfitPanel } from "../components/fixed-outfit-panel";
import { parseFixedOutfit } from "../app/lib/fixed-outfits";
import { outfit } from "./fixed-outfit-fixtures";

describe("固定搭配冻结资料展示", () => {
  it("历史无字段明确未记录，不借当前资料补当时版本", () => {
    render(<FixedOutfitPanel outfit={parseFixedOutfit(outfit())} current={false} disabled={false} onAction={vi.fn()} onReturnCurrent={vi.fn()} />);
    const details = screen.getByText("查看版本与商品资料").parentElement!;
    const labels = within(details);
    expect(labels.getByText("生成当时的资料快照").nextElementSibling).toHaveTextContent("历史未记录");
    expect(labels.getByText("当时资料修订").nextElementSibling).toHaveTextContent("历史未记录");
    expect(labels.getByText("当时条件来源").nextElementSibling).toHaveTextContent("历史未记录");
  });

  it("展示该Look自己的binding、版本与来源，不展示身体值或真实试穿", () => {
    const frozen = parseFixedOutfit({ ...outfit(), profile_snapshot: { profile_contract: "consumer_profile_v1", recorded: true,
      snapshot_id: "ps-look-original", profile_id: "profile-original", profile_version: 3, snapshot_digest: "c".repeat(64),
      field_sources: { "usual_sizes.top": "saved_profile", "usual_sizes.shoes": "explicit_selection", scene: "current_request", budget_max_fen: "explicit_text" } } });
    render(<FixedOutfitPanel outfit={frozen} current disabled={false} onAction={vi.fn()} onReturnCurrent={vi.fn()} />);
    expect(screen.getByText("ps-look-original")).toBeInTheDocument();
    expect(screen.getByText("当时资料修订").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("当时条件来源").nextElementSibling).toHaveTextContent("上衣尺码：已保存资料；鞋码：本次明确选择；场景：当前对话条件；整套预算：本次明确原话");
    expect(screen.getByText("当时资料绑定摘要").nextElementSibling).toHaveTextContent("c".repeat(64));
    expect(screen.queryByText(/身高|体重/)).not.toBeInTheDocument();
  });
});
