import type Matter from "matter-js";
import type { CardFace, CardTheme } from "./theme";

/** A search hit riding the springs. `hero` is the query-plan metric line the
 * card leads with (Phase 2); `hint` is the Level-1 evidence hint line (Phase
 * 3.4, judgement-backed rows only — deterministic term hits from the judge
 * profile, never Jev prose). probability is the semantic score when semantic
 * ranking took part. */
export type Match = { code: string; name: string; probability: number | null; industry?: string; hero?: string | null; hint?: string | null };
export type Rest = { x: number; y: number; w: number; h: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Anchor = { x: number; above: number };
export type Layout = { rests: Rest[]; box: Box | null; scrollMost: number };

/** A match while it is leaving the pile for a cell above the search bar. */
export type Hold = {
  rest: Rest;
  scale: number;
  startY: number;
  t: number;
  boost: number;
  rank: number;
  arrived: boolean;
  parked: boolean;
  labelled: boolean;
};

export type Scene = {
  engine: Matter.Engine;
  codes: string[];
  names: string[];
  industries: string[];
  /** Per-body hero metric line from the active query plan (empty = none). */
  heroes: string[];
  /** Per-body evidence hint line for judgement-backed matches (empty = none). */
  hints: string[];
  theme: CardTheme;
  face: CardFace;
  bodies: Matter.Body[];
  holds: Map<number, Hold>;
  grown: Map<number, number>;
  sharp: Map<number, HTMLCanvasElement>;
  /**
   * Per-plate sprites for bodies injected after a search (codes outside the
   * physics pool). The baked atlas only knows the pool; these ride along.
   */
  sprites: Map<number, HTMLCanvasElement>;
  width: number;
  height: number;
  plateW: number;
  plateH: number;
  bigW: number;
  bigH: number;
  dpr: number;
  added: number;
  /** Indexes already inserted into the world. A match can enter before the pour reaches it. */
  live: Set<number>;
  dirty: boolean;
  now: number;
  scroll: number;
  box: Box | null;
  atlas: HTMLCanvasElement | null;
  atlasCols: number;
  cellW: number;
  cellH: number;
  gutter: number;
};
