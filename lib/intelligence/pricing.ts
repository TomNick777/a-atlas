/** Published input-token prices checked 2026-10-16. Output tokens are free.
 * https://docs.typesafe.ai/models
 * https://console.nace.ai/docs/drex/reference/pricing
 * Unknown versions and local compute costs stay unknown. Never reprice history. */
const INPUT_USD_PER_MILLION: Record<string, number> = {
  "jev:jev-1.13.0": 0.042,
  "jev:jev-1.14.0": 0.042,
  "drex:drex-v1.5": 0.05,
  "drex:drex-v2.0": 0.06,
};

export function inputTokenPrice(provider: string, model: string): number | null {
  const price = INPUT_USD_PER_MILLION[`${provider}:${model}`];
  return price === undefined ? null : price / 1e6;
}

export function estimateInputCost(provider: string, model: string, inputTokens: number): number | null {
  const price = inputTokenPrice(provider, model);
  return price === null || !Number.isFinite(inputTokens) || inputTokens < 0
    ? null : Math.round(inputTokens * price * 1e9) / 1e9;
}
