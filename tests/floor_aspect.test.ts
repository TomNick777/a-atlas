import Matter from "matter-js";
import { expect, it } from "vitest";
import { changeCardAspect } from "../components/floor/forces";

it("square result cards have square hit areas and return to their rotated pile shape", () => {
  const body = Matter.Bodies.rectangle(100, 120, 120, 40, { angle: 0.4 });
  const initial = body.vertices.map(vertex => ({ x: vertex.x, y: vertex.y }));
  changeCardAspect(body, 3, 1);
  expect(body.angle).toBeCloseTo(0.4);
  const outside = { x: 100 + 40 * Math.cos(0.4), y: 120 + 40 * Math.sin(0.4) };
  expect(Matter.Query.point([body], outside)).toHaveLength(0);
  expect(Matter.Query.point([body], { x: 100, y: 120 })).toHaveLength(1);
  changeCardAspect(body, 1, 3);
  expect(Matter.Query.point([body], outside)).toHaveLength(1);
  body.vertices.forEach((vertex, index) => {
    expect(vertex.x).toBeCloseTo(initial[index].x);
    expect(vertex.y).toBeCloseTo(initial[index].y);
  });
});
