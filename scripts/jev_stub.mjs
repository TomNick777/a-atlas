/**
 * Deterministic Jev stub (Phase 4 §39/§42).
 *
 * CI must never call the real cloud, and a random mock would make every ranking
 * assertion flaky. This answers the SystemOne wire shape with a hash of the
 * request, so the same query + same candidate always gets the same score in every
 * run and on every machine.
 *
 * It is also the fault-injection surface: one endpoint can be made to behave like
 * a timeout, a 429, a 401, a 5xx or a dead host, which is how §42's
 * "Jev down -> degraded -> Jev restored -> recovered" journey is run for real.
 *
 *   node scripts/jev_stub.mjs --port 8932
 *   node scripts/jev_stub.mjs --port 8932 --mode timeout
 *   curl -X POST 'http://127.0.0.1:8932/v1/systemone?fail=429' -d '{...}'
 *
 * NEVER point production at this. It is guarded by ATLAS_JEV_STUB_ACK for the
 * process-wide mode and it always reports model "jev-stub-1".
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((row) => row.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : fallback;
};

const PORT = Number(arg("port", process.env.JEV_STUB_PORT ?? "8932"));
const DEFAULT_MODE = arg("mode", process.env.JEV_STUB_MODE ?? "ok");
// Toggleable at runtime (POST /mode) so a journey can simulate an outage, not a restart.
let currentMode = DEFAULT_MODE;
const MODEL = "jev-stub-1";

/** Deterministic 0..1 from the request: same question, same answer, always. */
function scoreOf(stateText, key, companyCode) {
  const digest = createHash("sha256").update(`${stateText}|${companyCode}|${key}`).digest();
  return Math.round((digest.readUInt32BE(0) / 0xffffffff) * 1000) / 1000;
}

function respond(json, status = 200) {
  const body = JSON.stringify(json);
  return { status, headers: { "content-type": "application/json", "x-jev-stub": "1" } , body };
}

function handleFail(url, mode0) {
  const mode = url.searchParams.get("fail") ?? mode0;

  switch (mode) {
    case "ok":
      return null;
    case "timeout":
      return { hang: true };
    case "401":
      return respond({ detail: { error_type: "authentication_error", message: "Must supply an API key!" } }, 401);
    case "429":
      return { ...respond({ detail: { error_type: "rate_limit_error" } }, 429), retryAfter: "0" };
    case "500":
    case "503":
      return respond({ detail: { error_type: "server_error", message: "stub failure" } }, Number(mode));
    case "garbage":
      return { status: 200, headers: { "content-type": "text/plain" }, body: "not json" };
    case "empty":
      return respond({ model: MODEL, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
    default:
      return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "a-atlas-jev-stub", model: MODEL, mode: currentMode }));
    return;
  }
  // Runtime fault switch (§42): one stub instance can go healthy -> timeout -> 429
  // -> healthy again, which is what the degradation/recovery journeys need. Without
  // this, "Jev down" could only be simulated by restarting the stub, and a restart
  // is not the same event as an outage.
  if (req.method === "POST" && url.pathname === "/mode") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof body.mode === "string") currentMode = body.mode;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: currentMode }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/mode") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mode: currentMode }));
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/v1/systemone") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "not found" }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const failure = handleFail(url, currentMode);
  if (failure?.hang) return; // never answer: the client's own budget has to fire
  if (failure) {
    res.writeHead(failure.status, { ...failure.headers, ...(failure.retryAfter ? { "retry-after": failure.retryAfter } : {}) });
    res.end(failure.body);
    return;
  }

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: { error_type: "invalid_request", message: "body is not JSON" } }));
    return;
  }

  const state = typeof request.state === "string" ? request.state : String(request.state?.looking_for ?? "");
  const answers = {};
  let inputTokens = 0;
  for (const [key, question] of Object.entries(request.questions ?? {})) {
    const company = question?.instructions?.company;
    const code = typeof company === "string" ? company : (company?.code ?? key);
    const profile = typeof company === "object" ? String(company?.profile ?? "") : "";
    const value = scoreOf(state, key, code);
    inputTokens += Math.max(1, Math.round((profile.length + state.length) / 4));
    // Both heads the contract defines, so a stub answers whichever the caller asks for.
    answers[key] = { noul: value, score: Math.round(value * 3), probabilities: { yes: value, no: 1 - value } };
  }
  const payload = respond({
    model: MODEL,
    answers,
    usage: { input_tokens: inputTokens, output_tokens: Object.keys(answers).length },
    stub: true,
  });
  res.writeHead(payload.status, payload.headers);
  res.end(payload.body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[jev-stub] listening on http://127.0.0.1:${PORT}/v1/systemone (mode=${DEFAULT_MODE}, model=${MODEL})`);
});
