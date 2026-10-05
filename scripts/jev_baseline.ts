/**
 * Jev Cloud baseline probe (Phase 4 §12 timeout / §15 rate limit / §44 latency).
 *
 * Nothing here is a guess: every budget in lib/jev is derived from the numbers
 * this script prints. Payloads are built the way the production judge builds them
 * (same chunk size, same profile source, real Top-200 pools taken from
 * data/search_log), so the measured latency is the latency search will pay.
 *
 * Read-only against the cloud: no writes, no state. The key is never printed.
 *
 *   npx tsx scripts/jev_baseline.ts            # full probe (~35 calls)
 *   npx tsx scripts/jev_baseline.ts --quick    # auth + 100-batch only (4 calls)
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Company } from "../lib/types";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

type Args = { quick: boolean };
const args: Args = { quick: process.argv.slice(2).includes("--quick") };

const ENDPOINT = process.env.JEV_BASE_URL?.trim() || "https://api.typesafe.ai/v1/systemone";
const KEY = process.env.TYPESAFE_API_KEY?.trim() || "";
const MODEL = process.env.JEV_MODEL?.trim() || "jev-latest";

const HOW =
  "looking_for 是一个人用自己的话说想找的公司。" +
  "每一题是一家候选公司，profile 是它的公开业务资料。" +
  "判断这家公司的主营业务是否就是这句话在找的东西。" +
  "概念标签沾边但主营无关，回答要低。" +
  "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。" +
  "几家公司可以同时符合。";

type Call = {
  label: string;
  kind: "noul" | "score" | "error-probe";
  batch: number;
  status: number | null;
  outcome: string;
  ms: number;
  inputTokens: number | null;
  outputTokens: number | null;
  answered: number | null;
  bytesRequest: number;
  note?: string;
};

const calls: Call[] = [];

function pct(sorted: number[], f: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
}

async function ask(
  label: string,
  kind: "noul" | "score",
  query: string,
  companies: Company[],
  opts: { timeoutMs?: number; key?: string; bodyOverride?: unknown } = {},
): Promise<{ ok: boolean; scores: number[]; model: string | null }> {
  const questions: Record<string, unknown> = {};
  companies.forEach((company, index) => {
    questions[`c${index}`] =
      kind === "noul"
        ? {
            type: "noul",
            instructions: {
              company: { name: company.name, code: company.code, profile: company.searchProfileText || company.judgeText },
              question: "company 是否符合 looking_for 要找的公司？",
              yes: "主营业务就是这句话在找的，地域等硬条件也对得上。",
              no: "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
            },
          }
        : {
            type: "score",
            instructions: {
              company: { name: company.name, code: company.code, profile: company.searchProfileText || company.judgeText },
              question: "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。",
            },
            criteria: ["0=无关", "1=沾边", "2=部分相关", "3=直接相关"],
          };
  });
  const body = opts.bodyOverride ?? { model: MODEL, state: { looking_for: query.slice(0, 300), how_to_judge: HOW }, questions };
  const payload = JSON.stringify(body);
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.key ?? KEY}`, "content-type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    const ms = Math.round(performance.now() - started);
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 160);
      try {
        const j = JSON.parse(text) as { detail?: unknown; error?: unknown };
        detail = JSON.stringify(j.detail ?? j.error ?? j).slice(0, 160);
      } catch {
        /* keep raw prefix */
      }
      calls.push({
        label,
        kind,
        batch: companies.length,
        status: response.status,
        outcome: response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "unauthorized" : response.status >= 500 ? "server_error" : "http_error",
        ms,
        inputTokens: null,
        outputTokens: null,
        answered: null,
        bytesRequest: payload.length,
        note: detail,
      });
      return { ok: false, scores: [], model: null };
    }
    const data = JSON.parse(text) as {
      model?: string;
      answers?: Record<string, { noul?: number; score?: number }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const answers = data.answers ?? {};
    const scores = companies.map((_, index) => answers[`c${index}`]?.[kind === "noul" ? "noul" : "score"] ?? 0.5);
    calls.push({
      label,
      kind,
      batch: companies.length,
      status: response.status,
      outcome: "ok",
      ms,
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      answered: Object.keys(answers).length,
      bytesRequest: payload.length,
      note: data.model,
    });
    return { ok: true, scores, model: data.model ?? null };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const aborted = error instanceof Error && error.name === "AbortError";
    calls.push({
      label,
      kind,
      batch: companies.length,
      status: null,
      outcome: aborted ? "timeout" : "network_error",
      ms,
      inputTokens: null,
      outputTokens: null,
      answered: null,
      bytesRequest: payload.length,
      note: error instanceof Error ? error.name : String(error),
    });
    return { ok: false, scores: [], model: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Real Top-200 candidate pools, straight from the production search log. */
function poolsFromSearchLog(companies: Company[], want: string[]): Map<string, Company[]> {
  const byCode = new Map(companies.map((c) => [c.code, c]));
  const file = path.join(process.cwd(), "data", "search_log", "search_log.jsonl");
  const out = new Map<string, Company[]>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").trim().split(/\r?\n/)) {
    let row: { query?: { raw?: string }; retrieval?: { fusedTop200?: string[] } };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const raw = row.query?.raw ?? "";
    const codes = row.retrieval?.fusedTop200 ?? [];
    if (!codes.length) continue;
    for (const wantQuery of want) {
      if (raw !== wantQuery || out.has(wantQuery)) continue;
      out.set(
        wantQuery,
        codes.map((code) => byCode.get(code)).filter((c): c is Company => Boolean(c)),
      );
    }
  }
  return out;
}

async function main() {
  if (!KEY) {
    console.error("TYPESAFE_API_KEY is empty — Jev Cloud cannot be probed. Configure the key first.");
    process.exit(2);
  }
  const dataset = JSON.parse(readFileSync(path.join(process.cwd(), "data", "companies.json"), "utf8")) as { companies: Company[] };
  const profilesPath = path.join(process.cwd(), "data", "search_profiles_v3.json");
  const profiles: Record<string, { searchText?: string }> = existsSync(profilesPath)
    ? (JSON.parse(readFileSync(profilesPath, "utf8")) as Record<string, { searchText?: string }>)
    : {};
  const companies = dataset.companies.map((c) => ({ ...c, searchProfileText: profiles[c.code]?.searchText ?? c.searchProfileText ?? null }));
  console.log(`dataset=${companies.length} endpoint=${ENDPOINT.replace(/^https?:\/\//, "").split("/")[0]} model=${MODEL} keyLen=${KEY.length}`);

  const ACCEPTANCE = ["光刻胶", "谐波减速器", "机器人", "半导体设备", "液冷", "做铜矿开采和冶炼的公司，不要加工企业"];
  const pools = poolsFromSearchLog(companies, ACCEPTANCE);
  const poolOf = (q: string): Company[] => pools.get(q) ?? companies.slice(0, 200);
  console.log(`pools from search_log: ${[...pools.keys()].join(" / ") || "(none — falling back to dataset order)"}`);

  // --- A. auth + identity: one tiny call. Confirms the key works and which model answers.
  const auth = await ask("A-auth", "noul", "光刻胶", poolOf("光刻胶").slice(0, 3));
  console.log(`A-auth ok=${auth.ok} model=${auth.model}`);
  if (!auth.ok) {
    console.error("A-auth failed — aborting probe. Fix key/endpoint before measuring budgets.");
    report(companies.length);
    process.exit(1);
  }

  if (args.quick) {
    await ask("Q-batch100-noul", "noul", "光刻胶", poolOf("光刻胶").slice(0, 100));
    await ask("Q-batch100-noul", "noul", "光刻胶", poolOf("光刻胶").slice(0, 100));
    report(companies.length);
    return;
  }

  // --- B. latency vs batch size (noul). Production sends chunks of 100, so 100 is the number that matters.
  for (const size of [10, 25, 50, 100]) {
    for (let rep = 0; rep < 3; rep++) {
      const q = ACCEPTANCE[rep % ACCEPTANCE.length];
      await ask(`B-size${size}`, "noul", q, poolOf(q).slice(0, size));
    }
  }

  // --- C. the graded head (score) at production batch size: is it available on the cloud, and what does it cost?
  for (let rep = 0; rep < 3; rep++) {
    await ask(`C-score100`, "score", ACCEPTANCE[rep], poolOf(ACCEPTANCE[rep]).slice(0, 100));
  }

  // --- D. production shape end-to-end: 200 candidates = 2 chunks fired together (what search actually does).
  for (let rep = 0; rep < 4; rep++) {
    const q = ACCEPTANCE[rep % ACCEPTANCE.length];
    const pool = poolOf(q).slice(0, 200);
    const chunks = [pool.slice(0, 100), pool.slice(100, 200)];
    const started = performance.now();
    const verdicts = await Promise.all(chunks.map((chunk) => ask(`D-200x2-${rep}`, "noul", q, chunk)));
    const allOk = verdicts.every((v) => v.ok);
    calls.push({
      label: `D-e2e-200`,
      kind: "noul",
      batch: 200,
      status: allOk ? 200 : null,
      outcome: allOk ? "ok" : "partial",
      ms: Math.round(performance.now() - started),
      inputTokens: null,
      outputTokens: null,
      answered: verdicts.reduce((n, v) => n + v.scores.length, 0),
      bytesRequest: 0,
      note: `chunks=${chunks.length}`,
    });
  }

  // --- E. concurrency / admission truth: how many parallel batches before the cloud says 429?
  for (const width of [4, 8]) {
    const pool = poolOf("机器人");
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: width }, (_, i) => ask(`E-parallel${width}`, "noul", ACCEPTANCE[i % ACCEPTANCE.length], pool.slice(i * 10, i * 10 + 100))),
    );
    const wall = Math.round(performance.now() - started);
    const okCount = results.filter((r) => r.ok).length;
    calls.push({ label: `E-wall${width}`, kind: "noul", batch: 100, status: null, outcome: `${okCount}/${width} ok`, ms: wall, inputTokens: null, outputTokens: null, answered: null, bytesRequest: 0, note: `width=${width}` });
  }

  // --- F. fault semantics the client must classify (§20): bad key, malformed body, no body.
  await ask("F-badkey", "noul", "光刻胶", poolOf("光刻胶").slice(0, 2), { key: "sk-not-a-real-key-000000" });
  await ask("F-malformed", "noul", "光刻胶", poolOf("光刻胶").slice(0, 2), { bodyOverride: { model: MODEL, state: 1, questions: "nope" } });
  // Timeout behaviour: a budget far below the measured p50 must surface as timeout, not as a hang.
  await ask("F-timeout300ms", "noul", "光刻胶", poolOf("光刻胶").slice(0, 100), { timeoutMs: 300 });

  report(companies.length);
}

function report(datasetSize: number) {
  const byLabel = new Map<string, Call[]>();
  for (const call of calls) {
    const group = byLabel.get(call.label);
    if (group) group.push(call);
    else byLabel.set(call.label, [call]);
  }
  const okMs = calls.filter((c) => c.outcome === "ok" && !c.label.startsWith("D-e2e") && !c.label.startsWith("E-wall")).map((c) => c.ms).sort((a, b) => a - b);
  const e2e = calls.filter((c) => c.label === "D-e2e-200").map((c) => c.ms).sort((a, b) => a - b);
  const rows: Record<string, unknown> = {};
  for (const [label, group] of byLabel) {
    rows[label] = {
      kind: group[0].kind,
      batch: group[0].batch,
      n: group.length,
      statuses: [...new Set(group.map((g) => g.status))],
      outcomes: [...new Set(group.map((g) => g.outcome))],
      ms: group.map((g) => g.ms),
      inputTokens: group.map((g) => g.inputTokens).filter((n) => n != null),
      answered: group.map((g) => g.answered).filter((n) => n != null),
      notes: [...new Set(group.map((g) => g.note).filter((n): n is string => Boolean(n)))].slice(0, 4),
    };
  }
  const out = {
    probedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    modelAlias: MODEL,
    datasetSize,
    summary: {
      singleBatchMs: { n: okMs.length, p50: pct(okMs, 0.5), p95: pct(okMs, 0.95), max: okMs[okMs.length - 1] ?? null, min: okMs[0] ?? null },
      productionRerank200Ms: { n: e2e.length, p50: pct(e2e, 0.5), p95: pct(e2e, 0.95), max: e2e[e2e.length - 1] ?? null },
      totalCalls: calls.length,
      failedCalls: calls.filter((c) => c.outcome !== "ok").length,
    },
    calls: rows,
  };
  console.log(JSON.stringify(out.summary));
  for (const [label, row] of Object.entries(rows)) {
    const r = row as { ms: number[]; outcomes: string[]; statuses: (number | null)[]; batch: number; inputTokens: number[] };
    console.log(`${label.padEnd(18)} batch=${String(r.batch).padEnd(4)} n=${String(r.ms.length).padEnd(2)} outcomes=${r.outcomes.join(",")} statuses=${r.statuses.join(",")} ms=${r.ms.join(",")} inTok=${r.inputTokens.join(",")}`);
  }
  const outPath = path.join(process.cwd(), "reports", "acceptance", "jev_baseline.json");
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`written ${path.relative(process.cwd(), outPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
