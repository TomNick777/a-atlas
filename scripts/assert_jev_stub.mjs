/**
 * CI proof that Discover is judged by the configured Jev provider (§19/§39).
 *
 * A green build that silently searched in degraded mode would prove nothing, so
 * this asserts the positive: the judge answered, it answered as `jev`, and the
 * ranking is not the retrieval-only fallback. Run against the deterministic stub
 * in CI, or against the real cloud locally.
 *
 *   node scripts/assert_jev_stub.mjs [--base http://127.0.0.1:3400] [--query 光刻胶]
 */
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((row) => row.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = arg("base", process.env.ATLAS_BASE ?? "http://127.0.0.1:3400");
const QUERIES = (arg("queries", "光刻胶,谐波减速器,机器人,半导体设备,液冷") ?? "").split(",").filter(Boolean);
const ALLOW_DEGRADED = argv.includes("--allow-degraded");

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

async function health() {
  const response = await fetch(`${BASE}/api/health`);
  const body = await response.json();
  check("health reports a-atlas-web", body.service === "a-atlas-web", JSON.stringify(body));
  check("health names the judge provider", body.judge?.provider === "jev", `judge=${JSON.stringify(body.judge)}`);
  check("judge is configured", body.judge?.configured === true, `configured=${body.judge?.configured}`);
  check("no local judge anywhere in health", !JSON.stringify(body).includes("laya") && !JSON.stringify(body).includes("8787"));
  return body;
}

async function search(query) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-search-origin": "ci" },
    body: JSON.stringify({ query, origin: "ci" }),
  });
  const ms = Date.now() - started;
  const body = await response.json();
  check(`search "${query}" returns 200`, response.status === 200, `status=${response.status} ms=${ms}`);
  if (response.status !== 200) return body;
  check(`search "${query}" decidedBy=jev`, body.decidedBy === "jev", `decidedBy=${body.decidedBy} judge=${JSON.stringify(body.judge)}`);
  check(`search "${query}" judge.provider=jev`, body.judge?.provider === "jev", JSON.stringify(body.judge));
  if (!ALLOW_DEGRADED) check(`search "${query}" not degraded`, body.degraded === false, `degraded=${body.degraded} reason=${body.judge?.outcome}`);
  check(`search "${query}" returned companies`, Array.isArray(body.hits) && body.hits.length > 0, `hits=${body.hits?.length}`);
  check(`search "${query}" payload leaks no key`, !JSON.stringify(body).includes("TYPESAFE") && !JSON.stringify(body).includes("Bearer"));
  console.log(`      top5: ${(body.hits ?? []).slice(0, 5).map((hit) => `${hit.name}(${hit.code})`).join("、")}`);
  return body;
}

try {
  await health();
  for (const query of QUERIES) await search(query);
} catch (error) {
  check("stack reachable", false, error instanceof Error ? error.message : String(error));
}

if (failures.length) {
  console.error(`\nJev provider proof FAILED: ${failures.length} check(s) — ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`\nJev provider proof passed against ${BASE}`);
