import { afterEach, expect, it, vi } from "vitest";
import { consumeTrainingJudgeIntent, readJudgeChoice, writeJudgeChoice } from "../components/judgePreference";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("keeps an explicit choice when browser storage is unavailable", () => {
  vi.stubGlobal("localStorage", { getItem() { throw Error("unavailable"); }, setItem() { throw Error("unavailable"); } });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  writeJudgeChoice("laya");
  expect(readJudgeChoice()).toBe("laya");
});
it("does not overwrite a newer manual choice with a delayed training directive", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.spyOn(Date, "now").mockReturnValue(2000);
  writeJudgeChoice("laya");
  expect(consumeTrainingJudgeIntent({ provider: "jev", revision: "1000000000" })).toBe(false);
  expect(readJudgeChoice()).toBe("laya");
  expect(consumeTrainingJudgeIntent({ provider: "jev", revision: "3000000000" })).toBe(true);
  expect(readJudgeChoice()).toBe("jev");
  writeJudgeChoice("laya");
  expect(consumeTrainingJudgeIntent({ provider: "jev", revision: "3000000000" })).toBe(false);
  expect(readJudgeChoice()).toBe("laya");
});
