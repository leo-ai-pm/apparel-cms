import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EligibilityNotice from "../app/admin/EligibilityNotice";
import type { ApprovalEligibility } from "../app/lib/admin-api";

const paused: ApprovalEligibility = {
  policy: "pause-inactive-sources-v1", eligible: false, reason_codes: ["source_inactive"],
  blocked_sources: [{ turn_id: "source-turn", occurrence_id: "source-occurrence", revision: 2, review_state: "rejected", lifecycle: "excluded" }],
  message: "引用来源含已排除或无效记录，相关新审批已暂停；重新核对不会解除，请等待人工复核。",
};

describe("approval source eligibility notice", () => {
  it.each([undefined, { ...paused, policy: "unknown-policy" }, { ...paused, eligible: true }, { ...paused, blocked_sources: [] }])(
    "closes approval for missing, unknown or contradictory eligibility: %j", eligibility => {
      render(<EligibilityNotice eligibility={eligibility} onOpenSource={vi.fn()} busy={false} />);
      expect(screen.getByRole("alert")).toHaveTextContent("审批资格不可用，当前不能批准");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByText(/未触发审批暂停/)).not.toBeInTheDocument();
    },
  );

  it("opens the actual blocked source while keeping the pause and disables that read during a request", async () => {
    const user = userEvent.setup(), open = vi.fn();
    const { rerender } = render(<EligibilityNotice eligibility={paused} onOpenSource={open} busy={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("审批已暂停，等待人工复核");
    expect(screen.getByText(/重新核对不会解除/)).toBeInTheDocument();
    expect(screen.getByText("source-occurrence")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "查看阻塞出处原话" });
    await user.click(button);
    expect(open).toHaveBeenCalledWith("source-turn", button);
    expect(screen.getByRole("alert")).toHaveTextContent("审批已暂停");
    rerender(<EligibilityNotice eligibility={paused} onOpenSource={open} busy />);
    expect(button).toBeDisabled();
  });

  it("states that allowed source eligibility still requires complete manual review", () => {
    render(<EligibilityNotice eligibility={{ ...paused, eligible: true, reason_codes: [], blocked_sources: [],
      message: "当前来源未触发暂停；仍须人工核对全部证据与出处。" }} onOpenSource={vi.fn()} busy={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("仍须逐条核对全部有效证据");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
