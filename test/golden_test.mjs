#!/usr/bin/env node
/**
 * golden_test.mjs — Phase 2 gate: app/js/mapping.js must reproduce the
 * Blender placement path (blender/render_layout.py) for the golden layout.
 *
 * Prereq (regenerate the dump when render_layout.py or the layout changes):
 *   /Applications/Blender.app/Contents/MacOS/Blender --background \
 *       --python scripts/dump_layout_positions.py -- \
 *       --layout app/test/golden_layout.json --out app/test/golden_dump.json
 * Run:
 *   node app/test/golden_test.mjs
 *
 * Pass criteria (per PLAN_unified_app.md): every piece within 0.1 ft in X/Y
 * (and Z where mount_z applies), rotation matching mod 360.
 *
 * Dump conventions handled here (documented in dump_layout_positions.py):
 *  - kind "box": dumped Z is the piece CENTER (mount_z + h/2) -> subtract h/2.
 *  - kind "scan": dumped rotation is (-rot + scan_rot); the Phase-1 assets bake
 *    scan_rot, so mapping.js yields -rot -> subtract scan_rot from the dump.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapPiece } from "../js/mapping.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const load = (p) => JSON.parse(readFileSync(p, "utf8"));

const layout = load(join(HERE, "golden_layout.json"));
const dump = load(join(HERE, "golden_dump.json"));
const manifest = load(join(ROOT, "app", "assets", "manifest.json"));
const plans = load(join(ROOT, "plan", "plans.json"));

const pmeta = plans[layout.plan ?? "1x1_Large_B"];
const plan = {
  ppf: layout.ppf ?? pmeta.ppf,
  wallBboxInCrop: pmeta.wall_bbox_in_crop,
  interiorD: manifest.env.interior_d,
};

const POS_TOL = 0.1;  // ft
const ROT_TOL = 0.5;  // deg, mod 360

const norm360 = (a) => ((a % 360) + 360) % 360;
const rotDelta = (a, b) => {
  const d = norm360(a - b);
  return Math.min(d, 360 - d);
};

let failures = 0;
const rows = [];
for (const dp of dump.pieces) {
  const pc = layout.pieces[dp.index];
  if (dp.error || !pc || pc.name !== dp.name) {
    failures++;
    rows.push([dp.index, dp.name ?? "?", "-", "-", "-", "-", `FAIL (${dp.error ?? "piece mismatch"})`]);
    continue;
  }
  const meta = manifest.items[pc.name] ?? {};
  const m = mapPiece(pc, meta, plan);

  const dx = Math.abs(dp.location_ft[0] - m.worldFt[0]);
  const dy = Math.abs(dp.location_ft[1] - m.worldFt[1]);
  // dumped Z: bottom for everything except boxes (center = mount_z + h/2)
  const dumpBottomZ = dp.kind === "box" ? dp.location_ft[2] - dp.h / 2 : dp.location_ft[2];
  const dz = Math.abs(dumpBottomZ - m.worldFt[2]);
  // dumped rot for scans includes scan_rot (baked into the app assets)
  const dumpRot = dp.rot_z_deg - (dp.kind === "scan" ? dp.scan_rot : 0);
  const dr = rotDelta(dumpRot, m.rotZDeg);

  const ok = dx <= POS_TOL && dy <= POS_TOL && dz <= POS_TOL && dr <= ROT_TOL;
  if (!ok) failures++;
  rows.push([dp.index, pc.name, dx.toFixed(4), dy.toFixed(4), dz.toFixed(4),
             dr.toFixed(3), ok ? "PASS" : "FAIL"]);
}

const widths = [3, 28, 8, 8, 8, 7, 4];
const line = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join("  ");
console.log(line(["#", "piece", "dx_ft", "dy_ft", "dz_ft", "drot", "res"]));
for (const r of rows) console.log(line(r));
console.log(`\n${rows.length - failures}/${rows.length} pieces pass ` +
            `(tol ${POS_TOL} ft, ${ROT_TOL} deg mod 360)`);
process.exit(failures ? 1 : 0);
