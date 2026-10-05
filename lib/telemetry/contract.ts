/**
 * Production contract (规格 §47): a 200 from health is NOT "correct".
 * Ready = core runtime healthy + the judge that actually answered is the judge
 * we expect + knowledge tuple expected + manifest not stale + telemetry writable.
 *
 * Phase 4 changed one thing here: the judge is a cloud model, so its identity is
 * the version string in its own response — not a hash of weights on this disk.
 * The discipline is unchanged and still comes from the answering party, never
 * from config: `jev-latest` is an alias, and an alias that silently moves is
 * exactly the drift this file exists to name.
 */

import { jevModel } from "../env";
import { JEV_PRODUCTION_MODEL } from "../jev/capabilities";
import { CORPUS_SCHEMA_VERSION } from "../corpus/contracts";

export const PRODUCTION_CONTRACT = {
  provider: "jev",
  /** The cloud version observed in production when this contract was frozen. */
  judgeModel: JEV_PRODUCTION_MODEL,
  /** Configured request alias. The alias is not identity; `judgeModel` is. */
  judgeModelAlias: jevModel(),
  knowledgeVersion: "residual-knowledge-pass-v1.1",
  materialAttributionVersion: "material-attribution-v1.1",
  ontologyVersion: "2026-09-26-kp1",
  /** Phase 2: discovery reads the corpus artifact (schema + corpus label). */
  corpusSchemaVersion: CORPUS_SCHEMA_VERSION,
  retrievalVersion: "v3-rrf60-corpus",
} as const;

export type JudgeIdentityVerdict = {
  status: "verified" | "drift" | "unavailable";
  expectedModel: string;
  actualModel: string | null;
  reason: string | null;
};

/**
 * Compare the model that actually answered against the frozen contract.
 * `unavailable` is not a mismatch: no key, or the breaker is open, so nothing
 * answered at all. Drift means the cloud served a different model under our
 * alias — reportable, and the reason a pinned JEV_MODEL exists.
 */
export function verifyJudgeIdentity(answeredModel: string | null, configured: boolean): JudgeIdentityVerdict {
  const expected = PRODUCTION_CONTRACT.judgeModel;
  if (!configured) return { status: "unavailable", expectedModel: expected, actualModel: null, reason: "no Jev key configured — Discover runs degraded by design" };
  if (!answeredModel) return { status: "unavailable", expectedModel: expected, actualModel: null, reason: "no successful judge call yet" };
  if (answeredModel === expected) return { status: "verified", expectedModel: expected, actualModel: answeredModel, reason: null };
  return { status: "drift", expectedModel: expected, actualModel: answeredModel, reason: `Jev answered with ${answeredModel}, production contract expects ${expected}` };
}

export type ManifestStamp = {
  builtAt: string | null;
  datasetSha16: string | null;
  knowledgeVersions: string | null;
};

export function manifestStampOf(manifest: Record<string, unknown> | null): ManifestStamp {
  if (!manifest) return { builtAt: null, datasetSha16: null, knowledgeVersions: null };
  return {
    builtAt: (manifest.builtAt as string | undefined) ?? null,
    datasetSha16: (manifest.datasetSha16 as string | undefined) ?? null,
    knowledgeVersions:
      [manifest.semiconductorEnrichmentVersion, manifest.materialAttributionVersion, manifest.ontologyVersion]
        .filter(Boolean)
        .join("/") || null,
  };
}

/** Loaded-in-memory vs on-disk: any drift means the process is holding a stale dataset. */
export function manifestIsStale(loaded: ManifestStamp | null, disk: ManifestStamp): boolean {
  if (!loaded) return false; // nothing loaded yet — nothing to be stale
  if (!disk.builtAt && !disk.datasetSha16) return false; // no manifest on disk at all
  return loaded.builtAt !== disk.builtAt || loaded.datasetSha16 !== disk.datasetSha16;
}
