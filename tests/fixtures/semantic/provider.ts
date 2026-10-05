/**
 * FixtureSemanticProvider — offline replay of the semantic engine from
 * committed capture fixtures (Phase 2.1 §5/§8).
 *
 * Fail-closed by design: a query with no fixture is a test-authoring error and
 * throws with the refresh command — it must NEVER fall through to a live Jev
 * call, otherwise intentional and accidental API consumption become
 * indistinguishable.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SemanticOutcome } from "../../../lib/hybrid/execute";

const ROOT = resolve(__dirname);

let indexCache: Record<string, string> | null = null;

function index(): Record<string, string> {
  return (indexCache ??= JSON.parse(readFileSync(resolve(ROOT, "index.json"), "utf8")) as Record<string, string>);
}

export type RetrievalFixture = {
  fixtureSchema: string;
  query: string;
  operation: string;
  responseContract: string;
  provenance: Record<string, unknown>;
  result: Omit<SemanticOutcome, "searchId">;
};

export function loadRetrievalFixture(query: string): RetrievalFixture {
  const rel = index()[query];
  if (!rel) {
    throw new Error(
      `no semantic fixture covers「${query}」 — deterministic tests must not ask Jev (§8). ` +
        `Refresh with: npm run semantic:fixtures:refresh -- --query "${query}", or inject a synthetic engine.`,
    );
  }
  const file = resolve(ROOT, rel);
  if (!existsSync(file)) throw new Error(`semantic fixture index points at missing file ${rel} — re-run: npm run semantic:fixtures:refresh -- --query "${query}"`);
  return JSON.parse(readFileSync(file, "utf8")) as RetrievalFixture;
}

/** The executor's semanticEngine DI, backed by committed captures. */
export function fixtureSemanticEngine(): (query: string) => SemanticOutcome {
  return (query: string): SemanticOutcome => {
    const doc = loadRetrievalFixture(query);
    return { ...doc.result, searchId: `fixture:${doc.query}` };
  };
}
