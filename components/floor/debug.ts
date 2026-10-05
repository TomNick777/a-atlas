import Matter from "matter-js";
import type { Scene } from "./scene";

export function overlaps(scene: Scene) {
  let deep = 0;
  let outside = 0;
  const { bodies } = scene;
  for (let i = 0; i < scene.added; i++) {
    const a = bodies[i];
    const { x, y } = a.position;
    if (x < -scene.plateW || x > scene.width + scene.plateW || y > scene.height + scene.plateH || Number.isNaN(x + y)) outside++;
    if (scene.holds.has(i)) continue;
    for (let j = i + 1; j < scene.added; j++) {
      if (scene.holds.has(j)) continue;
      const hit = Matter.Collision.collides(a, bodies[j], 0);
      if (hit && (hit.depth ?? 0) > 1.5) deep++;
    }
  }
  return { deep, outside };
}

export function jolt(scene: Scene) {
  for (let i = 0; i < scene.added; i++) {
    if (scene.holds.has(i)) continue;
    const body = scene.bodies[i];
    Matter.Sleeping.set(body, false);
    Matter.Body.setVelocity(body, { x: (Math.random() - 0.5) * 14, y: -8 - Math.random() * 10 });
    Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.3);
  }
  scene.dirty = true;
}
