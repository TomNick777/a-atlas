import { parseQuerySpec } from "../lib/search/querySpec";
for (const q of [
  "给数据中心做液冷散热的公司",
  "铜价上涨可能直接受益的资源类公司，不要铜加工企业",
  "人形机器人上游核心零部件，但不要整机厂",
  "AI 算力相关的硬件公司，但不要纯软件公司",
  "主要靠海外市场赚钱的中国制造业公司",
  "类似汇川技术但规模更小的公司",
]) {
  const s = parseQuerySpec(q);
  console.log(q, "\n  concepts:", s.concepts, "| exclusions:", s.exclusions, "| overseas:", s.attrs.overseasMinShare, "| province:", s.attrs.province, "| expansion:", s.expansionTerms.slice(0, 12).join(","));
}
