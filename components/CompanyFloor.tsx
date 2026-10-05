"use client";

import Matter from "matter-js";
import { memo, useEffect, useRef } from "react";
import { createBounds } from "./floor/bounds";
import { jolt, overlaps } from "./floor/debug";
import { applyGrowth, applyHoldForces, STEP, SUBSTEPS } from "./floor/forces";
import { logoFor, subscribeLogos, takeLoadedLogos } from "./floor/logoCache";
import { createMatches } from "./floor/matches";
import { bakeAtlas, drawPlate, plateShowsIndustry, renderPlate } from "./floor/plates";
import type { Anchor, Match, Scene } from "./floor/scene";
import type { CardFace, CardTheme } from "./floor/theme";

export type { Match };

export type FloorApi = {
  shake: (intensity: number) => void;
  select: (matches: Match[], getAnchor: () => Anchor) => void;
  release: () => void;
};

export type Plate = { code: string; name: string; industry: string };
/** A plate the user clicked; probability rides along when it is a shown match. */
export type PlateOpen = { code: string; name: string; probability: number | null };
/** A plate the user hovers; viewport coords ride along for the peek anchor. */
export type PlateHover = PlateOpen & { at: { x: number; y: number } };

type Props = {
  plates: Plate[];
  theme: CardTheme;
  face: CardFace;
  apiRef: React.RefObject<FloorApi | null>;
  onPlateOpen?: (plate: PlateOpen) => void;
  onPlateHover?: (plate: PlateHover | null) => void;
};

/** 文字卡 1.62:1 承自参考项目；两面 LOGO 卡为正方形。 */
const TEXT_ASPECT = 1.62;
const aspectFor = (face: CardFace) => (face === "text" ? TEXT_ASPECT : 1);
/**
 * 稳定后牌面总面积允许占的窗口份额：0.38 承自参考项目的经验值，0.75 是装填松弛。
 * 参考项目按方形图标的面积推这份预算；乘在分母上的 ASPECT 把它换算回真实的牌面积。
 */
const PILE_AREA = 0.38 * 0.75;
const PILE_MIN = 10;
// 牌高的上限。预算公式只在牌多时起作用；宽窗口配上少量牌时公式够不着，由这个帽子接手。
// 实测（scripts/measure_pile.mjs）：300 张、1920×1080、帽 26 时静态浇注的堆顶在净空线下方约 350px，
// 用户截图里盖住搜索框的堆是多轮搜索落回的牌反复再浇注累出来的，由下方 governor 兜底，帽子无需再降。
const PILE_CAP = 26;
// 搜索框顶约在中线上方 30px（框高一半），其下再留 60px 净空：整堆睡稳后的顶点不得高于这条线。
const apexLineY = (height: number) => height * 0.5 - 90;

/**
 * Every company is a rigid body. They drop, pile, and can be thrown.
 * A search springs the matches up to a grid; it does not animate them with CSS.
 */
export const CompanyFloor = memo(function CompanyFloor({ plates, theme, face, apiRef, onPlateOpen, onPlateHover }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const relayoutRef = useRef<() => void>(() => {});
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const faceRef = useRef(face);
  faceRef.current = face;
  // 挂在 ref 上，画布 effect 只建一次，不因回调身份变化重建场景。
  const onPlateOpenRef = useRef(onPlateOpen);
  onPlateOpenRef.current = onPlateOpen;
  const onPlateHoverRef = useRef(onPlateHover);
  onPlateHoverRef.current = onPlateHover;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const engine = Matter.Engine.create({ gravity: { x: 0, y: 1, scale: 0.001 } });
    engine.enableSleeping = true;
    engine.positionIterations = 4;
    engine.velocityIterations = 3;
    const sleeping = Matter.Sleeping as unknown as { _motionSleepThreshold: number; _motionWakeThreshold: number };
    sleeping._motionSleepThreshold = 0.35;
    sleeping._motionWakeThreshold = 0.8;

    const scene: Scene = {
      engine,
      codes: plates.map((plate) => plate.code),
      names: plates.map((plate) => plate.name),
      industries: plates.map((plate) => plate.industry),
      heroes: plates.map(() => ""),
      hints: plates.map(() => ""),
      theme: themeRef.current,
      face: faceRef.current,
      bodies: [],
      holds: new Map(),
      grown: new Map(),
      sharp: new Map(),
      sprites: new Map(),
      width: 0,
      height: 0,
      plateW: 40,
      plateH: 26,
      bigW: 148,
      bigH: 92,
      dpr: 1,
      added: 0,
      live: new Set(),
      dirty: true,
      now: performance.now(),
      scroll: 0,
      box: null,
      atlas: null,
      atlasCols: 1,
      cellW: 1,
      cellH: 1,
      gutter: 2,
    };
    sceneRef.current = scene;

    const mouse = Matter.Mouse.create(canvas);
    const bounds = createBounds(scene, canvas, mouse);
    const matches = createMatches(scene);
    relayoutRef.current = () => matches.relayout();

    /**
     * 点牌开公司页：命中检测用 Matter.Query.point（物理体尺寸随放大同步缩放，
     * 举起的大牌命中区也是对的）。同为命中时举到格子里的牌优先，其余取绘制
     * 序最上层（index 更大）。只认「按下即抬起」的点击：位移超 6px 或超 600ms
     * 都算拖拽/抛掷，不触发跳转。
     */
    const plateAt = (x: number, y: number): PlateOpen | null => {
      const hits = Matter.Query.point(scene.bodies.slice(0, scene.added), { x, y });
      if (!hits.length) return null;
      const indexOf = new Map(hits.map((body) => [scene.bodies.indexOf(body), body] as const));
      let best = -1;
      let bestScore = -Infinity;
      for (const index of indexOf.keys()) {
        const hold = scene.holds.get(index);
        const score = (hold ? 1e6 : 0) + index;
        if (score > bestScore) {
          bestScore = score;
          best = index;
        }
      }
      if (best < 0) return null;
      const hold = scene.holds.get(best);
      const probability = hold ? (matches.shown()[hold.rank]?.probability ?? null) : null;
      return { code: scene.codes[best], name: scene.names[best], probability };
    };

    let press: { x: number; y: number; t: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      // 点击/拖拽判定只认主键，不参与按下。
      if (event.button !== 0) return;
      press = { x: event.offsetX, y: event.offsetY, t: performance.now() };
      hideHover();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const start = press;
      press = null;
      if (!start || !onPlateOpenRef.current) return;
      const dx = event.offsetX - start.x;
      const dy = event.offsetY - start.y;
      if (dx * dx + dy * dy > 36 || performance.now() - start.t > 600) return;
      const hit = plateAt(event.offsetX, event.offsetY);
      if (hit) onPlateOpenRef.current(hit);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);

    /**
     * Level-2 evidence peek (Phase 3.4): hover over a HELD match (the gridded
     * results) raises a peek event; pile plates never peek. Hit-testing is
     * rAF-throttled, suppressed while pressing/dragging, and reports viewport
     * coords so the DOM tooltip can anchor near the cursor without touching
     * the physics loop.
     */
    let hoverPending: { x: number; y: number } | null = null;
    let hoverRaf = 0;
    let hoveredCode: string | null = null;
    const heldPlateAt = (x: number, y: number): PlateHover | null => {
      if (!scene.holds.size) return null;
      const hits = Matter.Query.point(scene.bodies.slice(0, scene.added), { x, y });
      const indexOf = new Map(hits.map((body) => [scene.bodies.indexOf(body), body] as const));
      let best = -1;
      for (const index of indexOf.keys()) if (scene.holds.has(index) && index > best) best = index;
      if (best < 0) return null;
      const hold = scene.holds.get(best)!;
      return {
        code: scene.codes[best],
        name: scene.names[best],
        probability: matches.shown()[hold.rank]?.probability ?? null,
        at: { x, y },
      };
    };
    const hideHover = () => {
      if (!hoveredCode) return;
      hoveredCode = null;
      onPlateHoverRef.current?.(null);
    };
    const flushHover = () => {
      hoverRaf = 0;
      if (!hoverPending) return;
      const at = hoverPending;
      hoverPending = null;
      if (press) return hideHover();
      const hit = heldPlateAt(at.x, at.y);
      if (hit?.code === hoveredCode) return;
      hoveredCode = hit?.code ?? null;
      onPlateHoverRef.current?.(hit);
    };
    const onPointerMove = (event: PointerEvent) => {
      hoverPending = { x: event.offsetX, y: event.offsetY };
      if (!hoverRaf) hoverRaf = requestAnimationFrame(flushHover);
    };
    const onPointerLeave = () => {
      hoverPending = null;
      hideHover();
    };
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    /** 统一改牌面尺寸：重缩全部刚体（含还没落进世界的和举在格子里的）并重烤图集。 */
    const applySide = (want: number, dpr: number) => {
      const side = Math.max(PILE_MIN, want);
      const prevH = scene.plateH;
      scene.plateH = side;
      scene.plateW = side * aspectFor(faceRef.current);
      if (scene.bodies.length && Math.abs(side - prevH) > 0.5) {
        const factor = side / prevH;
        for (const body of scene.bodies) Matter.Body.scale(body, factor, factor);
      }
      const baked = bakeAtlas(scene.codes, scene.names, scene.industries, scene.theme, scene.plateW, scene.plateH, dpr, faceRef.current);
      scene.atlas = baked.canvas;
      scene.atlasCols = baked.cols;
      scene.cellW = baked.cellW;
      scene.cellH = baked.cellH;
      scene.gutter = baked.gutter;
      scene.dirty = true;
    };

    const resize = () => {
      const dpr = (scene.dpr = Math.min(window.devicePixelRatio || 1, 2));
      const width = (scene.width = canvas.clientWidth);
      const height = (scene.height = canvas.clientHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.bigH = Math.max(72, Math.min(96, width / 16));
      // 举牌(搜索结果)恒为正方形 brand 卡，与牌堆纵横比解耦。
      scene.bigW = scene.bigH;
      const fits = Math.sqrt((PILE_AREA * height * width) / Math.max(1, plates.length * aspectFor(faceRef.current)));
      applySide(Math.min(PILE_CAP, width / 52, fits), dpr);
      bounds.build();
    };
    resize();

    const spawn = (index: number) =>
      Matter.Bodies.rectangle(
        scene.width * (0.1 + 0.8 * ((index * 0.618) % 1)),
        -scene.plateH * (1.4 + (index % 12) * 1.3),
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
    plates.forEach((_, index) => scene.bodies.push(spawn(index)));

    /** 睡稳牌的最高上沿；还在飞的牌不算数，null 表示一副牌都没睡稳。 */
    const settledApex = () => {
      let top: number | null = null;
      for (let i = 0; i < scene.added; i++) {
        const body = scene.bodies[i];
        if (scene.holds.has(i) || !body.isSleeping) continue;
        const y = body.position.y - scene.plateH * (scene.grown.get(i) ?? 1) * 0.5;
        if (top === null || y < top) top = y;
      }
      return top;
    };

    const fullySettled = () => {
      if (scene.added !== scene.bodies.length) return false;
      for (let i = 0; i < scene.added; i++) if (!scene.bodies[i].isSleeping) return false;
      return true;
    };

    const drag = Matter.MouseConstraint.create(engine, { mouse, constraint: { stiffness: 0.14, render: { visible: false } } });
    Matter.Composite.add(engine.world, drag);
    const wheel = (mouse as unknown as { mousewheel?: EventListener }).mousewheel;
    if (wheel) canvas.removeEventListener("wheel", wheel);

    const pace: number[] = [];
    const paced = () => {
      if (pace.length < 8) return { fps: 0, p50: 0, p95: 0, late: 0 };
      const sorted = [...pace].sort((a, b) => a - b);
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const mid = at(0.5);
      return { fps: Math.round(1000 / mid), p50: +mid.toFixed(1), p95: +at(0.95).toFixed(1), late: pace.filter((gap) => gap > mid * 1.6).length };
    };
    const stats = { stepMs: 0, drawMs: 0, awake: 0, paced };
    (window as unknown as { __floor?: unknown }).__floor = Object.assign(stats, {
      overlaps: () => overlaps(scene),
      settled: fullySettled,
      apex: () => {
        const top = settledApex();
        return top === null ? null : { y: Math.round(top), h: Math.round(scene.plateH * 10) / 10 };
      },
      setSize: (side: number) => {
        applySide(side, scene.dpr);
        for (const body of scene.bodies) Matter.Sleeping.set(body, false);
      },
      jolt: () => jolt(scene),
      holes: () => matches.holes(),
      lastMiss: () => matches.lastMiss(),
      drift: () => matches.drift(),
      injected: () => matches.injected(),
      sampleCodes: () => scene.codes.slice(0, 50),
      /** 单卡渲染导出：真实 renderPlate 任意尺寸，logo 未到达时等它（8s 兜底回退文字面）。 */
      card: (code: string, face: CardFace, side: number) =>
        new Promise<string | null>((resolve) => {
          const index = scene.codes.indexOf(code);
          const name = scene.names[index >= 0 ? index : 0] ?? code;
          const industry = scene.industries[index >= 0 ? index : 0];
          const finish = (logo: HTMLImageElement | null) => {
            const canvas = renderPlate(name, code, side * aspectFor(face), side, 2, { theme: scene.theme, industry, face, logo });
            resolve(canvas.toDataURL("image/png"));
          };
          if (face === "text") return finish(null);
          const loaded = logoFor(code);
          if (loaded) return finish(loaded);
          const off = subscribeLogos(() => {
            const image = logoFor(code);
            if (image) {
              off();
              finish(image);
            }
          });
          logoFor(code);
          setTimeout(() => {
            off();
            finish(logoFor(code));
          }, 8000);
        }),
      where: () => {
        const rows: { name: string; x: number; y: number; restY: number; parked: boolean; industry: string | null; usesSprite: boolean; hasSharp: boolean }[] = [];
        scene.holds.forEach((hold, index) => {
          const body = scene.bodies[index];
          rows.push({
            name: scene.names[index],
            x: Math.round(body.position.x),
            y: Math.round(body.position.y),
            restY: Math.round(hold.rest.y - scene.scroll),
            parked: hold.parked,
            industry: scene.industries[index] ?? null,
            usesSprite: scene.sprites.has(index),
            hasSharp: scene.sharp.has(index),
          });
        });
        return { holds: rows.length, box: scene.box, sample: rows.slice(0, 5) };
      },
    });

    const paint = (index: number, scale: number) => {
      const sprite = (scale > 1.02 ? scene.sharp.get(index) : null) ?? scene.sprites.get(index);
      const body = scene.bodies[index];
      const w = scene.plateW * scale;
      const h = scene.plateH * scale;
      if (w < 1 || !scene.atlas) return;
      const { dpr } = scene;
      const cos = Math.cos(body.angle);
      const sin = Math.sin(body.angle);
      ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * body.position.x, dpr * body.position.y);
      if (sprite) ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
      else {
        const col = index % scene.atlasCols;
        const row = Math.floor(index / scene.atlasCols);
        const stepX = scene.cellW + scene.gutter;
        const stepY = scene.cellH + scene.gutter;
        ctx.drawImage(scene.atlas, col * stepX, row * stepY, scene.cellW, scene.cellH, -w / 2, -h / 2, w, h);
      }
    };

    const draw = () => {
      const { dpr, box } = scene;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, scene.width, scene.height);
      for (let i = 0; i < scene.added; i++) if (!scene.grown.has(i)) paint(i, 1);
      const settled: number[] = [];
      scene.grown.forEach((scale, index) => {
        const hold = scene.holds.get(index);
        const { x, y } = scene.bodies[index].position;
        const home = !!hold && Math.abs(y - (hold.rest.y - scene.scroll)) < scene.plateH * scale && Math.abs(x - hold.rest.x) < scene.plateW * scale;
        if (box && hold && (hold.parked || (hold.arrived && home))) settled.push(index);
        else paint(index, scale);
      });
      if (box && settled.length) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.beginPath();
        ctx.roundRect(box.x + 1, box.y + 1, box.width - 2, box.height - 2, 5);
        ctx.clip();
        for (const index of settled) paint(index, scene.grown.get(index) ?? 1);
        ctx.restore();
      }
    };

    /**
     * 兜底：搜索几轮落回的牌和拖拽会把堆越摞越高，预算公式管不住这些事后形态。
     * 每秒量一次睡稳牌的堆顶（飞行中的牌本来就不参与测量），越过净空线就整体缩一档牌，
     * 唤醒全堆重新压实。只缩不放；缩完的堆要花几秒重新压实，期间顶点读数偏低不可信，
     * 靠 3 秒冷却隔开两次缩放，靠 20px 滞回收手，否则会在门槛上反复缩放。
     */
    let lastGovern = 0;
    const govern = () => {
      if (reduced || scene.holds.size || scene.added !== scene.bodies.length || scene.now - lastGovern < 3000) return;
      const apex = settledApex();
      if (apex === null) return;
      const line = apexLineY(scene.height);
      if (apex >= line - 20) return;
      const ratio = (scene.height - line) / (scene.height - apex);
      const factor = Math.max(0.88, Math.min(1, ratio ** 0.75));
      if (factor >= 1 || scene.plateH <= PILE_MIN + 0.5) return;
      lastGovern = scene.now;
      applySide(scene.plateH * factor, scene.dpr);
      for (const body of scene.bodies) Matter.Sleeping.set(body, false);
    };

    const SUB = STEP / SUBSTEPS;
    const CATCH_UP = 4;
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    let acc = 0;
    let dropAt = performance.now() + 200;
    let lastShake = 0;

    if (reduced) {
      Matter.Composite.add(engine.world, scene.bodies);
      scene.bodies.forEach((_, index) => scene.live.add(index));
      scene.added = scene.bodies.length;
      for (let i = 0; i < 500; i++) Matter.Engine.update(engine, STEP);
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const raw = now - last;
      if (raw > 0 && raw < 500) {
        pace.push(raw);
        if (pace.length > 240) pace.shift();
      }
      const elapsed = Math.min(now - last, 120);
      last = now;
      scene.now = now;
      if (!reduced) {
        const gap = Math.min(50, 4000 / Math.max(1, scene.bodies.length));
        let poured = 0;
        while (scene.added < scene.bodies.length && now >= dropAt && poured < 12) {
          const index = scene.added++;
          if (!scene.live.has(index)) {
            Matter.Composite.add(engine.world, scene.bodies[index]);
            scene.live.add(index);
          }
          dropAt = Math.max(dropAt + gap, now - 100);
          poured++;
          scene.dirty = true;
        }
        acc += elapsed;
        let ran = 0;
        const t0 = performance.now();
        while (acc >= SUB && ran < CATCH_UP) {
          applyGrowth(scene, SUB / STEP);
          applyHoldForces(scene, SUB);
          bounds.limitSpeeds(SUB);
          Matter.Engine.update(engine, SUB);
          acc -= SUB;
          ran++;
        }
        if (ran) stats.stepMs += ((performance.now() - t0) / ran - stats.stepMs) * 0.1;
        if (acc > SUB * CATCH_UP) acc = 0;
      }
      bounds.patrol(++frames);
      if (frames % 60 === 0) govern();
      matches.tick(now);
      let awake = 0;
      for (let i = 0; i < scene.added; i++) if (!scene.bodies[i].isSleeping) awake++;
      stats.awake = awake;
      if (awake) scene.dirty = true;
      if (scene.dirty) {
        const t0 = performance.now();
        draw();
        stats.drawMs += (performance.now() - t0 - stats.drawMs) * 0.1;
        scene.dirty = false;
      }
    };
    raf = requestAnimationFrame(frame);

    apiRef.current = {
      shake(intensity) {
        const at = performance.now();
        if (at - lastShake < 70 || !scene.added) return;
        lastShake = at;
        const power = Math.max(0.05, Math.min(1, intensity));
        const jolts = Math.min(28, Math.ceil(scene.added * 0.06));
        for (let n = 0; n < jolts; n++) {
          const index = Math.floor(Math.random() * scene.added);
          if (scene.holds.has(index)) continue;
          const body = scene.bodies[index];
          if (body.position.y < scene.height * 0.45) continue;
          Matter.Sleeping.set(body, false);
          Matter.Body.setVelocity(body, { x: body.velocity.x + (Math.random() - 0.5) * 2.2 * power, y: body.velocity.y - Math.random() * 1.6 * power });
        }
        scene.dirty = true;
      },
      select: (found, getAnchor) => {
        matches.select(found, getAnchor);
      },
      release: () => {
        matches.release();
      },
    };

    const onResize = () => {
      resize();
      matches.relayout();
    };
    window.addEventListener("resize", onResize);
    const onWheel = (event: WheelEvent) => {
      if (matches.scrollBy(event.deltaY, event.clientX, event.clientY)) event.preventDefault();
    };
    window.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      bounds.destroy();
      relayoutRef.current = () => {};
      apiRef.current = null;
      sceneRef.current = null;
      Matter.Composite.clear(engine.world, false);
      Matter.Engine.clear(engine);
    };
  }, [plates, apiRef]);

  // Theme switch re-bakes the sprites only; the pile keeps its physics state.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || scene.theme === theme) return;
    scene.theme = theme;
    const baked = bakeAtlas(scene.codes, scene.names, scene.industries, theme, scene.plateW, scene.plateH, scene.dpr, scene.face);
    scene.atlas = baked.canvas;
    scene.atlasCols = baked.cols;
    scene.cellW = baked.cellW;
    scene.cellH = baked.cellH;
    scene.gutter = baked.gutter;
    scene.sprites.forEach((_, index) => {
      scene.sprites.set(
        index,
        renderPlate(scene.names[index], scene.codes[index], scene.plateW, scene.plateH, scene.dpr, {
          theme,
          industry: scene.industries[index],
          face: scene.face,
          logo: scene.face === "text" ? null : logoFor(scene.codes[index]),
          hero: scene.heroes[index] || null,
          hint: scene.hints[index] || null,
        }),
      );
    });
    scene.holds.forEach((hold, index) => {
      scene.sharp.set(
        index,
        renderPlate(scene.names[index], scene.codes[index], hold.rest.w, hold.rest.h, scene.dpr, {
          theme,
          industry: scene.industries[index],
          face: scene.face,
          logo: scene.face === "text" ? null : logoFor(scene.codes[index]),
          showIndustry: plateShowsIndustry(theme),
          hero: scene.heroes[index] || null,
          hint: scene.hints[index] || null,
        }),
      );
    });
    scene.dirty = true;
  }, [theme]);

  // 卡面切换：文字↔LOGO 改变卡面纵横比——逐轴重缩全部刚体并唤醒全堆重新沉降，
  // 再重烤图集、重排举牌格、重建 sprite/sharp。物理规律本身不动。
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || scene.face === face) return;
    const prevW = scene.plateW;
    scene.face = face;
    scene.plateW = scene.plateH * aspectFor(face);
    scene.bigW = scene.bigH;
    if (scene.bodies.length) {
      const fx = scene.plateW / prevW;
      for (const body of scene.bodies) {
        Matter.Body.scale(body, fx, 1);
        Matter.Sleeping.set(body, false);
      }
    }
    const baked = bakeAtlas(scene.codes, scene.names, scene.industries, scene.theme, scene.plateW, scene.plateH, scene.dpr, face);
    scene.atlas = baked.canvas;
    scene.atlasCols = baked.cols;
    scene.cellW = baked.cellW;
    scene.cellH = baked.cellH;
    scene.gutter = baked.gutter;
    relayoutRef.current();
    scene.sprites.forEach((_, index) => {
      scene.sprites.set(
        index,
        renderPlate(scene.names[index], scene.codes[index], scene.plateW, scene.plateH, scene.dpr, {
          theme: scene.theme,
          industry: scene.industries[index],
          face,
          logo: face === "text" ? null : logoFor(scene.codes[index]),
          hero: scene.heroes[index] || null,
          hint: scene.hints[index] || null,
        }),
      );
    });
    scene.holds.forEach((hold, index) => {
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
    scene.dirty = true;
  }, [face]);

  // LOGO 到达：只重绘对应图集格与已存在的 sprite/sharp，渲染循环零改动。
  useEffect(() => {
    if (face === "text") return;
    return subscribeLogos(() => {
      const scene = sceneRef.current;
      const loaded = takeLoadedLogos();
      if (!scene || !scene.atlas || !loaded.length) return;
      const atlasCtx = scene.atlas.getContext("2d");
      if (!atlasCtx) return;
      const stepX = scene.cellW + scene.gutter;
      const stepY = scene.cellH + scene.gutter;
      for (const code of loaded) {
        // scene.codes 含搜索注入的池外码，indexOf 同时覆盖池内与注入两类。
        const index = scene.codes.indexOf(code);
        if (index === -1) continue;
        const logo = logoFor(code);
        drawPlate(
          atlasCtx,
          (index % scene.atlasCols) * stepX,
          Math.floor(index / scene.atlasCols) * stepY,
          scene.cellW,
          scene.cellH,
          scene.names[index] ?? code,
          code,
          { theme: scene.theme, industry: scene.industries[index], face, logo, hero: scene.heroes[index] || null, hint: scene.hints[index] || null },
        );
        if (scene.sprites.has(index)) {
          scene.sprites.set(
            index,
            renderPlate(scene.names[index], code, scene.plateW, scene.plateH, scene.dpr, {
              theme: scene.theme,
              industry: scene.industries[index],
              face,
              logo,
              hero: scene.heroes[index] || null,
              hint: scene.hints[index] || null,
            }),
          );
        }
        const hold = scene.holds.get(index);
        if (hold) {
          scene.sharp.set(
            index,
            renderPlate(scene.names[index], code, hold.rest.w, hold.rest.h, scene.dpr, {
              theme: scene.theme,
              industry: scene.industries[index],
              face: "brand",
              logo,
              showIndustry: plateShowsIndustry(scene.theme),
              hero: scene.heroes[index] || null,
              hint: scene.hints[index] || null,
            }),
          );
        }
      }
      scene.dirty = true;
    });
  }, [face]);

  return <canvas ref={canvasRef} className="fixed inset-0 h-full w-full touch-none" />;
});
