/** Preview by default; --apply removes only expired, unreferenced local snapshots. */
import { pruneMarketSnapshots } from "../lib/market/retention";

if (process.argv.slice(2).some(arg => arg !== "--apply")) throw new Error("Usage: npm run market:prune -- [--apply]");
console.log(JSON.stringify(pruneMarketSnapshots({ apply: process.argv.includes("--apply") }), null, 2));
