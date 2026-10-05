import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stage 3 frozen semiconductor-process benchmark(规格第二十一节)。
 *
 * 冻结纪律:
 *   - 在 enrichment 写入任何 Profile 之前定稿;rel3 = 必须命中的真实工艺能力公司,
 *     rel2 = 部分相关/易混淆,negativeWatch = Top20 内出现即记混淆的硬负样本。
 *   - 标签来源 = 冻结时点的行业公知公司事实(规格点名的公司 + 招股书/年报可证),
 *     与被测 enrichment 独立 —— enrichment 标不出 ≠ 删标签;分歧进报告,不改基准。
 *   - 与 data/eval/v3_search_benchmark.jsonl 的 EV-IND-SEM-* 族互补:那些测
 *     「半导体设备」大类,这里测工艺级(CCP/ICP/PECVD/ALD/单片清洗/CMP/涂胶显影…)
 *     与关系级(设备≠材料≠设计≠晶圆厂≠光伏/显示/PCB/封测)。
 */

const root = process.cwd();
const OUT = path.join(root, "data", "eval", "stage3_semiconductor_benchmark.jsonl");
const MANIFEST_OUT = path.join(root, "data", "eval", "stage3_benchmark_manifest.json");

const BENCHMARK_ID = "stage3-semiconductor-v1";

const rel = (codes: string[]) => codes.map((code) => ({ code }));
const watch = (entries: [string, string][]) => entries.map(([code, reason]) => ({ code, reason }));

// —— 工艺能力集合(冻结标签) ——
const ETCH = ["688012", "002371"]; // 中微(CCP/ICP 刻蚀),北方华创(刻蚀产品线)
const DEP_CVD = ["688072", "002371", "688012"]; // 拓荆(PECVD/ALD/SACVD),北方华创(LPCVD 等),中微(LPCVD)
const DEP_ALD = ["688072", "002371"];
const DEP_PVD = ["002371"]; // 北方华创(溅射/PVD)
const DEP_MOCVD = ["688012"]; // 中微(氮化镓基 LED MOCVD 领先)
const CLEAN = ["688082", "002371", "603690", "688037"]; // 盛美,北方华创,至纯(湿法),芯源微(前道清洗)
const CMP_EQUIP = ["688120"]; // 华海清科
const CMP_MAT = ["688019", "300054"]; // 安集(抛光液),鼎龙(抛光垫)
const TRACK = ["688037"]; // 芯源微
const IMPLANT = ["600641"]; // 先导基电(凯世通 离子注入机)
const THERMAL = ["002371", "688729"]; // 北方华创(立式炉),屹唐(快速热处理)
const TEST_ATE = ["688200", "300604"]; // 华峰测控,长川科技
const TEST_PROBE = ["301629", "300604"]; // 矽电股份(探针台),长川科技
const METROLOGY = ["688361", "300567"]; // 中科飞测,精测电子(半导体量检测)
const PKG_EQUIP = ["688383", "600520"]; // 新益昌(固晶机),三佳科技(封装装备)
const GROWTH = ["688478", "300316"]; // 晶升股份(晶体生长设备),晶盛机电(半导体长晶炉)
const SILICON_WAFER = ["688126", "605358", "688432", "003026"];
const MAT_CORE = ["688019", "300054", "300666", "300346", "688268"]; // CMP 材料/靶材/前驱体光刻胶/特气

const EQUIP_UNION = [...new Set([...ETCH, ...DEP_CVD, ...DEP_PVD, ...DEP_MOCVD, ...CLEAN, ...CMP_EQUIP, ...TRACK, ...IMPLANT, ...THERMAL, ...PKG_EQUIP, ...GROWTH])];
const TEST_UNION = [...new Set([...TEST_ATE, ...TEST_PROBE, ...METROLOGY])];

type Family = {
  id: string;
  category: "process_word" | "combo_semantic" | "hard_negative";
  queries: string[];
  relevant3: string[];
  relevant2?: string[];
  negativeWatch?: [string, string][];
};

const FAMILIES: Family[] = [
  {
    id: "S3-ETCH", category: "process_word",
    queries: ["做刻蚀设备的公司", "半导体刻蚀设备厂商", "生产等离子刻蚀机的企业"],
    relevant3: ETCH, relevant2: ["688729"],
  },
  {
    id: "S3-ETCH-CCP", category: "process_word",
    queries: ["做 CCP 刻蚀设备的公司", "CCP 或 ICP 刻蚀设备厂商", "电容耦合等离子体刻蚀设备企业"],
    relevant3: ["688012"], relevant2: ["002371"],
  },
  {
    id: "S3-DEP-CVD", category: "process_word",
    queries: ["半导体薄膜沉积设备厂商", "做 CVD 设备的公司", "生产化学气相沉积设备的企业"],
    relevant3: DEP_CVD, relevant2: ["688082"],
  },
  {
    id: "S3-DEP-ALD", category: "process_word",
    queries: ["做 ALD 设备的公司", "原子层沉积设备厂商", "生产 ALD 薄膜设备的企业"],
    relevant3: DEP_ALD,
  },
  {
    id: "S3-DEP-PVD", category: "process_word",
    queries: ["半导体 PVD 设备公司", "做物理气相沉积设备的企业", "溅射镀膜设备厂商"],
    relevant3: DEP_PVD, relevant2: ["301392", "300706"],
    negativeWatch: [["300706", "material"], ["301392", "not_semiconductor"]],
  },
  {
    id: "S3-DEP-MOCVD", category: "process_word",
    queries: ["做 MOCVD 设备的公司", "生产 MOCVD 外延设备的厂商", "氮化镓 MOCVD 设备企业"],
    relevant3: DEP_MOCVD, relevant2: [],
    negativeWatch: [["600703", "mocvd_user"]],
  },
  {
    id: "S3-CLEAN", category: "process_word",
    queries: ["半导体清洗设备公司", "做单片清洗设备的企业", "生产半导体湿法清洗设备的厂商"],
    relevant3: CLEAN, relevant2: ["300316"],
  },
  {
    id: "S3-CMP-EQUIP", category: "process_word",
    queries: ["CMP 设备公司", "做化学机械抛光设备的企业", "生产晶圆 CMP 设备的厂商"],
    relevant3: CMP_EQUIP, relevant2: CMP_MAT,
    negativeWatch: [["688019", "material"], ["300054", "material"]],
  },
  {
    id: "S3-CMP-MATERIAL", category: "process_word",
    queries: ["CMP 抛光液抛光垫材料公司", "做化学机械抛光材料的企业", "生产 CMP 耗材的厂商"],
    relevant3: CMP_MAT, relevant2: CMP_EQUIP,
    negativeWatch: [["688120", "equipment"]],
  },
  {
    id: "S3-TRACK", category: "process_word",
    queries: ["涂胶显影设备公司", "做 Track 设备的企业", "生产光刻涂胶显影设备的厂商"],
    relevant3: TRACK,
  },
  {
    id: "S3-IMPLANT", category: "process_word",
    queries: ["离子注入设备公司", "做离子注入机的企业", "生产半导体离子注入设备的厂商"],
    relevant3: IMPLANT,
  },
  {
    id: "S3-THERMAL", category: "process_word",
    queries: ["半导体炉管设备公司", "做立式炉或快速热处理设备的企业", "生产氧化扩散炉的厂商"],
    relevant3: THERMAL, relevant2: ["688082", "300316"],
  },
  {
    id: "S3-TEST-ATE", category: "process_word",
    queries: ["半导体测试机公司", "做 ATE 测试设备的企业", "生产集成电路测试系统的厂商"],
    relevant3: TEST_ATE, relevant2: ["301369"],
  },
  {
    id: "S3-TEST-PROBE", category: "process_word",
    queries: ["探针台公司", "做晶圆探针测试台的企业", "生产探针卡的厂商"],
    relevant3: TEST_PROBE, relevant2: TEST_ATE,
  },
  {
    id: "S3-METROLOGY", category: "process_word",
    queries: ["半导体量测设备公司", "做晶圆缺陷检测设备的企业", "生产半导体量测检测装备的厂商"],
    relevant3: METROLOGY, relevant2: ["603283"],
  },
  {
    id: "S3-PKG-EQUIP", category: "process_word",
    queries: ["封装设备公司", "做固晶机焊线机的企业", "生产半导体封装设备的厂商"],
    relevant3: PKG_EQUIP,
  },
  {
    id: "S3-GROWTH", category: "process_word",
    queries: ["半导体晶体生长设备公司", "做长晶炉的企业", "生产硅单晶炉的厂商"],
    relevant3: GROWTH,
  },
  {
    id: "S3-SILICONWAFER", category: "process_word",
    queries: ["半导体硅片公司", "做晶圆衬底片的企业", "生产半导体抛光片外延片的厂商"],
    relevant3: SILICON_WAFER, relevant2: ["600703", "605111"],
  },
  {
    id: "S3-MAT-CORE", category: "process_word",
    queries: ["半导体材料公司", "做靶材电子特气抛光液的企业", "给晶圆厂供应材料的厂商"],
    relevant3: MAT_CORE, relevant2: ["600206", "603078", "688106", "603688", "300395"],
  },
  // —— 组合语义 ——
  {
    id: "S3-FRONTEND", category: "combo_semantic",
    queries: ["半导体前道设备公司", "给晶圆制造供设备的企业", "晶圆加工设备制造商"],
    relevant3: EQUIP_UNION, relevant2: [...TEST_UNION, "920725"],
    negativeWatch: [["688981", "wafer_fab"], ["688347", "wafer_fab"]],
  },
  {
    id: "S3-DOMESTIC", category: "combo_semantic",
    queries: ["国产半导体设备公司", "半导体设备国产替代的厂商", "国产晶圆制造设备企业"],
    relevant3: [...EQUIP_UNION, ...TEST_UNION], relevant2: ["920725"],
    negativeWatch: [["603501", "chip_design"], ["603986", "chip_design"]],
  },
  {
    id: "S3-PROC-CORE", category: "combo_semantic",
    queries: [
      "专门做半导体清洗、刻蚀或者薄膜沉积设备的公司",
      "主营业务是刻蚀、清洗或薄膜沉积设备的厂商",
      "做半导体工艺设备(清洗/刻蚀/沉积)的企业",
    ],
    relevant3: ["688012", "002371", "688072", "688082", "603690", "688037"],
    relevant2: ["688120", "688729", "600641"],
  },
  // —— 硬负(规格第十三节/二十一号清单) ——
  {
    id: "S3-NEG-DESIGN", category: "hard_negative",
    queries: ["做半导体设备的公司，不要芯片设计", "半导体设备厂商，排除芯片设计公司", "卖制造设备的半导体企业，不是设计公司"],
    relevant3: EQUIP_UNION,
    negativeWatch: [["603501", "chip_design"], ["603986", "chip_design"], ["300661", "chip_design"], ["605111", "chip_design"]],
  },
  {
    id: "S3-NEG-WAFERFAB", category: "hard_negative",
    queries: ["给晶圆厂卖设备的公司，不是晶圆厂", "半导体制造设备厂商，排除晶圆代工厂", "做工艺设备的企业，不是造芯片的"],
    relevant3: EQUIP_UNION,
    negativeWatch: [["688981", "wafer_fab"], ["688347", "wafer_fab"], ["688249", "wafer_fab"], ["600460", "wafer_fab"]],
  },
  {
    id: "S3-NEG-MATERIAL", category: "hard_negative",
    queries: ["半导体设备公司，不要材料公司", "做半导体制造装备的企业，排除材料商", "卖设备的半导体公司，不是卖材料的"],
    relevant3: EQUIP_UNION,
    negativeWatch: [["688019", "material"], ["300054", "material"], ["300666", "material"], ["688126", "material"], ["688268", "material"]],
  },
  {
    id: "S3-NEG-PV", category: "hard_negative",
    queries: ["半导体工艺设备公司，不是光伏设备", "做晶圆制造设备的企业，排除太阳能电池设备", "半导体设备厂商，不要光伏组件设备"],
    relevant3: EQUIP_UNION,
    negativeWatch: [["300724", "pv_equipment"], ["300751", "pv_equipment"], ["300776", "pv_equipment"]],
  },
  {
    id: "S3-NEG-DISPLAY", category: "hard_negative",
    queries: ["半导体检测设备公司，不是面板检测", "做晶圆量测设备的企业，排除显示面板检测", "半导体缺陷检测设备厂商，不是显示器检测"],
    relevant3: METROLOGY,
    negativeWatch: [["300545", "display_equipment"]],
  },
  {
    id: "S3-NEG-OSAT", category: "hard_negative",
    queries: ["卖半导体制造设备的公司，不是封测厂", "半导体设备厂商，排除封装测试代工", "做设备的企业，不是做封测服务的"],
    relevant3: EQUIP_UNION,
    negativeWatch: [["600584", "osat"], ["002156", "osat"], ["002185", "osat"], ["688362", "osat"]],
  },
  {
    id: "S3-NEG-PCB", category: "hard_negative",
    queries: ["做芯片制造设备的公司，不是印制电路板", "半导体设备厂商，排除 PCB 企业", "晶圆工艺设备公司，不是电路板厂"],
    relevant3: EQUIP_UNION,
    negativeWatch: [["002463", "pcb"], ["002916", "pcb"], ["600183", "pcb"], ["002938", "pcb"]],
  },
];

function main() {
  const companies = JSON.parse(readFileSync(path.join(root, "data", "companies.json"), "utf8")).companies as { code: string; name: string }[];
  const nameOf = new Map(companies.map((c) => [c.code, c.name]));
  const rows: Record<string, unknown>[] = [];
  for (const family of FAMILIES) {
    family.queries.forEach((query, qi) => {
      const unknown3 = family.relevant3.filter((c) => !nameOf.has(c));
      const unknown2 = (family.relevant2 ?? []).filter((c) => !nameOf.has(c));
      if (unknown3.length || unknown2.length) {
        throw new Error(`family ${family.id}: unknown codes ${[...unknown3, ...unknown2].join(",")}`);
      }
      rows.push({
        query_id: `${family.id}::q${qi}`,
        family: family.id,
        category: family.category,
        benchmark: BENCHMARK_ID,
        query,
        relevant3: rel(family.relevant3),
        relevant2: rel(family.relevant2 ?? []),
        ...(family.negativeWatch ? { negativeWatch: watch(family.negativeWatch) } : {}),
      });
    });
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const manifest = {
    benchmark: BENCHMARK_ID,
    frozenAt: new Date().toISOString(),
    families: FAMILIES.length,
    queries: rows.length,
    categoryCounts: Object.fromEntries(
      ["process_word", "combo_semantic", "hard_negative"].map((c) => [c, FAMILIES.filter((f) => f.category === c).reduce((s, f) => s + f.queries.length, 0)]),
    ),
    labelCount3: new Set(FAMILIES.flatMap((f) => f.relevant3)).size,
    labelCount2: new Set(FAMILIES.flatMap((f) => f.relevant2 ?? [])).size,
    negativeWatchCount: new Set(FAMILIES.flatMap((f) => (f.negativeWatch ?? []).map(([c]) => c))).size,
    freezeRule:
      "在 enrichment 写入任何 Profile 前冻结;标签=冻结时点行业公知公司事实,与被测 enrichment 独立;分歧记录不改基准。",
  };
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`frozen benchmark: ${rows.length} queries / ${FAMILIES.length} families → ${path.relative(root, OUT)}`);
  console.log(`labels: rel3=${manifest.labelCount3} companies, rel2=${manifest.labelCount2}, negativeWatch=${manifest.negativeWatchCount}`);
}

main();
