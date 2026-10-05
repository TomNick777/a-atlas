import { describe, expect, it } from "vitest";
import { parseHybridQuery } from "../lib/hybrid/planner";
import { HYBRID_PLANNER_VERSION } from "../lib/hybrid/contracts";

/**
 * The frozen parser contract (Phase 2 §D): H1–H10 canonical plans, the frozen
 * vocabulary (time / sort / streak counts / top-N), semantic residuals,
 * numerals, ambiguity notes, unsupported intents and the §14 guarantee that
 * pure company-facts queries are never touched.
 */

const sort = (field: string, direction: "asc" | "desc") => ({ field, direction });

describe("hybrid planner — canonical H1–H10", () => {
  it("H1 今天领涨的机器人公司 → semantic=机器人, pct_change desc, semantic-first", () => {
    const plan = parseHybridQuery("今天领涨的机器人公司");
    expect(plan.unsupported).toBeNull();
    expect(plan.semantic).toEqual({ query: "机器人" });
    expect(plan.market).toMatchObject({ date: "LATEST_TRADING_DAY", filters: [], sort: sort("pctChange", "desc"), limit: null });
    expect(plan.execution).toEqual({ order: "semantic-first" });
    expect(plan.heroMetric).toEqual({ key: "pctChange", label: "涨跌幅" });
  });

  it("H2 今天成交额最大的AI芯片公司 → semantic=AI芯片, amount desc", () => {
    const plan = parseHybridQuery("今天成交额最大的AI芯片公司");
    expect(plan.semantic).toEqual({ query: "AI芯片" });
    expect(plan.market?.sort).toEqual(sort("amount", "desc"));
    expect(plan.execution.order).toBe("semantic-first");
    expect(plan.heroMetric?.key).toBe("amount");
  });

  it("H3 今天换手率最高的消费电子公司 → semantic=消费电子, turnover_rate desc", () => {
    const plan = parseHybridQuery("今天换手率最高的消费电子公司");
    expect(plan.semantic).toEqual({ query: "消费电子" });
    expect(plan.market?.sort).toEqual(sort("turnoverRate", "desc"));
  });

  it("H4 连续三个涨停的公司 → market-only, limit_up_streak >= 3, no semantic", () => {
    const plan = parseHybridQuery("连续三个涨停的公司");
    expect(plan.semantic).toBeNull();
    expect(plan.market?.filters).toEqual([{ field: "limitUpStreak", op: ">=", value: 3 }]);
    expect(plan.market?.sort).toEqual(sort("limitUpStreak", "desc"));
    expect(plan.execution.order).toBe("market-only");
    expect(plan.heroMetric?.key).toBe("limitUpStreak");
  });

  it("H5 连续三个涨停的消费类公司 → semantic=消费, streak filter, semantic-first", () => {
    const plan = parseHybridQuery("连续三个涨停的消费类公司");
    expect(plan.semantic).toEqual({ query: "消费" });
    expect(plan.market?.filters).toEqual([{ field: "limitUpStreak", op: ">=", value: 3 }]);
    expect(plan.execution.order).toBe("semantic-first");
    expect(plan.heroMetric?.key).toBe("limitUpStreak");
  });

  it("H6 最近5日涨幅最大的储能公司 → semantic=储能, return_5d desc", () => {
    const plan = parseHybridQuery("最近5日涨幅最大的储能公司");
    expect(plan.semantic).toEqual({ query: "储能" });
    expect(plan.market?.sort).toEqual(sort("return5d", "desc"));
    expect(plan.execution.order).toBe("semantic-first");
    expect(plan.heroMetric?.key).toBe("return5d");
  });

  it("H7 最近20日涨幅最大的半导体公司 → semantic=半导体, return_20d desc", () => {
    const plan = parseHybridQuery("最近20日涨幅最大的半导体公司");
    expect(plan.semantic).toEqual({ query: "半导体" });
    expect(plan.market?.sort).toEqual(sort("return20d", "desc"));
  });

  it("H8 今天明显放量的机器人公司 → volume_ratio_20d desc, no invented threshold, note recorded", () => {
    const plan = parseHybridQuery("今天明显放量的机器人公司");
    expect(plan.semantic).toEqual({ query: "机器人" });
    expect(plan.market?.sort).toEqual(sort("volumeRatio20d", "desc"));
    expect(plan.market?.filters).toEqual([]);
    expect(plan.notes.join()).toContain("不设阈值");
  });

  it("H9 今天跌幅最大的创新药公司 → semantic=创新药, pct_change asc", () => {
    const plan = parseHybridQuery("今天跌幅最大的创新药公司");
    expect(plan.semantic).toEqual({ query: "创新药" });
    expect(plan.market?.sort).toEqual(sort("pctChange", "asc"));
    expect(plan.heroMetric?.key).toBe("pctChange");
  });

  it("H10 今天成交额前20中有哪些光模块公司 → market-first, amount desc limit 20, semantic=光模块", () => {
    const plan = parseHybridQuery("今天成交额前20中有哪些光模块公司");
    expect(plan.semantic).toEqual({ query: "光模块" });
    expect(plan.market?.sort).toEqual(sort("amount", "desc"));
    expect(plan.market?.limit).toBe(20);
    expect(plan.execution.order).toBe("market-first");
    expect(plan.heroMetric?.key).toBe("amount");
  });

  it("every plan is serializable and carries the planner version", () => {
    const plan = parseHybridQuery("今天领涨的机器人公司");
    expect(JSON.parse(JSON.stringify(plan))).toMatchObject({ plannerVersion: HYBRID_PLANNER_VERSION });
  });
});

describe("hybrid planner — time vocabulary", () => {
  it.each(["最近5天", "近5日", "最近五个交易日"])("%s + 跌幅最大 → return_5d asc", (window) => {
    const plan = parseHybridQuery(`${window}跌幅最大的公司`);
    expect(plan.market?.sort).toEqual(sort("return5d", "asc"));
    expect(plan.execution.order).toBe("market-only");
  });

  it.each(["最近20天", "近20日", "最近二十个交易日"])("%s + 领涨 → return_20d desc", (window) => {
    const plan = parseHybridQuery(`${window}领涨的公司`);
    expect(plan.market?.sort).toEqual(sort("return20d", "desc"));
  });

  it("今天/今日/当前/最新交易日 are qualifiers, never intent alone", () => {
    for (const date of ["今天", "今日", "当前", "最新交易日"]) {
      expect(parseHybridQuery(`${date}做机器人的公司`).execution.order).toBe("semantic-only");
    }
  });

  it("an unmapped window with market language refuses honestly", () => {
    const plan = parseHybridQuery("最近10日涨幅最大的公司");
    expect(plan.execution.order).toBe("unsupported");
    expect(plan.unsupported?.intent).toBe("unsupported_time_window");
  });

  it("an unmapped window without market language stays on the discovery path (§14)", () => {
    expect(parseHybridQuery("最近10日签约的公司").execution.order).toBe("semantic-only");
  });

  it("a window with no sort refuses (no rankable metric)", () => {
    expect(parseHybridQuery("最近5日的公司").unsupported?.intent).toBe("window_without_sort");
  });

  it("a window over a non-return sort refuses (no 5日成交额 field exists)", () => {
    const plan = parseHybridQuery("最近5日成交额最大的公司");
    expect(plan.unsupported?.intent).toBe("window_with_unsupported_sort");
  });
});

describe("hybrid planner — sort vocabulary", () => {
  it.each([
    ["今天领涨的公司", "pctChange", "desc"],
    ["今天涨幅最大的公司", "pctChange", "desc"],
    ["今天涨得最多的公司", "pctChange", "desc"],
    ["今天领跌的公司", "pctChange", "asc"],
    ["今天跌幅最大的公司", "pctChange", "asc"],
    ["今天跌得最多的公司", "pctChange", "asc"],
    ["今天成交额最大的公司", "amount", "desc"],
    ["今天成交金额最大的公司", "amount", "desc"],
    ["今天成交量最大的公司", "volume", "desc"],
    ["今天换手率最高的公司", "turnoverRate", "desc"],
    ["今天放量最大的公司", "volumeRatio20d", "desc"],
    ["今天量比最大的公司", "volumeRatio20d", "desc"],
  ])("%s → %s %s", (query, field, direction) => {
    const plan = parseHybridQuery(query);
    expect(plan.market?.sort).toEqual(sort(field, direction as "asc" | "desc"));
    expect(plan.execution.order).toBe("market-only");
  });

  it("two sorts: leftmost wins, the later one is recorded and ignored", () => {
    const plan = parseHybridQuery("今天成交额最大且换手率最高的公司");
    expect(plan.market?.sort).toEqual(sort("amount", "desc"));
    expect(plan.notes.join()).toContain("换手率最高");
  });

  it("vague activity maps to amount desc with a recorded interpretation (§12)", () => {
    const plan = parseHybridQuery("今天交易很活跃的公司");
    expect(plan.market?.sort).toEqual(sort("amount", "desc"));
    expect(plan.execution.order).toBe("market-only");
    expect(plan.notes.join()).toContain("成交额");
  });

  it("涨得不错 parses as a sort intent, never a threshold (§12)", () => {
    const plan = parseHybridQuery("涨得不错的储能公司");
    expect(plan.market?.sort).toEqual(sort("pctChange", "desc"));
    expect(plan.market?.filters).toEqual([]);
    expect(plan.notes.join()).toContain("无冻结阈值");
  });
});

describe("hybrid planner — streak filters and numerals", () => {
  it.each([
    ["连续三个涨停的公司", 3],
    ["连续3个涨停的公司", 3],
    ["至少三个涨停的公司", 3],
    ["三个涨停的公司", 3],
    ["3个涨停的公司", 3],
    ["三连板的公司", 3],
    ["3连板的公司", 3],
    ["连续十二个涨停的公司", 12],
  ])("%s → limit_up_streak >= %i", (query, n) => {
    const plan = parseHybridQuery(query);
    expect(plan.market?.filters).toEqual([{ field: "limitUpStreak", op: ">=", value: n }]);
  });

  it("bare 连续涨停 / 连板 maps to streak >= 2 with a note", () => {
    const plan = parseHybridQuery("连板的公司");
    expect(plan.market?.filters).toEqual([{ field: "limitUpStreak", op: ">=", value: 2 }]);
    expect(plan.notes.join()).toContain("≥ 2");
  });

  it("bare 涨停 is a boolean filter, not a streak", () => {
    const plan = parseHybridQuery("今天涨停的公司");
    expect(plan.market?.filters).toEqual([{ field: "isLimitUp", op: "==", value: true }]);
  });

  it("bare 跌停 filters isLimitDown and ranks ascending", () => {
    const plan = parseHybridQuery("今天跌停的公司");
    expect(plan.market?.filters).toEqual([{ field: "isLimitDown", op: "==", value: true }]);
    expect(plan.market?.sort).toEqual(sort("pctChange", "asc"));
  });

  it("跌停连板 refuses: no such market field exists", () => {
    expect(parseHybridQuery("连续三个跌停的公司").unsupported?.intent).toBe("unsupported_market_field");
  });
});

describe("hybrid planner — top-N and market-first routing", () => {
  it.each([
    ["今天成交额前20中有哪些光模块公司", 20],
    ["今天成交额前二十的光模块公司", 20],
    ["今天成交额Top20的光模块公司", 20],
    ["今天涨幅前10的公司", 10],
    ["今天涨幅最大的前20家公司", 20],
  ])("%s → limit %i", (query, n) => {
    const plan = parseHybridQuery(query);
    expect(plan.market?.limit).toBe(n);
  });

  it("a bare top-N with a unit and no metric refuses (nothing to rank by)", () => {
    expect(parseHybridQuery("今天前20名的公司").unsupported?.intent).toBe("topn_without_metric");
  });

  it("top-N presence routes market-first; its absence routes semantic-first", () => {
    expect(parseHybridQuery("今天涨幅前10的机器人公司").execution.order).toBe("market-first");
    expect(parseHybridQuery("今天涨幅最大的机器人公司").execution.order).toBe("semantic-first");
  });
});

describe("hybrid planner — semantic residual (§4)", () => {
  it("removes market spans and filler, keeps the domain words", () => {
    expect(parseHybridQuery("今天成交额最大的机器人公司").semantic?.query).toBe("机器人");
    expect(parseHybridQuery("最近20天涨幅最大的储能公司").semantic?.query).toBe("储能");
  });

  it("generic company suffixes are stripped, real names survive (美的 stays 美的)", () => {
    expect(parseHybridQuery("今天涨幅最大的美的").semantic?.query).toBe("美的");
    expect(parseHybridQuery("今天领涨的光模块公司").semantic?.query).toBe("光模块");
  });

  it("a residual shorter than 2 chars degrades to market-only with a note", () => {
    const plan = parseHybridQuery("今天涨幅最大的股");
    expect(plan.execution.order).toBe("market-only");
    expect(plan.semantic).toBeNull();
    expect(plan.notes.join()).toContain("短于 2 字");
  });
});

describe("hybrid planner — unsupported intents (§13)", () => {
  it("future prediction refuses before any market parsing", () => {
    const plan = parseHybridQuery("明天最可能涨停的机器人公司");
    expect(plan.execution.order).toBe("unsupported");
    expect(plan.unsupported?.intent).toBe("future_market_prediction");
    expect(plan.market).toBeNull();
    expect(plan.semantic).toBeNull();
  });

  it("investment advice refuses outright", () => {
    const plan = parseHybridQuery("最值得买的AI公司");
    expect(plan.unsupported?.intent).toBe("investment_advice");
  });

  it("out-of-scope domains refuse only with market language", () => {
    expect(parseHybridQuery("今天MACD金叉的公司").unsupported?.intent).toBe("out_of_scope_domain");
    // A K-line software vendor is a legitimate company-facts query (§14).
    expect(parseHybridQuery("做K线软件的公司").execution.order).toBe("semantic-only");
  });
});

describe("hybrid planner — §14 discovery preservation", () => {
  it.each(["做工业机器人的公司", "消费电子龙头供应商", "做伺服电机的公司", "IGBT相关公司"])("%s → semantic-only, untouched", (query) => {
    const plan = parseHybridQuery(query);
    expect(plan.execution.order).toBe("semantic-only");
    expect(plan.market).toBeNull();
    expect(plan.semantic).toBeNull();
    expect(plan.heroMetric).toBeNull();
    expect(plan.notes).toEqual([]);
  });

  it("the planner is deterministic: same input, same plan bytes", () => {
    expect(JSON.stringify(parseHybridQuery("今天成交额前20中有哪些光模块公司")))
      .toBe(JSON.stringify(parseHybridQuery("今天成交额前20中有哪些光模块公司")));
  });
});
