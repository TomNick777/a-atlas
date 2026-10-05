import { appendFile, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { TelemetryEnvelope } from "./types";

/**
 * Telemetry store — append-only JSONL event stream + atomic JSON artifacts.
 *
 * Failure contract (规格 §1): telemetry must never break a search or the app.
 * Every append swallows its own errors into a failure counter + stderr; the
 * LOG_WRITE_FAILURE incident is attempted best-effort and degrades to stderr
 * alone when the disk itself is the problem (规格 §44 lesson: never open-’w’
 * an index in place — rewrites go tmp → fsync → atomic rename).
 */

export type WriteFailure = { count: number; lastError: string | null; lastAt: string | null };

export class TelemetryStore {
  readonly eventsDir: string;
  readonly incidentsFile: string;
  readonly rollupsDir: string;
  readonly exportsDir: string;
  readonly runtimeDir: string;
  readonly failures: WriteFailure = { count: 0, lastError: null, lastAt: null };

  private dirsReady = false;
  private chains = new Map<string, Promise<void>>();
  /** Monotonic guard so LOG_WRITE_FAILURE incidents self-rate-limit. */
  private lastWriteFailureIncidentAt = 0;

  constructor(public readonly baseDir: string) {
    this.eventsDir = path.join(baseDir, "events");
    this.incidentsFile = path.join(baseDir, "incidents", "incidents.jsonl");
    this.rollupsDir = path.join(baseDir, "rollups");
    this.exportsDir = path.join(baseDir, "exports");
    this.runtimeDir = path.join(baseDir, "runtime");
  }

  private async ensureDirs(): Promise<void> {
    if (this.dirsReady) return;
    await Promise.all([
      mkdir(this.eventsDir, { recursive: true }),
      mkdir(path.dirname(this.incidentsFile), { recursive: true }),
      mkdir(this.rollupsDir, { recursive: true }),
      mkdir(this.exportsDir, { recursive: true }),
      mkdir(this.runtimeDir, { recursive: true }),
    ]);
    this.dirsReady = true;
  }

  eventFileFor(timestamp: string): string {
    return path.join(this.eventsDir, `${timestamp.slice(0, 10)}.jsonl`);
  }

  /** Append one complete event line. Serialized per file, never rejects. */
  async append(event: TelemetryEnvelope): Promise<boolean> {
    const file = this.eventFileFor(event.timestamp);
    try {
      await this.ensureDirs();
      const chain = this.chains.get(file) ?? Promise.resolve();
      const next = chain.then(() => appendFile(file, JSON.stringify(event) + "\n", "utf8"));
      // Keep only the tail of the chain; a rejected link is already recorded.
      this.chains.set(
        file,
        next.catch(() => undefined),
      );
      await next;
      return true;
    } catch (error) {
      this.recordFailure(error, event.eventType);
      return false;
    }
  }

  /** Sync append for process-exit handlers (async callbacks never flush there). */
  appendSync(event: TelemetryEnvelope): boolean {
    try {
      mkdirSync(this.eventsDir, { recursive: true });
      appendFileSync(this.eventFileFor(event.timestamp), JSON.stringify(event) + "\n", "utf8");
      return true;
    } catch (error) {
      this.recordFailure(error, event.eventType);
      return false;
    }
  }

  async appendIncident(event: TelemetryEnvelope): Promise<boolean> {
    const ok = await this.append(event);
    try {
      await this.ensureDirs();
      const chain = this.chains.get(this.incidentsFile) ?? Promise.resolve();
      const next = chain.then(() => appendFile(this.incidentsFile, JSON.stringify(event) + "\n", "utf8"));
      this.chains.set(
        this.incidentsFile,
        next.catch(() => undefined),
      );
      await next;
      return ok;
    } catch (error) {
      this.recordFailure(error, event.eventType);
      return false;
    }
  }

  /** tmp → fsync → atomic rename (规格 §44). */
  async writeJsonAtomic(relPath: string, data: unknown): Promise<void> {
    await this.ensureDirs();
    const target = path.join(this.baseDir, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  }

  async probeWritable(): Promise<boolean> {
    const probe = path.join(this.baseDir, `write-probe-${process.pid}`);
    try {
      await writeFile(probe, "ok", "utf8");
      await unlink(probe);
      return true;
    } catch {
      try {
        await unlink(probe);
      } catch {
        /* nothing to clean */
      }
      return false;
    }
  }

  /** Await all pending appends (test/CLI flush helper; production never needs it). */
  async flush(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      const pending = [...this.chains.values()];
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  private recordFailure(error: unknown, eventType: string): void {
    this.failures.count += 1;
    this.failures.lastError = error instanceof Error ? error.message : String(error);
    this.failures.lastAt = new Date().toISOString();
    console.error(`[telemetry] write failed for ${eventType} (app unaffected):`, this.failures.lastError);
    if (Date.now() - this.lastWriteFailureIncidentAt > 10 * 60_000) {
      this.lastWriteFailureIncidentAt = Date.now();
      // Stderr only: if event writes fail, the incident stream likely fails too.
      console.error(
        `[telemetry] LOG_WRITE_FAILURE incident (rate-limited 10min): count=${this.failures.count} baseDir=${this.baseDir}`,
      );
    }
  }

  /** Tolerant reader: torn/corrupt lines are counted, not fatal (规格 §41 corrupt captures). */
  async readEvents(options: { since?: string; until?: string; searchId?: string; eventTypes?: string[] } = {}): Promise<{ events: TelemetryEnvelope[]; corruptLines: number }> {
    const files = await this.listEventFiles(options.since, options.until);
    const events: TelemetryEnvelope[] = [];
    let corruptLines = 0;
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as TelemetryEnvelope;
          if (!event || typeof event.eventType !== "string") throw new Error("not an event");
          if (options.searchId && event.searchId !== options.searchId) continue;
          if (options.eventTypes && !options.eventTypes.includes(event.eventType)) continue;
          events.push(event);
        } catch {
          if (!options.searchId && !options.eventTypes) corruptLines += 1;
          else if (options.searchId && line.includes("searchId")) corruptLines += 1;
        }
      }
    }
    events.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.eventId < b.eventId ? -1 : 1));
    return { events, corruptLines };
  }

  async readIncidents(): Promise<TelemetryEnvelope[]> {
    try {
      const text = await readFile(this.incidentsFile, "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as TelemetryEnvelope];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private async listEventFiles(since?: string, until?: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.eventsDir);
    } catch {
      return [];
    }
    const from = since ? since.slice(0, 10) : "0000-00-00";
    const to = until ? until.slice(0, 10) : "9999-99-99";
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .map((name) => name.slice(0, 10))
      .filter((date) => date >= from && date <= to)
      .sort()
      .map((date) => path.join(this.eventsDir, `${date}.jsonl`));
  }
}

/** Default store: data/telemetry under the process cwd (repo root). */
export const defaultStore = new TelemetryStore(path.join(process.cwd(), "data", "telemetry"));

export function telemetryBaseDir(): string {
  return path.join(process.cwd(), "data", "telemetry");
}

export function telemetryDirsExist(baseDir: string): boolean {
  return existsSync(path.join(baseDir, "events"));
}
