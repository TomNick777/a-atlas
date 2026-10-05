/**
 * Canonical Phase 2 queries (task sheet §10) — the shared preset table for the
 * hybrid:query CLI, the semantic fixture refresh, and the Jev live suite.
 * Data only: no I/O, no execution.
 */
export const HYBRID_PRESETS: Record<string, string> = {
  H1: "今天领涨的机器人公司",
  H2: "今天成交额最大的AI芯片公司",
  H3: "今天换手率最高的消费电子公司",
  H4: "连续三个涨停的公司",
  H5: "连续三个涨停的消费类公司",
  H6: "最近5日涨幅最大的储能公司",
  H7: "最近20日涨幅最大的半导体公司",
  H8: "今天明显放量的机器人公司",
  H9: "今天跌幅最大的创新药公司",
  H10: "今天成交额前20中有哪些光模块公司",
};
