import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FrozenSources from "../app/admin/FrozenSources";
import type { HandoffMetadata, SourceSnapshot } from "../app/lib/admin-api";

const source: SourceSnapshot = {
  turn: { id: "historical-source", session_id: "synthetic-session", text: "批准时的原话：冬天居家想要修身裤子", status: "extracted",
    extractor: "rules-v2", data_origin: "simulation_fixture", created_at: "2026-10-09T04:31:02.114005Z", error_code: "", extraction_attempts: 1, negative_preferences: [] },
  occurrences: [{ id: "historical-occurrence", turn_id: "historical-source", group_key: "source-group", title: "冬季居家修身裤子", description: "来源当时的需求",
    attributes: { season: "冬", scene: "居家", category: "裤子", fit: "修身", silhouette: null }, review_state: "pending", reason: "", revision: 1, lifecycle: "active",
    normalizer_version: "rules-v2", context_turn_ids: [], field_sources: { scene: ["historical-source"] } }],
};

describe("approved source snapshots", () => {
  it("separately identifies missing historical version and snapshot without fetching current data", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    render(<FrozenSources metadata={{}} onOpenCurrent={vi.fn()} busy={false} />);
    expect(screen.getAllByText(/历史未记录/)).toHaveLength(2);
    expect(screen.queryByText(/没有外部出处/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看当前出处" })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("distinguishes an explicitly empty external set from unrecorded history", () => {
    render(<FrozenSources metadata={{ evidence_digest_version: "target-evidence-v1", source_snapshot: [] }} onOpenCurrent={vi.fn()} busy={false} />);
    expect(screen.getByText("target-evidence-v1")).toBeInTheDocument();
    expect(screen.getByText(/批准当时没有外部出处/)).toBeInTheDocument();
    expect(screen.queryByText(/历史未记录/)).not.toBeInTheDocument();
  });

  it.each([
    null,
    { turn: source.turn, occurrences: [] },
    [{ turn: "invalid", occurrences: [] }],
    [{ turn: source.turn, occurrences: [{ ...source.occurrences[0], attributes: { fit: { invented: true } } }] }],
  ])("rejects malformed frozen data without rendering invented source values: %j", source_snapshot => {
    const metadata = { evidence_digest_version: "resolved-sources-v1", source_snapshot } as unknown as HandoffMetadata;
    render(<FrozenSources metadata={metadata} onOpenCurrent={vi.fn()} busy={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("冻结出处快照格式异常，当前不可用");
    expect(screen.queryByRole("button", { name: "查看当前出处" })).not.toBeInTheDocument();
  });

  it("preserves the approved text and opens a separate current source using its ID and actual button", async () => {
    const user = userEvent.setup(), onOpenCurrent = vi.fn();
    const metadata: HandoffMetadata = { evidence_digest_version: "resolved-sources-v1", source_snapshot: [source] };
    const { rerender } = render(<FrozenSources metadata={metadata} onOpenCurrent={onOpenCurrent} busy={false} />);
    expect(screen.getByText(source.turn.text)).toBeInTheDocument();
    expect(screen.getByText(/不代表目标某字段唯一对应/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "查看当前出处" });
    await user.click(button);
    expect(onOpenCurrent).toHaveBeenCalledWith("historical-source", button);
    expect(screen.getByText(source.turn.text)).toBeInTheDocument();
    rerender(<FrozenSources metadata={metadata} onOpenCurrent={onOpenCurrent} busy />);
    expect(screen.getByRole("button", { name: "查看当前出处" })).toBeDisabled();
  });

  it("shows absent nested fields as unrecorded rather than inferring them", () => {
    const metadata = { source_snapshot: [{ turn: {}, occurrences: [{ id: "old-occurrence" }] }] } as unknown as HandoffMetadata;
    render(<FrozenSources metadata={metadata} onOpenCurrent={vi.fn()} busy={false} />);
    expect(screen.getAllByText("历史未记录").length).toBeGreaterThan(2);
    expect(screen.getByRole("button", { name: "查看当前出处" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
