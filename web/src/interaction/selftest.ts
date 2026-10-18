/**
 * selftest.ts — headless (no DOM, no GL) self-test for the interaction logic.
 *
 * Covers the two SPEC-required checks:
 *   1. point-in-polygon correctness on a known square, and a full lassoSelect
 *      over a synthetic PointData + Camera3D (a known square selects exactly the
 *      cell that projects inside it);
 *   2. a projection sanity check (the bounds centre lands at screen centre and
 *      is flagged visible; a point behind the camera is flagged not-visible).
 *
 * Throws on the first failure; returns a short log on success. Run via the temp
 * driver `_interaction_selftest.mjs`.
 */
import { Camera3D } from "../core/camera3d.ts";
import type { PointData } from "../core/types.ts";
import { projectToScreen } from "./projection.ts";
import { pointInPolygon, lassoSelect, type Point2 } from "./lasso.ts";
import { SelectionStore, type SummarySource } from "./selection-store.ts";

export function interactionSelfTest(): string[] {
  const log: string[] = [];
  const ok = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error("interaction self-test FAILED: " + msg);
    log.push("ok: " + msg);
  };

  // ---- 1a. point-in-polygon on a known square [0,0]..[10,10] ----
  const square: Point2[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  ok(pointInPolygon(5, 5, square), "centre (5,5) inside unit square");
  ok(!pointInPolygon(-1, 5, square), "(-1,5) left of square is outside");
  ok(!pointInPolygon(15, 5, square), "(15,5) right of square is outside");
  ok(!pointInPolygon(5, -1, square), "(5,-1) below square is outside");
  ok(!pointInPolygon(5, 15, square), "(5,15) above square is outside");
  // concave polygon (an L / arrow) — ensure even-odd handles a notch
  const concave: Point2[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [6, 10],
    [6, 4],
    [4, 4],
    [4, 10],
    [0, 10],
  ];
  ok(pointInPolygon(2, 8, concave), "concave: (2,8) inside left prong");
  ok(!pointInPolygon(5, 8, concave), "concave: (5,8) inside the notch is outside");

  // ---- 1b. full lassoSelect over a synthetic scene ----
  const cam = new Camera3D();
  cam.setViewport(1000, 1000, 1);
  const bounds = [-10, -10, -10, 10, 10, 10];
  cam.fit(bounds);
  // 3 points: A at centre, B far +x, C far -x. Identity rotation looks down -Z,
  // so world x → screen x, world y → screen y; A→centre, B→right, C→left.
  const pd: PointData = {
    count: 3,
    dims: 3,
    positions: Float32Array.from([0, 0, 0, 8, 0, 0, -8, 0, 0]),
    values: Float32Array.from([0.5, 0.5, 0.5]),
    categories: Uint16Array.from([0, 1, 0]),
    ids: Uint32Array.from([100, 200, 300]),
    bounds,
  };

  // projection sanity: centre point projects to screen centre & is visible.
  const proj = projectToScreen(pd, cam, 1);
  ok(
    Math.abs(proj.sx[0] - 500) < 0.5 && Math.abs(proj.sy[0] - 500) < 0.5,
    `centre point projects to screen centre (${proj.sx[0].toFixed(2)}, ${proj.sy[0].toFixed(2)})`,
  );
  ok(proj.vis[0] === 1, "centre point flagged visible");
  ok(proj.sx[1] > 560, `B (+x) projects right of centre (sx=${proj.sx[1].toFixed(1)})`);
  ok(proj.sx[2] < 440, `C (-x) projects left of centre (sx=${proj.sx[2].toFixed(1)})`);

  // a 100px square centred on screen → selects ONLY A (id 100).
  const lassoSquare: Point2[] = [
    [450, 450],
    [550, 450],
    [550, 550],
    [450, 550],
  ];
  const selected = lassoSelect(lassoSquare, pd, cam, 1);
  ok(selected.length === 1 && selected[0] === 100, `lasso square selects exactly id 100 (got [${[...selected].join(",")}])`);

  // a wide square → selects all three ids.
  const wide: Point2[] = [
    [0, 0],
    [1000, 0],
    [1000, 1000],
    [0, 1000],
  ];
  const all = lassoSelect(wide, pd, cam, 1);
  ok(all.length === 3, `wide lasso selects all 3 (got ${all.length})`);

  // degenerate polygon (<3 pts) selects nothing.
  ok(lassoSelect([[0, 0], [1, 1]], pd, cam, 1).length === 0, "polygon with 2 vertices selects nothing");

  // ---- 1c. projection visibility: a point behind the camera is not visible ----
  // camera eye is at +Z (identity rotation, distance>0); a point far behind it
  // along +Z should fail the depth01∈[0,1] test.
  const behind: PointData = {
    count: 1,
    dims: 3,
    positions: Float32Array.from([0, 0, cam.distance * 10]),
    values: Float32Array.from([0]),
    categories: Uint16Array.from([0]),
    ids: Uint32Array.from([999]),
    bounds,
  };
  const behindProj = projectToScreen(behind, cam, 1);
  ok(behindProj.vis[0] === 0, "point behind the camera flagged not-visible");

  // ---- 2. SelectionStore + summarize ----
  const store = new SelectionStore();
  ok(store.isEmpty && store.count === 0, "store starts empty");
  store.set(Uint32Array.from([100, 200, 300, 100])); // note: 100 duplicated by lasso? still stored as-is
  ok(store.count === 4, "store.set keeps the given ids (count=4)");

  // a fake source mapping ids → cellType / dataset (mimics spine getCell).
  const names: Record<number, { cellType: string; dataset?: string }> = {
    100: { cellType: "T cell", dataset: "ds-A" },
    200: { cellType: "B cell", dataset: "ds-A" },
    300: { cellType: "T cell", dataset: "ds-B" },
  };
  const source: SummarySource = {
    getCell: (id: number) => ({ id, x: 0, y: 0, ...(names[id] ?? { cellType: "Unknown" }) }),
  };
  const summary = store.summarize(pd, source);
  ok(summary.count === 4, "summary count == selection count");
  ok(summary.topType?.name === "T cell" && summary.topType?.count === 3, `top type is T cell ×3 (got ${summary.topType?.name} ×${summary.topType?.count})`);
  ok(Math.abs((summary.topType?.pct ?? 0) - 75) < 1e-6, `top type pct == 75 (got ${summary.topType?.pct})`);
  ok(summary.types.length === 2, "two distinct cell types");
  ok(!!summary.datasets && summary.datasets.length === 2, "datasets rolled up (ds-A, ds-B)");
  ok(summary.datasets?.[0].name === "ds-A" && summary.datasets?.[0].count === 3, "top dataset is ds-A ×3");

  store.clear();
  ok(store.isEmpty, "store.clear empties selection");
  const empty = store.summarize(pd, source);
  ok(empty.count === 0 && empty.topType === null && empty.types.length === 0, "empty summary is well-formed");

  log.push(`PASS — ${log.length} assertions`);
  return log;
}
