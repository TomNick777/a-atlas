/**
 * Wire accounting (benchmark §30, live-suite §13 discipline): every real fetch
 * to the Jev endpoint is counted and must sit inside a case window. Attempts
 * outside any window are "unexpected" and fail the run — a quality baseline
 * must never contain unaccounted judge calls.
 */
const JEV_URL = /systemone|typesafe\.ai/i;

export type WireAccounting = {
  wrap(): void;
  restore(): void;
  enter(caseId: string): void;
  exit(): void;
  attempts(): number;
  orphans(): string[];
};

export function createAccounting(): WireAccounting {
  let attempts = 0;
  let window: string | null = null;
  const orphans: string[] = [];
  const realFetch = globalThis.fetch;
  return {
    wrap() {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (JEV_URL.test(url)) {
          attempts += 1;
          if (!window) orphans.push(`${new Date().toISOString()} ${url}`);
        }
        return realFetch.call(globalThis, input, init);
      }) as typeof fetch;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
    enter(caseId: string) {
      window = caseId;
    },
    exit() {
      window = null;
    },
    attempts() {
      return attempts;
    },
    orphans() {
      return orphans;
    },
  };
}
