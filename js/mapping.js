/**
 * mapping.js — THE crop-space → glTF-space transform (single source).
 *
 * Converts a layout piece {x, y, w, d, rot} (crop-space FEET, origin = plan
 * image top-left, y grows DOWN) plus its manifest meta ({mount_z}) into the
 * transform for the Phase-1 GLB assets (meters, +Y up, origin bottom-center,
 * scan_rot already BAKED into each asset).
 *
 * Ported exactly from blender/render_layout.py:
 *   off_x = wall_bbox_in_crop[0] / ppf ; off_y = wall_bbox_in_crop[1] / ppf
 *   cx = x + w/2 - off_x ; cy = y + d/2 - off_y          (interior ft, y DOWN)
 *   world X = cx ; Y = D - cy ; Z up ; rotation about Z = -rot degrees
 *   mount_z lifts the piece BOTTOM off the floor (assets are bottom-centered)
 * glTF (three.js, Y up) vs Blender world (Z up):
 *   gX = wX ; gY = wZ ; gZ = -wY ; rotation about world +Z -> same angle about glTF +Y
 *
 * Pure module: no DOM, no three.js — usable from the browser and from node
 * (app/test/golden_test.mjs is the conformance test vs the Blender path).
 */

export const FT = 0.3048; // feet -> meters

// 1x1_Large_B defaults (plan/plans.json + manifest env). Pass an explicit plan
// object to override when other units come online.
export const DEFAULT_PLAN = {
  ppf: 47.36,                          // plan image pixels per foot
  wallBboxInCrop: [93, 89, 1887, 1115], // [x0, y0, w, h] px within the crop
  interiorD: 23.55,                    // D — interior depth, feet
};

/**
 * @param {{x:number, y:number, w:number, d:number, rot?:number}} piece
 *        layout piece in crop-space feet (the 2D studio / layouts/*.json format)
 * @param {{mount_z?:number}} meta manifest item meta (mount_z in feet)
 * @param {{ppf?:number, wallBboxInCrop?:number[], interiorD?:number}} plan
 * @returns {{
 *   worldFt: [number, number, number],  // Blender world, feet; Z = piece BOTTOM
 *   rotZDeg: number,                    // Blender rotation about +Z, degrees
 *   position: [number, number, number], // glTF/three.js meters [x, y(up), z]
 *   rotationY: number,                  // three.js rotation.y, radians
 * }}
 */
export function mapPiece(piece, meta = {}, plan = DEFAULT_PLAN) {
  const ppf = plan.ppf ?? DEFAULT_PLAN.ppf;
  const bbox = plan.wallBboxInCrop ?? DEFAULT_PLAN.wallBboxInCrop;
  const D = plan.interiorD ?? DEFAULT_PLAN.interiorD;

  const offX = bbox[0] / ppf;
  const offY = bbox[1] / ppf;

  // piece center in interior feet (y still DOWN here)
  const cx = piece.x + piece.w / 2 - offX;
  const cy = piece.y + piece.d / 2 - offY;

  const mountZ = meta.mount_z ?? 0;
  const worldFt = [cx, D - cy, mountZ];
  const rotZDeg = -(piece.rot ?? 0);

  return {
    worldFt,
    rotZDeg,
    position: [worldFt[0] * FT, worldFt[2] * FT, -worldFt[1] * FT],
    rotationY: (rotZDeg * Math.PI) / 180,
  };
}
