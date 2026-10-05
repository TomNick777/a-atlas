/**
 * Browser-side evidence (规格 §12, §24-§27): a stable session id plus a
 * keepalive beacon for whitelisted interaction events. Records only behaviors
 * the UI already has — no new UI, no third parties, everything stays local.
 */

const SESSION_KEY = "trawler.telemetry.session";
const IDLE_MS = 30 * 60_000;

type StoredSession = { id: string; at: number };

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `sess_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** One session per tab-open, reset after 30min idle (§4 sessionId). */
export function getSessionId(): string {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredSession) : null;
    if (parsed?.id && typeof parsed.at === "number" && Date.now() - parsed.at < IDLE_MS) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: parsed.id, at: Date.now() }));
      return parsed.id;
    }
    const fresh = randomId();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: fresh, at: Date.now() }));
    return fresh;
  } catch {
    return "sess_ephemeral0000";
  }
}

export type ClientEventType =
  | "RESULT_CLICK"
  | "RESULT_OPEN_DETAIL"
  | "RESULT_CLOSE_DETAIL"
  | "RESULT_COPY"
  | "RESULT_EXTERNAL_LINK"
  | "SEARCH_EDIT_AFTER_RESULTS"
  | "SEARCH_REQUERY"
  | "SEARCH_CLEAR"
  | "SEARCH_STOP"
  | "SEARCH_RENDERED"
  | "SEARCH_RESULTS_VISIBLE"
  /** §8 lightweight feedback: 好/一般/差 + optional machine reason, tied to the searchId. */
  | "SEARCH_FEEDBACK";

/** Fire-and-forget beacon; telemetry must never break the UI (§1). */
export function trackClientEvent(eventType: ClientEventType, payload: Record<string, unknown> = {}, searchId?: string | null): void {
  const body = JSON.stringify({ eventType, payload, searchId: searchId ?? null, sessionId: getSessionId(), clientTs: new Date().toISOString() });
  try {
    fetch("/api/telemetry/event", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch {
    /* telemetry never breaks the UI */
  }
}
