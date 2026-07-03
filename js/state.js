/**
 * state.js — shared layout state for the unified JAL studio (Phase 3).
 *
 * Per-plan model (PLAN_unified_app.md → "Variations (named layouts)"):
 *   { variations: { <name>: pieces[] }, active: <name> }
 * persisted in localStorage under "jal_app_<slug>". The first variation is
 * seeded from the OLD studio's autosave ("jal_layout_<slug>") if present,
 * else from a fallback (app/test/golden_layout.json), and named "Current".
 *
 * Pieces keep the old studio's shape {id,name,w,d,color,x,y,rot} — crop-space
 * feet — so Export stays byte-compatible with layouts/*.json (Blender hero
 * renders). Piece ids are stable across edits and unique across ALL
 * variations (viewer3d.update reconciles by id).
 *
 * Undo/redo is per-variation and in-memory only; switching variations does
 * not pollute a variation's stack.
 */

const clone = (x) => JSON.parse(JSON.stringify(x));
const UNDO_DEPTH = 100;

export class LayoutState {
  /** @param {string} planSlug e.g. "1x1_Large_B" @param {number} ppf plan px/ft */
  constructor(planSlug, ppf) {
    this.planSlug = planSlug;
    this.ppf = ppf;
    this.key = "jal_app_" + planSlug;          // unified-app autosave
    this.legacyKey = "jal_layout_" + planSlug; // old studio autosave (read-only seed)
    this.variations = {};                      // name -> pieces[]
    this.active = null;
    this.onChange = null;   // (reason) => void — pieces array REPLACED or variations changed
    this._stacks = {};      // name -> {undo: pieces[][], redo: pieces[][]}
    this._last = {};        // name -> snapshot at last commit (the undo unit)
    this._uid = 1;
  }

  /** Load autosave; seed "Current" from the legacy key or fallbackPieces. */
  init(fallbackPieces = []) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(this.key)); } catch (e) { /* corrupt -> reseed */ }
    if (stored && stored.variations && Object.keys(stored.variations).length) {
      this.variations = stored.variations;
      this.active = stored.active in stored.variations
        ? stored.active : Object.keys(stored.variations)[0];
    } else {
      let seed = null;
      try {
        const v = JSON.parse(localStorage.getItem(this.legacyKey));
        if (Array.isArray(v) && v.length) seed = v;
      } catch (e) { /* no legacy autosave */ }
      this.variations = { Current: seed ?? clone(fallbackPieces) };
      this.active = "Current";
      this._persist();
    }
    this._reseedUid();
    this._last[this.active] = clone(this.pieces());
  }

  /** The ACTIVE variation's live pieces array (editor mutates it in place). */
  pieces() { return this.variations[this.active]; }

  names() { return Object.keys(this.variations); }

  /** Fresh piece id, unique across every variation. */
  nextId() { return this._uid++; }

  _reseedUid() {
    let m = 0;
    for (const ps of Object.values(this.variations))
      for (const p of ps) if (typeof p.id === "number" && p.id > m) m = p.id;
    this._uid = m + 1;
  }

  _persist() {
    localStorage.setItem(this.key,
      JSON.stringify({ variations: this.variations, active: this.active }));
  }

  _stack(name) {
    return this._stacks[name] ?? (this._stacks[name] = { undo: [], redo: [] });
  }

  _notify(reason) { if (this.onChange) this.onChange(reason); }

  // ---- edits (editor mutates pieces() in place, then commits) ----

  /** One undo unit: call AFTER a completed change (drag end, add, delete…). */
  commit() {
    const st = this._stack(this.active);
    st.undo.push(this._last[this.active]);
    if (st.undo.length > UNDO_DEPTH) st.undo.shift();
    st.redo.length = 0;
    this._last[this.active] = clone(this.pieces());
    this._persist();
  }

  /** Autosave without an undo unit (e.g. mid-gesture safety save). */
  save() { this._persist(); }

  canUndo() { return this._stack(this.active).undo.length > 0; }
  canRedo() { return this._stack(this.active).redo.length > 0; }

  undo() {
    const st = this._stack(this.active);
    if (!st.undo.length) return false;
    st.redo.push(clone(this.pieces()));
    this.variations[this.active] = st.undo.pop();
    this._last[this.active] = clone(this.pieces());
    this._persist(); this._notify("undo");
    return true;
  }

  redo() {
    const st = this._stack(this.active);
    if (!st.redo.length) return false;
    st.undo.push(clone(this.pieces()));
    this.variations[this.active] = st.redo.pop();
    this._last[this.active] = clone(this.pieces());
    this._persist(); this._notify("redo");
    return true;
  }

  // ---- variations ----

  switchTo(name) {
    if (!(name in this.variations) || name === this.active) return false;
    this.active = name;
    if (!(name in this._last)) this._last[name] = clone(this.pieces());
    this._persist(); this._notify("switch");
    return true;
  }

  /** Save the active variation under a new name and switch to the copy. */
  saveAsCopy(name) {
    name = this._uniqueName(name);
    this.variations[name] = clone(this.pieces());
    this.active = name;
    this._last[name] = clone(this.pieces());
    this._persist(); this._notify("save-as");
    return name;
  }

  rename(newName) {
    newName = (newName ?? "").trim();
    if (!newName || newName === this.active) return this.active;
    newName = this._uniqueName(newName);
    const old = this.active;
    this.variations[newName] = this.variations[old];
    delete this.variations[old];
    if (this._stacks[old]) { this._stacks[newName] = this._stacks[old]; delete this._stacks[old]; }
    if (old in this._last) { this._last[newName] = this._last[old]; delete this._last[old]; }
    this.active = newName;
    this._persist(); this._notify("rename");
    return newName;
  }

  /** Delete the active variation. Refuses to delete the last one. */
  remove() {
    const names = this.names();
    if (names.length <= 1) return false;
    const old = this.active;
    delete this.variations[old];
    delete this._stacks[old];
    delete this._last[old];
    this.active = this.names()[0];
    if (!(this.active in this._last)) this._last[this.active] = clone(this.pieces());
    this._persist(); this._notify("delete");
    return true;
  }

  // ---- import / export (OLD studio format, unchanged) ----

  /** Export the active variation: {plan, ppf, pieces} — feeds Blender hero renders. */
  exportActive() {
    return { plan: this.planSlug, ppf: this.ppf, pieces: clone(this.pieces()) };
  }

  /**
   * Import pieces as a NEW variation (named from the file) and switch to it.
   * Ids are kept (export -> import round-trips identically); only duplicates
   * or missing ids WITHIN the file get fresh ones. The uid counter is global,
   * so future adds stay unique.
   */
  importVariation(name, pieces) {
    const ps = clone(pieces);
    const used = new Set();
    for (const p of ps) {
      if (typeof p.id !== "number" || used.has(p.id)) p.id = this.nextId();
      used.add(p.id);
      if (p.id >= this._uid) this._uid = p.id + 1;
    }
    name = this._uniqueName((name ?? "").trim() || "Imported");
    this.variations[name] = ps;
    this.active = name;
    this._last[name] = clone(ps);
    this._persist(); this._notify("import");
    return name;
  }

  _uniqueName(base) {
    base = (base ?? "").trim() || "Variation";
    if (!(base in this.variations)) return base;
    let i = 2;
    while (`${base} ${i}` in this.variations) i++;
    return `${base} ${i}`;
  }
}
