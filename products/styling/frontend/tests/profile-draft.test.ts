import { describe, expect, it } from "vitest";
import { applyProfileDraft, removeProfileDraft, profileDraftLine, EMPTY_PROFILE_DRAFT } from "../app/lib/profile-draft";

describe("未保存的本次选择", () => {
  it("保留用户原话且不补未选身体字段", () => {
    expect(applyProfileDraft("明天通勤", { ...EMPTY_PROFILE_DRAFT, top: "S", budget_fen: 50000 }))
      .toBe("明天通勤\n【本次选择（未保存）】上衣S，预算500元");
  });
  it("再次编辑只替换选择行，不积累旧预算，不擅自改写用户原话", () => {
    const text = applyProfileDraft("希望宽松，上衣我通常穿L", { ...EMPTY_PROFILE_DRAFT, top: "S", budget_fen: 80000 });
    expect(applyProfileDraft(text, { ...EMPTY_PROFILE_DRAFT, top: "M", budget_fen: 50001 }, profileDraftLine({ ...EMPTY_PROFILE_DRAFT, top: "S", budget_fen: 80000 })))
      .toBe("希望宽松，上衣我通常穿L\n【本次选择（未保存）】上衣M，预算500.01元");
  });
  it("清空选择保留原文；全空不生成默认数据", () => {
    const original = "通勤\n请舒服一点";
    const text = applyProfileDraft(original, { ...EMPTY_PROFILE_DRAFT, shoes: 39 });
    expect(removeProfileDraft(text, profileDraftLine({ ...EMPTY_PROFILE_DRAFT, shoes: 39 }))).toBe(original);
    expect(applyProfileDraft(text, EMPTY_PROFILE_DRAFT, profileDraftLine({ ...EMPTY_PROFILE_DRAFT, shoes: 39 }))).toBe(original);
    expect(applyProfileDraft("", EMPTY_PROFILE_DRAFT)).toBe("");
  });
});
