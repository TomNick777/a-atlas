"""Generate reports/GRADER_FIX_LABEL_DIFF.md from the three-arm regrade artifacts.

Reads data/eval/grader_fix_label_diff.json + data/train/v4_1_regraded_preview.jsonl
and renders the label-diff audit: transition matrices (grader effect vs knowledge
drift, never mixed), per-family breakdown, the per-row 半导体光刻胶 table (§十二)
and the other contamination families (§十三).

Usage: .venv/Scripts/python scripts/make_grader_fix_label_diff_md.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from laya_v4_roles import load_enrichment  # noqa: E402

DIFF = json.loads((ROOT / "data/eval/grader_fix_label_diff.json").read_text(encoding="utf-8"))
PREVIEW = [json.loads(l) for l in (ROOT / "data/train/v4_1_regraded_preview.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
ENRICHMENT = load_enrichment()
OUT = ROOT / "reports/GRADER_FIX_LABEL_DIFF.md"

LABEL_NAME = {0: "无关(0)", 1: "沾边(1)", 2: "次匹配(2)", 3: "直接相关(3)"}


def transition_rows(matrix: dict[str, int]) -> list[str]:
    order = ["0->0", "0->1", "0->2", "0->3", "1->0", "1->1", "1->2", "1->3",
             "2->0", "2->1", "2->2", "2->3", "3->0", "3->1", "3->2", "3->3"]
    lines = ["| 原始→新 | 行数 |", "| --- | --- |"]
    for k in order:
        if matrix.get(k):
            lines.append(f"| {k} | {matrix[k]} |")
    return lines


def main() -> None:
    total = DIFF["totalRows"]
    go_total = DIFF["graderOriginRows"]
    go_changed = DIFF["graderOriginRelabeled"]
    t_v2 = DIFF["transitions_v2_vs_original_graderOrigin"]
    t_v1 = DIFF["transitions_v1fresh_vs_original_graderOrigin"]
    t_other = DIFF["transitions_nonGraderOrigin_divergence"]
    by_family = DIFF["byFamily_graderOrigin"]

    # ---- §十二: 半导体光刻胶 per-row ----
    pr_rows = [r for r in PREVIEW if r["query"] == "半导体光刻胶" and r.get("graderOriginRow")]
    pr_changed = [r for r in pr_rows if r["labelOriginal"] != r["labelV2"]]
    pr_lines = ["| 公司 | 代码 | caps(process,role,subtype) | 原标签C | v1+新知识A | v2 B | 判定 |", "| --- | --- | --- | --- | --- | --- | --- |"]
    pr_dist_c = Counter(r["labelOriginal"] for r in pr_rows)
    pr_dist_b = Counter(r["labelV2"] for r in pr_rows)
    dist_c_str = json.dumps({str(k): v for k, v in sorted(pr_dist_c.items(), key=lambda kv: str(kv[0]))}, ensure_ascii=False)
    dist_b_str = json.dumps({str(k): v for k, v in sorted(pr_dist_b.items(), key=lambda kv: str(kv[0]))}, ensure_ascii=False)
    for r in sorted(pr_rows, key=lambda x: (x["labelV2"] or -1, x["name"])):
        caps = ", ".join(f"({c.get('process') or '-'},{(c.get('role') or '?')[:4]},{c.get('equipmentType') or c.get('materialType') or c.get('componentType') or '-'})"
                         for c in (ENRICHMENT.get(r["code"], {}).get("processCapabilities") or [])) or "no caps"
        verdict = "不变" if r["labelOriginal"] == r["labelV2"] else "改标"
        pr_lines.append(f"| {r['name']} | {r['code']} | {caps} | {r['labelOriginal']} | {r['labelV1Fresh']} | {r['labelV2']} | {verdict} |")

    # per-query diffs for the §十三 families
    def fam_block(fam: str, title: str) -> list[str]:
        m = by_family.get(fam)
        if not m:
            return [f"### {title}", "", "(历史训练语料零覆盖 —— v2 补词面后自下次 mine 起生效,本轮无行可改)", ""]
        changed = sum(v for k, v in m.items() if "->" in k and k.split("->")[0] != k.split("->")[1])
        out = [f"### {title}", "", f"grader-origin 行 {sum(m.values())} 行,其中改标 {changed} 行:", ""]
        out += transition_rows(m)
        out.append("")
        return out

    md = [
        "# GRADER_FIX_LABEL_DIFF — role-grader-v2 三臂重标审计",
        "",
        f"生成:`scripts/regrade_train_pairs.py` → `data/eval/grader_fix_label_diff.json` / `data/train/v4_1_regraded_preview.jsonl`;graderVersion = `{DIFF['graderVersion']}`。",
        "",
        "## 1. 协议与总量",
        "",
        "三臂:C=数据集冻结标签 / A=role-grader-v1+stage3.2知识(v1-fresh 快照,升级前落盘)/ B=role-grader-v2+stage3.2知识。",
        "**B−A = 纯 grader 修复效应;A−C = 知识版本漂移(stage3.1→3.2),两者分开归因,绝不混算。**",
        "",
        "| 项 | 值 |",
        "| --- | --- |",
        f"| 去重 (query,code) 总行数(=v4 base 7923 + v4.1 A/B 纠正层) | {total} |",
        f"| grader-origin 行(category=v4-role-contrast,尺子自己的行) | {go_total} |",
        f"| 其中 v2 改标 | **{go_changed}**({go_changed / go_total:.1%}) |",
        f"| 非 grader-origin 行(P0-mined/P2-inherit/P3/C1-C3,标签权威非本尺子) | {total - go_total}(label 一律保留原值,B 只入审计列) |",
        f"| 缺 v1-fresh 快照的行(公司不在 semiconductor enrichment,如实计数) | {DIFF['rowsMissingV1Snapshot']} |",
        "",
        "## 2. 转移矩阵(纯 grader 效应,grader-origin 行)",
        "",
    ]
    md += transition_rows(t_v2)
    md += ["", f"合计改标 {sum(v for k, v in t_v2.items() if k.split('->')[0] != k.split('->')[1])} 行;不变 "
                f"{sum(v for k, v in t_v2.items() if k.split('->')[0] == k.split('->')[1])} 行。",
           "",
           "### 知识漂移对照(A−C,stage3.1→3.2 的效应,与 grader 无关)",
           ""]
    md += transition_rows(t_v1)
    md += ["", f"知识漂移合计改标 {sum(v for k, v in t_v1.items() if k.split('->')[0] != k.split('->')[1])} 行 —— 量级小(94 行)且方向中性(Stage 3.2 归属收紧的已知效应,如 *ST沐邦/强一股份的 cap 收缩),与本轮 693 行 grader 效应分离。",
           "",
           "### 非 grader-origin 行的分歧(仅登记,不改标)",
           "",
           "这些行的标签权威是跨域 grader / miner queue / V3 继承;v2 列只作旁证。分歧大户是跨域 query(锂电池正极负极材料企业、高端白酒品牌公司等)—— role grader 本来就域盲,域判定归 cross-domain 尺子:",
           ""]
    md += transition_rows(t_other)
    md += ["", "## 3. 按 family 分解(§十一)", "",
           "| family | 总行 | 改标 | 主转移 | 解读 |", "| --- | --- | --- | --- | --- |"]
    readings = {
        "photoresist": "真PR 1→3(16 行),同族干扰 1→2(64 行)——方向性反转修复",
        "precursor": "无 process 证据的 precursor 1→3(10 行),干扰 1→2(70 行)——qualifier 语义",
        "target_material": "无 process 证据的靶材 1→3(5 行),干扰 1→2(75 行)",
        "CMP_slurry": "slurry 1→3(5 行),干扰 1→2(75 行)",
        "CMP_pad": "pad 1→3(2 行),干扰 1→2(78 行)",
        "electronic_special_gas": "零改标(v1 本来就干净)—— 对照组",
        "wet_chemicals": "见 diff 明细(1→2 为主)",
        "silicon_wafer": "零改标 —— 对照组",
        "other": "设备/零部件/排除式等 query:1→0(77,离子注入机公司角色统一)、3→0(60,不要材料公司排除修复)、0→1(62,邻带)、3→2(36)等",
    }
    for fam, m in sorted(by_family.items(), key=lambda kv: -sum(v for k, v in kv[1].items() if k.split('->')[0] != k.split('->')[1])):
        changed = sum(v for k, v in m.items() if k.split("->")[0] != k.split("->")[1])
        md.append(f"| {fam} | {sum(m.values())} | {changed} | {json.dumps(m, ensure_ascii=False)} | {readings.get(fam, '')} |")
    md += ["",
           "刻蚀液/蚀刻液/清洗液:历史训练语料零覆盖(§五 修复自下次 mine 起生效),故 family 表中不出现。",
           "",
           "## 4. §十二 半导体光刻胶逐行复核(107 行 claim 的逐行对账)",
           "",
           f"去重后 (query=半导体光刻胶, grader-origin) 共 **{len(pr_rows)} 行**(= V4 107 行 role-contrast claim 全集;另有 2 行 v4-random 非尺子行,不在此表)。标签分布 C={dist_c_str} → B={dist_b_str}:**grade-3 从 0 → {pr_dist_b.get(3, 0)},grade-1 从 {pr_dist_c.get(1, 0)} → {pr_dist_b.get(1, 0)}**。",
           "B 侧 1 行 None = 云南锗业(002428):Stage 3.2 重派生已将其清出 semiconductor enrichment(v1-fresh 同为 None)——纯知识漂移,非 grader 效应。",
           "",
           "注意 §十二 纪律:不预设所有真公司 grade 3 —— 按各公司 Profile evidence 判。表中 grade-2 的公司是 Profile 里 photoresist 证据不足/次级窗口的公司(如安集科技 photoresist cap 缺失时按次匹配),这正是 v2 逐行按 evidence 而非按名单打标的结果。",
           ""]
    md += pr_lines
    md += ["", "## 5. §十三 其他家族污染审计结论", "",
           "- **刻蚀液/清洗液**:训练/考卷语料零覆盖 → 无历史标签污染;损害形态是 v1 把这两类 query 误判为装备 intent(实时 mine/eval 时),v2 已补词面+qualifier。",
           "- **外延片**:12 行 grader-origin(1→3 / 干扰转移),已随 typed span 修复。",
           "- **CMP抛光液/垫、ALD前驱体、PVD靶材**:qualifier 变体污染(无 process 证据的真材料公司被判 1,与装备商同带),共改标约 340 行,方向全部反转修复。",
           "- **对照组(electronic_special_gas / silicon_wafer)**:零改标 —— v1 在这些 family 上本来就正确,佐证 693 行改标不是全局洗牌而是靶向修复。",
           "- **离子注入机公司(1→0,77 行)**:v1 对「机公司」后缀漏配 equipment role(v1 只有 机厂商/机企业);v2 统一后材料公司从邻带 1 落到角色不符 0 —— 与 v1 在「光刻机」query 下材料公司=0 的既有语义一致。",
           "- **半导体设备企业，不要材料公司(3→0,59+7 行)**:v1 不解析「不要」排除式,材料公司被判 3(污染);v2 排除修复。",
           "- 新发现的 v1 缺陷(query 不可解析时全部 cap 判 3)已在 v2 的 gradeable guard 内消除,但**历史 P0-mined/P2 行不受影响**(标签权威非本尺子)。",
           ""]
    OUT.write_text("\n".join(md), encoding="utf-8")
    print(f"wrote {OUT}: {len(pr_rows)} photoresist rows, {go_changed} grader-origin relabels")


if __name__ == "__main__":
    main()
