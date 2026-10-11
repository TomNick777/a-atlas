/** Explicit selected-judge runtime: cloud settings here, local transport behind capabilities. */

/** The cloud key. Server-side only — it must never reach a client bundle. */
export function typesafeKey(): string | null {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? key : null;
}

export function jevModel(): string {
  return process.env.JEV_MODEL?.trim() || "jev-latest";
}

/** Characters of each company profile sent to Jev per finalist. */
export function jevDetail(): number {
  const n = Number(process.env.JEV_DETAIL ?? 420);
  return Number.isFinite(n) && n > 40 ? Math.min(1200, Math.round(n)) : 420;
}

/**
 * SystemOne endpoint. Overridable only so CI can point at the deterministic Jev
 * stub (§39); the production default is the cloud. Nothing else may redirect it.
 */
export function jevBaseUrl(): string {
  const override = process.env.JEV_BASE_URL?.trim();
  if (override) return `${override.replace(/\/+$/, "")}/v1/systemone`;
  return "https://api.typesafe.ai/v1/systemone";
}

/** True when the override is in use — surfaced as `provider=jev-stub`, never as a key. */
export function jevIsStubEndpoint(): boolean {
  return Boolean(process.env.JEV_BASE_URL?.trim());
}
