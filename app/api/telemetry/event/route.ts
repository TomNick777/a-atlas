import { isValidSearchId, isValidSessionId } from "@/lib/telemetry/ids";
import { recordClientEvent } from "@/lib/telemetry/search";
import { isClientEventType, isFeedbackRating, isFeedbackReason } from "@/lib/telemetry/types";

/**
 * Browser evidence intake (规格 §24-§27): whitelisted interaction/render
 * events only. The server stamps its own envelope; the browser never supplies
 * ids beyond searchId/sessionId, and unknown searchIds are recorded with
 * serverVerifiedLink=false rather than dropped (audit keeps everything).
 *
 * SEARCH_FEEDBACK (usage spec §8) is held to its closed vocabulary: a rating
 * from the fixed three, an optional reason from the fixed six, nothing else —
 * the payload is rebuilt server-side instead of trusted.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    searchId?: unknown;
    eventType?: unknown;
    payload?: unknown;
    clientTs?: unknown;
    sessionId?: unknown;
  } | null;
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const eventType = isClientEventType(body.eventType) ? body.eventType : null;
  if (!eventType) return Response.json({ error: "unsupported eventType" }, { status: 400 });
  const rawSession = body.sessionId ?? request.headers.get("x-session-id");
  const sessionId = isValidSessionId(rawSession) ? rawSession : null;
  const searchId = isValidSearchId(body.searchId) ? body.searchId : null;
  const raw = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? (body.payload as Record<string, unknown>) : {};
  let payload = raw;
  if (eventType === "SEARCH_FEEDBACK") {
    if (!isFeedbackRating(raw.rating)) return Response.json({ error: "invalid feedback rating" }, { status: 400 });
    payload = {
      rating: raw.rating,
      ...(isFeedbackReason(raw.reason) ? { reason: raw.reason } : {}),
      query: typeof raw.query === "string" ? raw.query.slice(0, 120) : null,
    };
  }
  await recordClientEvent({ searchId, sessionId, eventType, payload, clientTs: typeof body.clientTs === "string" ? body.clientTs : null });
  return new Response(null, { status: 204 });
}
