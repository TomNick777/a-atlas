import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stage 3 semiconductor-enrichment-universe:候选池构建(规格第二节)。
 *
 * 信号源(全部来自已缓存数据,零网络):
 *   1. raw 快照 zyjs/zygc 的产品级词面(主营业务/产品类型/产品名称/主营构成全部报告期)
 *   2. V2 profile 的 semiconductorSegment 派生 + 半导体概念标签
 *   3. 冻结基准 v3_search_benchmark 的半导体族 rel3/rel2(含硬负)
 *   4. 申万一级行业=电子
 *
 * LEVEL A = 产品级强证据的设备/材料制造者 → Tier1 年报深度 enrichment
 * LEVEL B = 疑似相关(半导体业务词面/硬负观察) → 至少核对 1 个已缓存权威来源
 * LEVEL C = 仅词面可能相关 → 保留现有 Profile
 *
 * 人工 seed(coverage audit anchor,不参与排名):规格点名的 8 家。
 * Usage: npx tsx scripts/stage3_universe.ts
 */

const root = process.cwd();
const OUT_DIR = path.join(root, "data", "enrichment", "semiconductor");

type CompanyRow = {
  code: string;
  name: string;
  industry: string;
  swLevel1Industry: string;
  businessDescription: string;
  mainProducts: { name: string; revenueShare?: number }[];
};

type RawCompany = {
  zyjs?: { 主营业务?: string; 产品类型?: string; 产品名称?: string; 经营范围?: string } | null;
  zygc?: { 报告日期?: number; 分类类型?: string; 主营构成?: string }[] | null;
};

type BenchRow = { query_id: string; family: string; query: string; relevant3: { code: string }[]; relevant2: { code: string }[] };

// —— 词面表(领域词汇,不含任何公司词) ——
const EQUIP_WORDS = [
  "刻蚀", "蚀刻", "CVD", "PVD", "ALD", "PECVD", "LPCVD", "SACVD", "MOCVD", "薄膜沉积", "薄膜设备", "镀膜",
  "外延", "清洗设备", "单片清洗", "槽式清洗", "湿法", "CMP", "化学机械抛光", "抛光机", "涂胶显影", "Track设备",
  "离子注入", "注入机", "光刻机", "光刻设备", "直写光刻", "纳米压印", "减薄", "划片", "键合机", "固晶", "焊接机",
  "测试机", "测试系统", "分选机", "探针台", "探针卡", "ATE", "老化测试", "量测", "缺陷检测", "缺陷检查",
  "炉管", "立式炉", "氧化炉", "扩散炉", "退火", "快速热处理", "晶体生长", "长晶", "封装设备", "贴片机",
  "半导体设备", "半导体装备", "晶圆制造设备", "集成电路设备", "电子工艺装备",
];
const MATERIAL_WORDS = [
  "硅片", "抛光片", "外延片", "衬底", "光刻胶", "掩膜版", "掩模版", "光罩", "靶材", "电子特气", "特种气体",
  "高纯气体", "湿电子化学品", "超纯试剂", "蚀刻液", "刻蚀液", "清洗液", "抛光液", "抛光垫", "前驱体", "MO源",
  "电子级", "石英", "坩埚", "引线框架", "封装基板", "载板", "键合线", "金线", "碳化硅", "氮化镓", "砷化镓",
  "半导体材料", "电子化学品",
];
const SEMI_WORDS = ["半导体", "集成电路", "芯片", "晶圆", "微机电", "MEMS", "封测", "封装测试", "化合物半导体"];
const DESIGN_WORDS = ["芯片设计", "集成电路设计", "IP核", "EDA", "设计服务"];
const FOUNDRY_WORDS = ["晶圆代工", "晶圆制造", "集成电路制造", "芯片制造"];
const OSAT_WORDS = ["封装测试", "封测", "封装代工", "封装厂"];
const PV_WORDS = ["光伏", "太阳能电池", "电池片", "硅片切割", "组件"];
const DISPLAY_WORDS = ["面板", "显示器件", "OLED设备", "液晶", "平板显示"];
const PCB_WORDS = ["印制电路板", "PCB", "覆铜板", "电路板"];

// 基准半导体族(rel3=相关,rel2=部分相关/易混淆)
const BENCH_SEMI_FAMILIES = ["EV-IND-SEM-EQUIP2", "EV-IND-SEM-PROCESS", "T-IND-SEMIEQUIP", "TR-CHAIN-SEMIMAT"];

// 人工 coverage-audit seed(规格点名;只影响审计,不影响分层规则本身)
const SEED: Record<string, string> = {
  "688012": "中微公司", "002371": "北方华创", "688072": "拓荆科技", "688082": "盛美上海",
  "688120": "华海清科", "688037": "芯源微", "688361": "中科飞测", "688200": "华峰测控",
};

function hits(text: string | undefined | null, words: string[]): string[] {
  if (!text) return [];
  return words.filter((w) => text.includes(w));
}

type UniverseEntry = {
  code: string;
  name: string;
  swLevel1: string;
  industry: string;
  level: "A" | "B" | "C" | "EXCLUDE";
  reasons: string[];
  signals: {
    productEquipWords: string[];
    productMaterialWords: string[];
    textEquipWords: string[];
    derivedSegment: string[];
    conceptTags: string[];
    benchmarkRel3Families: string[];
    benchmarkRel2Families: string[];
    hardNegativeWatch: string[];
  };
  seed?: string;
};

function main() {
  const doc = JSON.parse(readFileSync(path.join(root, "data", "companies.json"), "utf8")) as { companies: CompanyRow[] };
  const profiles = JSON.parse(readFileSync(path.join(root, "data", "search_profiles_v2.json"), "utf8")) as Record<string, {
    derived: { dimension: string; value: string }[];
    semantic: { semanticTags: { tag: string }[] };
  }>;
  const bench: BenchRow[] = readFileSync(path.join(root, "data", "eval", "v3_search_benchmark.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const rel3 = new Map<string, Set<string>>();
  const rel2 = new Map<string, Set<string>>();
  for (const row of bench) {
    if (!BENCH_SEMI_FAMILIES.includes(row.family)) continue;
    for (const { code } of row.relevant3) rel3.set(code, (rel3.get(code) ?? new Set()).add(row.family));
    for (const { code } of row.relevant2) rel2.set(code, (rel2.get(code) ?? new Set()).add(row.family));
  }

  const entries: UniverseEntry[] = [];
  for (const company of doc.companies) {
    const rawFile = path.join(root, "data", "raw", "companies", `${company.code}.json`);
    const raw: RawCompany = existsSync(rawFile) ? JSON.parse(readFileSync(rawFile, "utf8")) : {};
    const profile = profiles[company.code];
    const reasons: string[] = [];
    const hardNegativeWatch: string[] = [];

    const zyjsProduct = [raw.zyjs?.产品类型, raw.zyjs?.产品名称].filter(Boolean).join("、");
    const zyjsBiz = raw.zyjs?.主营业务 ?? "";
    const zygcProducts = [...new Set((raw.zygc ?? [])
      .filter((r) => r["分类类型"] === "按产品分类" && r["主营构成"])
      .map((r) => String(r["主营构成"])))].join("、");
    const companyProducts = company.mainProducts.map((p) => p.name).join("、");
    const biz = company.businessDescription ?? "";
    const productText = [zyjsProduct, zygcProducts, companyProducts].join("、");
    const fullText = [zyjsBiz, biz].join("。");

    const productEquip = hits(productText, EQUIP_WORDS);
    const productMaterial = hits(productText, MATERIAL_WORDS);
    const textEquip = hits(fullText, EQUIP_WORDS).filter((w) => !productEquip.includes(w));
    const semiWords = hits(`${fullText}、${productText}`, SEMI_WORDS);
    const derivedSegment = (profile?.derived ?? []).filter((d) => d.dimension === "semiconductorSegment").map((d) => d.value);
    const conceptTags = (profile?.semantic?.semanticTags ?? []).filter((t) => /半导体|AI硬件|消费电子/.test(t.tag)).map((t) => t.tag);

    const rel3Families = [...(rel3.get(company.code) ?? [])];
    const rel2Families = [...(rel2.get(company.code) ?? [])];

    for (const [domain, words] of [["pv", PV_WORDS], ["display", DISPLAY_WORDS], ["pcb", PCB_WORDS], ["foundry", FOUNDRY_WORDS], ["osat", OSAT_WORDS], ["design", DESIGN_WORDS]] as const) {
      const h = hits(`${fullText}、${productText}`, [...words]);
      if (h.length) hardNegativeWatch.push(`${domain}:${h[0]}`);
    }

    if (productEquip.length) reasons.push(`productEquipWord=${productEquip.slice(0, 4).join("/")}`);
    if (productMaterial.length) reasons.push(`productMaterialWord=${productMaterial.slice(0, 4).join("/")}`);
    if (textEquip.length) reasons.push(`bizEquipWord=${textEquip.slice(0, 3).join("/")}`);
    if (derivedSegment.length) reasons.push(`derived=${derivedSegment.slice(0, 3).join("/")}`);
    if (conceptTags.length) reasons.push(`searchTag=${conceptTags.join("/")}`);
    for (const f of rel3Families) reasons.push(`benchmarkRelevant=${f}`);
    for (const f of rel2Families) reasons.push(`benchmarkPartial=${f}`);
    reasons.push(`swLevel1=${company.swLevel1Industry}`);
    if (semiWords.length) reasons.push(`semiWord=${semiWords.slice(0, 2).join("/")}`);

    // —— 分层规则 ——
    // A:产品级设备/材料词面 + 半导体语境(基准 rel3 可单独成立;派生标签不单独成立,
    //    防「电池封装」类 semi:packaging 误触发把电池/照明厂拉进 A)
    const strongPositive =
      ((productEquip.length || productMaterial.length) && (semiWords.length || derivedSegment.length || rel3Families.length)) ||
      rel3Families.length > 0;
    const isSemiAdjacent =
      semiWords.length > 0 || rel2Families.length > 0 ||
      derivedSegment.length > 0 ||
      (company.swLevel1Industry === "电子" && (semiWords.length > 0 || derivedSegment.length > 0));
    // 硬负观察:域词必须伴随设备/材料词面或基准 rel2(港口提「光伏」不算)
    const hardNegWatch =
      hardNegativeWatch.some((h) => /^(pv|display|pcb)/.test(h)) &&
      (productEquip.length > 0 || productMaterial.length > 0 || textEquip.length > 0 || rel2Families.length > 0) &&
      !strongPositive;

    let level: UniverseEntry["level"];
    if (strongPositive) level = "A";
    else if (isSemiAdjacent || hardNegWatch || rel2Families.length) level = "B";
    else if (conceptTags.length || hits(company.name, ["半导体", "微电子", "芯片", "微电"]).length) level = "C";
    else level = "EXCLUDE";

    const entry: UniverseEntry = {
      code: company.code,
      name: company.name,
      swLevel1: company.swLevel1Industry,
      industry: company.industry,
      level,
      reasons,
      signals: {
        productEquipWords: productEquip,
        productMaterialWords: productMaterial,
        textEquipWords: textEquip,
        derivedSegment,
        conceptTags,
        benchmarkRel3Families: rel3Families,
        benchmarkRel2Families: rel2Families,
        hardNegativeWatch,
      },
    };
    if (SEED[company.code]) {
      entry.seed = SEED[company.code];
      if (level === "EXCLUDE") {
        // seed 只是把已知名拉进审计视野;level 仍按证据走,不为 seed 造 A
        entry.level = "B";
        entry.reasons.push("seed=coverage-audit-anchor");
      } else entry.reasons.push(`seed=${SEED[company.code]}`);
    }
    entries.push(entry);
  }

  const counts = { A: 0, B: 0, C: 0, EXCLUDE: 0 };
  for (const e of entries) counts[e.level] += 1;

  mkdirSync(OUT_DIR, { recursive: true });
  const universe = {
    universeId: "semiconductor-enrichment-universe",
    version: "stage3-v1",
    builtAt: new Date().toISOString(),
    source: {
      rawSnapshots: "data/raw/companies/*(zyjs/zygc)",
      profile: "data/search_profiles_v2.json",
      benchmark: "data/eval/v3_search_benchmark.jsonl(semiconductor families)",
    },
    levelRule: {
      A: "产品级设备/材料词面 + 半导体语境(或基准 rel3 / 既有 semiconductorSegment 派生)→ Tier1 年报深度 enrichment",
      B: "半导体业务词面 / 基准 rel2 / 硬负观察(光伏/显示/PCB/代工/封测/设计)→ 核对已缓存权威来源(zyjs/zygc, filing-derived)",
      C: "仅概念标签或公司名词面 → 保留现有 Profile,不抓取",
      EXCLUDE: "无任何信号",
    },
    counts,
    total: entries.length,
    seedNote: "seed 8 家为规格点名的 coverage audit anchor;只保证进入审计视野,不参与分层排名规则。",
    companies: entries.filter((e) => e.level !== "EXCLUDE"),
  };
  writeFileSync(path.join(OUT_DIR, "universe.json"), JSON.stringify(universe, null, 1) + "\n");

  console.log(`universe: ${entries.filter((e) => e.level !== "EXCLUDE").length} / ${entries.length} companies`);
  console.log(`  A(deep Tier1): ${counts.A}`);
  console.log(`  B(check cached source): ${counts.B}`);
  console.log(`  C(surface only): ${counts.C}`);
  for (const code of Object.keys(SEED)) {
    const e = entries.find((x) => x.code === code);
    console.log(`  seed ${code} ${e?.name}: level=${e?.level} reasons=${e?.reasons.slice(0, 3).join("; ")}`);
  }
}

main();
