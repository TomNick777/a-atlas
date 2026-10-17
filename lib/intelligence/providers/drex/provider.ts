import { drexKey, drexModel } from "../../../env";
import { JevCloudProvider, type JevTimingOverrides } from "../jev/cloud";
import type { BudgetKind, JevCall } from "../../contracts";

/** Explicit, pinned Nace judge; no Jev credentials or automatic fallback. */
export class DrexProvider extends JevCloudProvider {
  constructor(overrides: JevTimingOverrides = {}) {
    super(overrides, {
      id: "drex", model: drexModel, key: drexKey,
      endpoint: () => "https://console.nace.ai/v1/systemone",
      requireModel: true,
    });
  }
  /** Nace accepts textual instructions. Preserve the capability's full JSON
   * content without changing its facts, criteria, question IDs or shared state. */
  override ask<T>(body: Record<string, unknown>, kind: BudgetKind, options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<JevCall<T>> {
    const questions = body.questions;
    if (!questions || typeof questions !== "object" || Array.isArray(questions)) return super.ask<T>(body, kind, options);
    const encoded = Object.fromEntries(Object.entries(questions).map(([id, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [id, value];
      const question = value as Record<string, unknown>;
      const instructions = question.instructions;
      return [id, instructions !== null && typeof instructions === "object"
        ? { ...question, instructions: JSON.stringify(instructions) }
        : question];
    }));
    return super.ask<T>({ ...body, questions: encoded }, kind, options);
  }
}
const state = globalThis as unknown as { __atlasDrex?: DrexProvider };
export const getDrexProvider = () => state.__atlasDrex ??= new DrexProvider();
