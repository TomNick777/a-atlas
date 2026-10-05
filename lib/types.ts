/** Formal security identity. This is what a plate shows. */
export type Identity = {
  code: string;
  name: string;
};

export type MainProduct = {
  name: string;
  /** Share of revenue, 0 to 1, when the filing reports it. */
  revenueShare?: number;
};

export type Company = Identity & {
  fullName: string;
  exchange: "SH" | "SZ" | "BJ";
  board: string;
  listedAt?: string;
  industry: string;
  /**
   * 申万一级行业（2021 版，31 类）。只来自申万宏源的指数成分表，不猜。
   * 申万指数不含北交所，次新股可能未入类，这些公司是 "unknown"。
   */
  swLevel1Industry: string;
  businessDescription: string;
  mainProducts: MainProduct[];
  concepts: string[];
  region: { province: string; city: string };
  companyDescription: string;
  /** Text the embedding and the word index read. Dense facts first. */
  searchableText: string;
  /** Short profile Jev reads. At most JEV_DETAIL characters. */
  judgeText: string;
  /**
   * Search profile text (judgeText + DERIVED ontology tag line) from
   * data/search_profiles.json. Canonical facts stay untouched; this is the
   * retrieval/rerank view. Null before build_search_profiles runs.
   */
  searchProfileText?: string | null;
  /**
   * Optional English profile for the Chinese-vs-English Jev measurement.
   * Null until a translation pass exists. Switching language is config, not a remodel.
   */
  judgeTextEn: string | null;
  /** Total market value in yuan, when the spot snapshot had it. */
  marketCap: number | null;
  /** Share of revenue booked outside mainland China, when a regional split exists. */
  overseasRevenueShare: number | null;
};

export type Dataset = {
  generatedAt: string;
  companies: Company[];
};

export type ChannelHit = {
  code: string;
  name: string;
  score: number;
};

export type JudgedRow = {
  code: string;
  name: string;
  jev: number;
  /** Rank among finalists before Jev, 0 = best recalled. */
  recallRank: number;
  /** Positive means Jev lifted this company relative to recall order. */
  delta: number;
};

export type SearchTrace = {
  decidedBy: "retrieval" | "jev";
  channels: Record<string, ChannelHit[]>;
  constraints: { province: string | null; dropIndustries: string[] };
  finalists: string[];
  judged: JudgedRow[];
  final: { code: string; name: string; probability: number; jev: number }[];
};

/**
 * Which judgement engine produced the ranking, and why if it did not.
 * `provider: "none"` is the honest degraded state - A-Atlas has no local judge
 * to fall back to (Phase 4 §1), so retrieval alone decided the order.
 */
export type JudgeReport = {
  provider: "jev" | "none";
  /** The model identity the cloud answered with, read from its response. */
  model: string | null;
  outcome:
    | "ok"
    | "not_requested"
    | "no_config"
    | "breaker_open"
    | "connect_timeout"
    | "timeout"
    | "network_error"
    | "unauthorized"
    | "rate_limited"
    | "server_error"
    | "client_error"
    | "bad_response"
    | "budget_exhausted"
    | "admission_timeout"
    | "aborted";
};

export type SearchHit = {
  code: string;
  name: string;
  probability: number;
  industry: string;
  swLevel1Industry: string;
  province: string;
  business: string;
};

/**
 * The per-company judgement behind a result row (Phase 3.4). Present only when
 * a live Jev decision backs the row — degraded median-fill decisions are NOT
 * judgements and never surface. EvidenceRefs point at facts Atlas resolved the
 * judge on; the UI-facing EvidenceView is built from them in lib/atlas/evidence.
 */
export type ResultJudgement = {
  capability: "semantic_match" | "semantic_relation";
  /** The exact phrase that was judged (residual / raw query / relation phrase). */
  query: string;
  /** 0..1 — semantic relevance the judge assigned. Not a probability of truth. */
  score: number;
  /** The capability's own judgement (score ≥ 0.5); Atlas eligibility is separate. */
  matched: boolean;
  /** semantic_relation only: the Atlas-provided relation phrase, verbatim. */
  relationLabel: string | null;
  /** The evidence the decision was grounded in; every ref resolves Atlas-side. */
  evidenceRefs: { companyId: string; ref: string }[];
};

/**
 * Which Jev capability produced the judgement behind a result (Phase 3.3).
 * Additive envelope: the UI does not have to read it; the architecture can
 * always answer "which capability, which contract, which runtime model".
 */
export type SearchIntelligence = {
  provider: "jev" | "none";
  capability: "semantic_match" | "semantic_relation";
  contractVersion: string;
  /** The model identity the cloud answered with — null when degraded. */
  runtimeModel: string | null;
  degraded: boolean;
};

export type SearchResult = {
  /** Correlation id shared with data/search_log and the telemetry stream. */
  searchId?: string;
  query: string;
  hits: SearchHit[];
  /** How many of `hits` should leave the pile. */
  matches: number;
  degraded: boolean;
  judge: JudgeReport;
  tokens: number;
  costUsd: number | null;
  decidedBy: "retrieval" | "jev";
  /** Phase 3.3 — the capability envelope behind this answer. */
  intelligence?: SearchIntelligence;
  /** Phase 3.4 — live judgements by result code. Absent when degraded: the
   * deterministic blend that then ranked the hits is not a judgement. */
  judgements?: Record<string, ResultJudgement>;
  trace?: SearchTrace;
};
