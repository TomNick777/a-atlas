import Matter from "matter-js";
import type { Scene } from "./scene";

const WALL = 400;
export const HEADROOM = 140;

export function createBounds(scene: Scene, canvas: HTMLCanvasElement, mouse: Matter.Mouse) {
  const { engine, bodies } = scene;
  let walls: Matter.Body[] = [];
  let ceiling: Matter.Body | null = null;
  let checked = 0;

  const makeCeiling = () => Matter.Bodies.rectangle(scene.width / 2, -HEADROOM - WALL / 2, scene.width + WALL * 2, WALL, { isStatic: true });

  const clampPointer = () => {
    const pad = scene.plateH / 2;
    mouse.position.x = Math.max(pad, Math.min(scene.width - pad, mouse.position.x));
    mouse.position.y = Math.max(pad, Math.min(scene.height - pad, mouse.position.y));
  };
  canvas.addEventListener("mousemove", clampPointer);

  return {
    build() {
      Matter.Composite.remove(engine.world, walls);
      walls = [
        Matter.Bodies.rectangle(scene.width / 2, scene.height + WALL / 2, scene.width + WALL * 2, WALL, { isStatic: true, friction: 0.9 }),
        Matter.Bodies.rectangle(-WALL / 2, scene.height / 2, WALL, scene.height * 4 + WALL * 2, { isStatic: true }),
        Matter.Bodies.rectangle(scene.width + WALL / 2, scene.height / 2, WALL, scene.height * 4 + WALL * 2, { isStatic: true }),
      ];
      if (ceiling) walls.push((ceiling = makeCeiling()));
      Matter.Composite.add(engine.world, walls);
    },

    /** Cap travel to under half the short side, so a fast plate cannot tunnel. */
    limitSpeeds(dt: number) {
      const perStep = 1000 / 60 / dt;
      for (let i = 0; i < scene.added; i++) {
        const body = bodies[i];
        if (body.isSleeping) continue;
        const most = scene.plateH * (scene.grown.get(i) ?? 1) * 0.45 * perStep;
        const speed = Matter.Body.getSpeed(body);
        if (speed > most) {
          const velocity = Matter.Body.getVelocity(body);
          Matter.Body.setVelocity(body, { x: (velocity.x * most) / speed, y: (velocity.y * most) / speed });
        }
      }
    },

    patrol(frame: number) {
      if (frame - checked < 60) return;
      checked = frame;
      if (!ceiling && scene.added === bodies.length && bodies.every((body) => body.position.y > scene.plateH)) {
        ceiling = makeCeiling();
        walls.push(ceiling);
        Matter.Composite.add(engine.world, ceiling);
      }
      for (let i = 0; i < scene.added; i++) {
        const { x, y } = bodies[i].position;
        const out = x < -scene.plateW || x > scene.width + scene.plateW || y > scene.height + scene.plateH || (ceiling && y < -HEADROOM) || Number.isNaN(x + y);
        if (!out || scene.holds.has(i)) continue;
        Matter.Body.setPosition(bodies[i], { x: scene.width * (0.3 + Math.random() * 0.4), y: scene.plateH * 2 });
        Matter.Body.setVelocity(bodies[i], { x: 0, y: 0 });
        Matter.Sleeping.set(bodies[i], false);
      }
    },

    destroy: () => canvas.removeEventListener("mousemove", clampPointer),
  };
}
