import Matter from "matter-js";
import type { Scene } from "./scene";

export const STEP = 1000 / 60;
export const SUBSTEPS = 3;

const SPRING = 0.00002;
const DAMPING = 0.00046;
const TURN = 0.0000043;
const TURN_DAMPING = 0.00026;

/** Wake only the neighbours of a spot, never the whole pile. */
export function wakeAt(scene: Scene, x: number, y: number) {
  const reach = (scene.plateH * 3.2) ** 2;
  const column = scene.plateW * 1.3;
  for (let k = 0; k < scene.added; k++) {
    const other = scene.bodies[k];
    if (!other.isSleeping || scene.holds.has(k)) continue;
    const dx = other.position.x - x;
    const dy = other.position.y - y;
    if (dx * dx + dy * dy < reach || (Math.abs(dx) < column && dy < scene.plateH)) Matter.Sleeping.set(other, false);
  }
}

export const wakeNear = (scene: Scene, body: Matter.Body) => wakeAt(scene, body.position.x, body.position.y);

/**
 * Gravity is cancelled and a soft spring pulls the plate to its cell.
 * Runs once per physics substep. Velocities are read per 1/60s, so the tuning holds.
 */
export function applyHoldForces(scene: Scene, dt: number) {
  const { engine, bodies, holds } = scene;
  let moving = false;
  holds.forEach((hold, index) => {
    const body = bodies[index];
    if (hold.parked) {
      if (!body.isSleeping) Matter.Sleeping.set(body, true);
      return;
    }
    moving = true;
    Matter.Sleeping.set(body, false);
    const part = dt / STEP;
    const velocity = Matter.Body.getVelocity(body);
    hold.t += dt / 1000;
    const restY = hold.rest.y - scene.scroll;
    const far = Math.abs(restY - body.position.y) > 40;
    hold.boost = far && Matter.Body.getSpeed(body) < 3 ? Math.min(6, hold.boost + 0.12 * part) : Math.max(1, hold.boost - 0.15 * part);
    if (hold.boost > 1.2) wakeNear(scene, body);
    const near = Math.max(26, scene.plateH * hold.scale * 0.8);
    if (!hold.arrived && ((Math.abs(restY - body.position.y) < near && Math.abs(hold.rest.x - body.position.x) < near) || hold.t > 3)) {
      hold.arrived = true;
      body.collisionFilter.mask = 0;
      wakeNear(scene, body);
    }
    const firm = hold.arrived ? 5 : 1;
    const pullX = (hold.rest.x - body.position.x) * SPRING * hold.boost * firm - velocity.x * DAMPING * Math.sqrt(firm);
    const pullY = (restY - body.position.y) * SPRING * hold.boost * firm - velocity.y * DAMPING * Math.sqrt(firm);
    Matter.Body.applyForce(body, body.position, {
      x: (pullX - engine.gravity.x * engine.gravity.scale) * body.mass,
      y: (pullY - engine.gravity.y * engine.gravity.scale) * body.mass,
    });
    const lean = Math.atan2(Math.sin(body.angle), Math.cos(body.angle));
    const brisk = hold.arrived ? 7 : 1;
    body.torque += (-lean * TURN * brisk - Matter.Body.getAngularVelocity(body) * TURN_DAMPING * Math.sqrt(brisk)) * body.inertia;
    const off = Math.hypot(hold.rest.x - body.position.x, restY - body.position.y);
    const grownUp = Math.abs((scene.grown.get(index) ?? 1) - hold.scale) < 0.02;
    const settled = off < 0.8 && Math.abs(lean) < 0.02 && Matter.Body.getSpeed(body) < 0.12;
    if (hold.arrived && grownUp && (settled || hold.t > 7)) park(scene, index);
  });
  if (moving) scene.dirty = true;
}

export function park(scene: Scene, index: number) {
  const hold = scene.holds.get(index);
  if (!hold) return;
  const body = scene.bodies[index];
  Matter.Body.setPosition(body, { x: hold.rest.x, y: hold.rest.y - scene.scroll });
  Matter.Body.setAngle(body, 0);
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  Matter.Body.setAngularVelocity(body, 0);
  Matter.Sleeping.set(body, true);
  hold.parked = true;
  hold.arrived = true;
  body.collisionFilter.mask = 0;
  scene.dirty = true;
}

export function applyGrowth(scene: Scene, part = 1) {
  scene.grown.forEach((scale, index) => {
    const body = scene.bodies[index];
    const hold = scene.holds.get(index);
    let want = 1;
    if (hold) {
      const span = hold.startY - (hold.rest.y - scene.scroll);
      const progress = Math.abs(span) > 1 ? Math.max(0, Math.min(1, (hold.startY - body.position.y) / span)) : 1;
      const late = Math.max(0, (progress - 0.3) / 0.7);
      want = 1 + (hold.scale - 1) * late * late * (3 - 2 * late);
    }
    let next = scale + (want - scale) * (part >= 1 ? 0.12 : 1 - (1 - 0.12) ** part);
    if (Math.abs(want - next) < 0.004) next = want;
    if (next !== scale) {
      Matter.Sleeping.set(body, false);
      const factor = next / scale;
      Matter.Body.scale(body, factor, factor);
      scene.dirty = true;
    }
    if (next === 1 && !hold) scene.grown.delete(index);
    else scene.grown.set(index, next);
  });
}
