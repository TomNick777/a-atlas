import Matter from "matter-js";
import { park, wakeNear } from "./forces";
import { gridLayout } from "./layout";
import { logoFor } from "./logoCache";
import { renderPlate } from "./plates";
import { plateShowsIndustry } from "./theme";
import type { Anchor, Hold, Layout, Match, Scene } from "./scene";

const WAVE = 3;
const WAVE_GAP = 70;

type Shown = {
  matches: Match[];
  layout: Layout;
  getAnchor: () => Anchor;
  launched: Set<number>;
};

/**
 * Matches leave the pile a few at a time, best first, and spring up to a grid above the bar.
 * They shove the pile aside on the way and never collide with each other.
 */
export function createMatches(scene: Scene) {
  const { bodies, holds, grown } = scene;
  let shown: Shown | null = null;
  const queue: number[] = [];
  let waveAt = 0;
  let lastMiss = "";
  let injected = 0;

  const ensureLive = (index: number) => {
    if (scene.live.has(index)) return;
    const body = bodies[index];
    Matter.Body.setPosition(body, {
      x: scene.width * (0.2 + Math.random() * 0.6),
      y: scene.height - scene.plateH * 2,
    });
    Matter.Body.setVelocity(body, { x: 0, y: 0 });
    Matter.Composite.add(scene.engine.world, body);
    scene.live.add(index);
  };

  /**
   * A hit outside the physics pool still gets a body: appended past the pool
   * with its own sprite (the atlas only holds pool plates), it rides the same
   * springs up and falls back into the pile when released.
   */
  const indexOfOrInject = (code: string, name: string, industry: string | undefined, hero?: string | null, hint?: string | null): number => {
    const known = scene.codes.indexOf(code);
    if (known >= 0) {
      if (hero) scene.heroes[known] = hero;
      if (hint) scene.hints[known] = hint;
      return known;
    }
    injected += 1;
    const index = scene.codes.length;
    scene.codes.push(code);
    scene.names.push(name);
    scene.industries.push(industry ?? "");
    scene.heroes.push(hero ?? "");
    scene.hints.push(hint ?? "");
    const body = Matter.Bodies.rectangle(
      scene.width * (0.1 + 0.8 * Math.random()),
      -scene.plateH * 2,
      scene.plateW,
      scene.plateH,
      {
        restitution: 0.45,
        friction: 0.45,
        frictionStatic: 0.8,
        frictionAir: 0.014,
        angle: (Math.random() - 0.5) * 0.6,
        sleepThreshold: 30,
      },
    );
    bodies.push(body);
    scene.sprites.set(
      index,
      renderPlate(name, code, scene.plateW, scene.plateH, scene.dpr, {
        theme: scene.theme,
        industry,
        face: scene.face,
        logo: scene.face === "text" ? null : logoFor(code),
        hero,
        hint,
      }),
    );
    Matter.Composite.add(scene.engine.world, body);
    scene.live.add(index);
    return index;
  };

  const whollyInView = (rank: number) => {
    const box = shown?.layout.box;
    const rest = shown?.layout.rests[rank];
    if (!box || !rest) return false;
    const y = rest.y - scene.scroll;
    return y - rest.h / 2 - 22 >= box.y && y + rest.h / 2 <= box.y + box.height;
  };

  const begin = (index: number, rank: number, fly: boolean) => {
    if (!shown) return;
    const rest = shown.layout.rests[rank];
    const hold: Hold = {
      rest,
      scale: rest.h / scene.plateH,
      startY: bodies[index].position.y,
      t: 0,
      boost: 1,
      rank,
      arrived: false,
      parked: false,
      labelled: false,
    };
    holds.set(index, hold);
    if (!grown.has(index)) grown.set(index, 1);
    bodies[index].collisionFilter.group = -1;
    scene.heroes[index] = shown.matches[rank].hero ?? "";
    scene.hints[index] = shown.matches[rank].hint ?? "";
    scene.sharp.set(
      index,
      renderPlate(scene.names[index], scene.codes[index], rest.w, rest.h, scene.dpr, {
        theme: scene.theme,
        industry: scene.industries[index],
        face: "brand",
        logo: logoFor(scene.codes[index]),
        showIndustry: plateShowsIndustry(scene.theme),
        hero: scene.heroes[index] || null,
        hint: scene.hints[index] || null,
      }),
    );
    wakeNear(scene, bodies[index]);
    if (!fly) {
      const current = grown.get(index) ?? 1;
      Matter.Body.scale(bodies[index], hold.scale / current, hold.scale / current);
      grown.set(index, hold.scale);
      park(scene, index);
    }
    scene.dirty = true;
  };

    const launch = (rank: number, fly: boolean) => {
      if (!shown) return false;
      const match = shown.matches[rank];
      if (!match) return false;
      const known = scene.codes.indexOf(match.code);
      const index = known >= 0 ? known : indexOfOrInject(match.code, match.name, match.industry, match.hero, match.hint);
    if (holds.has(index)) {
      lastMiss = `held ${match.code}`;
      return false;
    }
    ensureLive(index);
    shown.launched.add(rank);
    begin(index, rank, fly);
    return true;
  };

  const fill = (fly: boolean) => {
    if (!shown) return;
    queue.length = 0;
    shown.matches.forEach((_, rank) => {
      if (!shown!.launched.has(rank)) queue.push(rank);
    });
    if (fly) queue.sort((a, b) => a - b);
  };

  const drain = (now: number) => {
    if (!shown || !queue.length || now - waveAt < WAVE_GAP) return;
    waveAt = now;
    for (let n = 0; n < WAVE && queue.length; ) {
      const rank = queue.shift()!;
      if (shown.launched.has(rank)) continue;
      if (!launch(rank, whollyInView(rank))) continue;
      n++;
    }
  };

  const release = () => {
    shown = null;
    queue.length = 0;
    scene.box = null;
    if (!holds.size) return;
    holds.forEach((_, index) => {
      Matter.Sleeping.set(bodies[index], false);
      bodies[index].collisionFilter.mask = 0xffffffff;
      bodies[index].collisionFilter.group = 0;
      scene.sharp.delete(index);
    });
    holds.clear();
    scene.dirty = true;
  };

  return {
    release,
    tick(now: number) {
      drain(now);
    },
    holes() {
      if (!shown) return 0;
      let waiting = 0;
      shown.matches.forEach((_, rank) => {
        if (!shown!.launched.has(rank)) waiting++;
      });
      return waiting;
    },
    drift() {
      let worst = 0;
      holds.forEach((hold, index) => {
        if (!hold.labelled && !hold.parked) return;
        const body = bodies[index];
        worst = Math.max(worst, Math.hypot(hold.rest.x - body.position.x, hold.rest.y - scene.scroll - body.position.y));
      });
      return Math.round(worst * 10) / 10;
    },
    select(matches: Match[], getAnchor: () => Anchor) {
      release();
      const few = matches.slice(0, 120);
      const layout = gridLayout(few.length, getAnchor(), scene, { w: scene.bigW, h: scene.bigH });
      shown = { matches: few, layout, getAnchor, launched: new Set() };
      scene.box = layout.box;
      scene.scroll = 0;
      waveAt = 0;
      fill(true);
    },
    scrollBy(dy: number, x: number, y: number) {
      const box = shown?.layout.box;
      if (!shown || !box || !shown.layout.scrollMost) return false;
      if (x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height) return false;
      const to = Math.max(0, Math.min(shown.layout.scrollMost, scene.scroll + dy));
      if (to === scene.scroll) return true;
      const by = to - scene.scroll;
      scene.scroll = to;
      holds.forEach((hold, index) => {
        if (hold.parked) Matter.Body.setPosition(bodies[index], { x: hold.rest.x, y: hold.rest.y - scene.scroll });
        else if (hold.arrived) Matter.Body.setPosition(bodies[index], { x: bodies[index].position.x, y: bodies[index].position.y - by });
      });
      scene.dirty = true;
      return true;
    },
    relayout() {
      if (!shown) return;
      const layout = (shown.layout = gridLayout(shown.matches.length, shown.getAnchor(), scene, { w: scene.bigW, h: scene.bigH }));
      scene.box = layout.box;
      scene.scroll = Math.min(scene.scroll, layout.scrollMost);
      holds.forEach((hold, index) => {
        hold.rest = layout.rests[hold.rank];
        hold.scale = hold.rest.h / scene.plateH;
        hold.parked = false;
        hold.t = Math.min(hold.t, 4);
        Matter.Sleeping.set(bodies[index], false);
        scene.sharp.set(
          index,
          renderPlate(scene.names[index], scene.codes[index], hold.rest.w, hold.rest.h, scene.dpr, {
            theme: scene.theme,
            industry: scene.industries[index],
            face: "brand",
            logo: logoFor(scene.codes[index]),
            showIndustry: plateShowsIndustry(scene.theme),
            hero: scene.heroes[index] || null,
            hint: scene.hints[index] || null,
          }),
        );
      });
    },
    lastMiss: () => lastMiss,
    layout: () => shown?.layout ?? null,
    shown: () => shown?.matches ?? [],
    injected: () => injected,
  };
}
