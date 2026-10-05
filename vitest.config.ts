import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The setup guard is Phase 2.1 §14: deterministic tests fail fast on any
  // outbound network attempt. Jev Cloud is the only cloud consumer and only
  // the sanctioned live suites may reach it.
  // testTimeout 30s：facts.jsonl 已 100MB+（Phase 3.7 surface 通道并入），
  // 并行 worker 首次装载在 5s 默认下实测 flake（evidence_coverage/sourcefacts）。
  test: { environment: "node", testTimeout: 30_000, include: ["tests/**/*.test.ts"], setupFiles: ["tests/setup/no_real_jev.ts", "tests/setup/offline_embeddings.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
