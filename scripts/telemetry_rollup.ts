import { defaultStore } from "../lib/telemetry/store";
import { generateDailyRollup } from "../lib/telemetry/rollup";

/**
 * npm run telemetry:rollup -- [--date YYYY-MM-DD | --days N] (规格 §35)
 * Regenerate daily rollups on demand (startup also auto-catches-up yesterday).
 */

async function main() {
  const dates: string[] = [];
  const inline = process.argv.find((arg) => arg.startsWith("--date="))?.split("=")[1];
  const dateAt = process.argv.indexOf("--date");
  const oneDate = inline ?? (dateAt >= 0 ? process.argv[dateAt + 1] : undefined);
  const daysAt = process.argv.indexOf("--days");
  if (oneDate) {
    dates.push(oneDate);
  } else {
    const days = Number(process.argv[daysAt + 1]) || 1;
    for (let offset = days - 1; offset >= 0; offset--) {
      dates.push(new Date(Date.now() - offset * 24 * 3600_000).toISOString().slice(0, 10));
    }
  }
  for (const date of dates) {
    const rollup = await generateDailyRollup(defaultStore, date);
    console.log(rollup ? `${date}: organic=${rollup.organicSearches} sessions=${rollup.sessions} degraded=${rollup.degradedCount} incidents=${rollup.incidentCount} → data/telemetry/rollups/${date}.json` : `${date}: no events, no rollup`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
