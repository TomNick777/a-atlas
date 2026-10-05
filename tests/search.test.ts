import { describe, expect, it } from "vitest";
import { gridLayout } from "../components/floor/layout";
import { LruCache } from "../lib/cache";
import { normalizeCompany } from "../lib/profile";
import { constraintsFromQuery } from "../lib/search/constraints";
import { fuse, matchCount } from "../lib/search/score";
import { expandQuery, tokensOf } from "../lib/text/tokenize";
import type { Company } from "../lib/types";

describe("tokens", () => {
  it("splits Chinese into bigrams and keeps the code digits", () => {
    expect(tokensOf("光刻胶")).toEqual(["光刻", "刻胶", "光", "刻", "胶"]);
    expect(tokensOf("AI芯片")).toContain("ai");
  });

  it("expands a category into the product words companies actually use", () => {
    expect(expandQuery("做机器人的公司")).toContain("谐波减速器");
    expect(expandQuery("光刻胶")).toBe("光刻胶");
  });
});

describe("constraints", () => {
  it("reads a province and an exclusion out of the sentence", () => {
    expect(constraintsFromQuery("山东的高端制造企业").province).toBe("山东");
    expect(constraintsFromQuery("不要纯软件公司").dropIndustries).toContain("软件");
    expect(constraintsFromQuery("做光刻胶的公司").province).toBeNull();
    expect(constraintsFromQuery("主营汽车动力系统").dropIndustries).toContain("整车");
  });
});

describe("profile", () => {
  it("keeps the security identity and derives search text from the filing", () => {
    const company = normalizeCompany({
      code: "338",
      name: "潍柴动力",
      marketCap: 100,
      profile: {
        公司名称: "潍柴动力股份有限公司",
        所属行业: "汽车零部件",
        办公地址: "山东省潍坊市",
        主营业务: "发动机、变速器",
        机构简介: "动力总成供应商",
      },
      zyjs: { 主营业务: "内燃机及动力总成" },
      zygc: [
        { 报告日期: "2024-12-31", 分类类型: "按产品分类", 主营构成: "发动机", 收入比例: 0.6 },
        { 报告日期: "2024-12-31", 分类类型: "按地区分类", 主营构成: "境外", 主营收入: 30 },
        { 报告日期: "2024-12-31", 分类类型: "按地区分类", 主营构成: "境内", 主营收入: 70 },
      ],
      concepts: ["融资融券", "机器人"],
      industryBoard: "汽车",
      swLevel1Industry: "机械设备",
    });
    expect(company.code).toBe("000338");
    expect(company.exchange).toBe("SZ");
    expect(company.region.province).toBe("山东");
    expect(company.concepts).toEqual(["机器人"]);
    expect(company.mainProducts[0]?.name).toBe("发动机");
    expect(company.overseasRevenueShare).toBe(0.3);
    expect(company.swLevel1Industry).toBe("机械设备");
    expect(company.searchableText).toContain("潍柴动力");
    expect(company.searchableText).toContain("机械设备");
    expect(company.judgeText).toContain("行业：汽车零部件/机械设备");
    expect(company.judgeText.length).toBeLessThanOrEqual(420);
    expect(company.judgeTextEn).toBeNull();
  });

  it("marks companies outside the Shenwan tables as unknown instead of guessing", () => {
    const company = normalizeCompany({ code: "920001", name: "某北交所", profile: { 公司名称: "某北交所股份有限公司" } });
    expect(company.swLevel1Industry).toBe("unknown");
    expect(company.exchange).toBe("BJ");
    expect(company.searchableText).not.toContain("unknown");
  });
});

describe("score", () => {
  it("sorts by the displayed percent and drops the wrong province", () => {
    const companies = [
      { code: "1", name: "甲", region: { province: "山东", city: "" }, industry: "机械", businessDescription: "制造", marketCap: 1 },
      { code: "2", name: "乙", region: { province: "广东", city: "" }, industry: "软件", businessDescription: "软件开发", marketCap: 9 },
    ] as Company[];
    const ranked = fuse(companies, [0, 1], [0.4, 0.9], { province: "山东", dropIndustries: ["软件"], exclusions: [] });
    expect(ranked[0]?.index).toBe(0);
    expect(ranked[1]?.probability).toBe(0);
    expect(matchCount(ranked)).toBeGreaterThan(0);
  });
});

describe("layout", () => {
  it("keeps every cell inside a box above the bar", () => {
    const layout = gridLayout(8, { x: 600, above: 400 }, { width: 1200 }, { w: 140, h: 86 });
    expect(layout.box).not.toBeNull();
    expect(layout.rests).toHaveLength(8);
    for (const rest of layout.rests) {
      expect(rest.y).toBeLessThan(400);
      expect(rest.w).toBeGreaterThan(0);
    }
  });
});

describe("cache", () => {
  it("forgets the oldest entry", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });
});
