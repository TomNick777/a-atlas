import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Python venv ships third-party .js bundles.
    ".venv/**",
    // Vendored Vibe backend (Phase 2): independent Python service + its own TS
    // spikes; governed by upstream license, not by the A-Atlas lint ruleset.
    "services/vibe-research/**",
  ]),
]);

export default eslintConfig;
