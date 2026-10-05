/** Provinces and the common short names a query might use. Longest match wins. */
const PROVINCES: [string, string][] = [
  ["内蒙古", "内蒙古"],
  ["黑龙江", "黑龙江"],
  ["新疆", "新疆"],
  ["西藏", "西藏"],
  ["广西", "广西"],
  ["宁夏", "宁夏"],
  ["北京", "北京"],
  ["天津", "天津"],
  ["上海", "上海"],
  ["重庆", "重庆"],
  ["河北", "河北"],
  ["山西", "山西"],
  ["辽宁", "辽宁"],
  ["吉林", "吉林"],
  ["江苏", "江苏"],
  ["浙江", "浙江"],
  ["安徽", "安徽"],
  ["福建", "福建"],
  ["江西", "江西"],
  ["山东", "山东"],
  ["河南", "河南"],
  ["湖北", "湖北"],
  ["湖南", "湖南"],
  ["广东", "广东"],
  ["海南", "海南"],
  ["四川", "四川"],
  ["贵州", "贵州"],
  ["云南", "云南"],
  ["陕西", "陕西"],
  ["甘肃", "甘肃"],
  ["青海", "青海"],
  ["香港", "香港"],
  ["澳门", "澳门"],
  ["台湾", "台湾"],
];

const DROP_RULES: { pattern: RegExp; industry: string }[] = [
  { pattern: /不要[^，。]{0,8}软件|排除[^，。]{0,6}软件|不是[^，。]{0,6}软件|非纯?软件/, industry: "软件" },
  { pattern: /不要[^，。]{0,8}整车|不是整车|排除整车/, industry: "整车" },
  { pattern: /不制造芯片|不做芯片|本身不(生产|制造)芯片/, industry: "芯片制造" },
];

import { exclusionCompanyPatterns, parseQuerySpec } from "./querySpec";

export type Constraints = {
  province: string | null;
  dropIndustries: string[];
  /** Ontology exclusion types parsed from the query (e.g. 铜加工, 机器人整机). */
  exclusions: string[];
};

/** Hard facts pulled out of the words themselves. Jev does not own these. */
export function constraintsFromQuery(query: string): Constraints {
  const province = PROVINCES.find(([needle]) => query.includes(needle))?.[1] ?? null;
  const dropIndustries = DROP_RULES.filter((rule) => rule.pattern.test(query)).map((rule) => rule.industry);
  // A powertrain request is about the system, not the company that sells the finished vehicle.
  if (/动力系统|动力总成/.test(query) && !/整车/.test(query) && !dropIndustries.includes("整车")) dropIndustries.push("整车");
  const spec = parseQuerySpec(query);
  return { province, dropIndustries, exclusions: spec.exclusions };
}

export function provinceInText(text: string): string {
  return PROVINCES.find(([needle]) => text.includes(needle))?.[1] ?? "";
}

const SOFTWARE = /软件|信息技术|互联网/;
const OEM = /整车|乘用车|商用车制造/;
const CHIP_MAKER = /晶圆代工|芯片设计|集成电路设计|集成电路有关的设计/;
const CHIP_MATERIAL = /材料|光刻胶|抛光|试剂|电子化学品|CMP|靶材/;

export function industryHitsDrop(industry: string, business: string, drop: string): boolean {
  const text = `${industry} ${business}`;
  if (drop === "软件") return SOFTWARE.test(text) && !/设备|硬件|服务器|光模块|PCB|印制电路|温控|电路板/.test(text);
  if (drop === "整车") return OEM.test(text);
  if (drop === "芯片制造") return CHIP_MAKER.test(text) && !CHIP_MATERIAL.test(text);
  return false;
}
