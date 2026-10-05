import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// Explicit code-only CI scope. Full npm test still requires the private data;
// it never silently skips a missing dataset or a frozen regression fixture.
export default mergeConfig(base, defineConfig({
  test: {
    exclude: [
      "tests/atlas-company.test.ts",
      "tests/corpus.test.ts",
      "tests/discovery.test.ts",
      "tests/evidence_coverage.test.ts",
      "tests/evidence_grounding.test.ts",
      "tests/evidence_surface.test.ts",
      "tests/evidence_explain.test.ts",
      "tests/evidence_view.test.ts",
      "tests/hybrid_execute.test.ts",
      "tests/hybrid_suite_offline.test.ts",
      "tests/jev_payload_contract.test.ts",
      "tests/market_freshness.test.ts",
      "tests/market_answer_cache.test.ts",
      "tests/market_live.test.ts",
      "tests/market_query.test.ts",
      "tests/p_suite.test.ts",
      "tests/quality_discovery.test.ts",
      "tests/sourcefacts.test.ts",
      "tests/sourcefacts_pass2.test.ts",
      "tests/stockdata_contracts.test.ts",
      "tests/telemetry_usage.test.ts",
    ],
  },
}));
