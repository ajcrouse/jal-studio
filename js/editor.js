/**
 * editor.js — the 2D layout editor pane (Phase 3).
 *
 * Lifted nearly verbatim from the original self-contained studio
 * (~/Downloads/JAL_layout_studio/index.html) — same piece model
 * {id,name,w,d,color,x,y,rot} in crop-space feet, same drag / rotate-handle /
 * keyboard interactions, same setSel()-does-not-renderAll() fix (selecting a
 * piece mid-gesture must NOT destroy its element).
 *
 * Changes per PLAN_unified_app.md → "2D editor port":
 *  1. Library comes from assets/manifest.json (DEFAULT_LIB/LIB_VERSION gone),
 *     grouped scans / built pieces / placeholder boxes via section headers.
 *  2. Every piece change calls viewer3d.update(state) — live, no export step;
 *     drags are throttled with requestAnimationFrame.
 *  3. Export .json unchanged ({plan, ppf, pieces}); Import = new variation.
 *  4. Undo/redo (buttons + Cmd+Z / Shift+Cmd+Z), per-variation via state.js.
 *  5. Autosave per plan slug via state.js (localStorage).
 * Dropped (single verified plan, unified app): plan selector, px/ft
 * calibration UI (would desync 2D vs the fixed 3D mapping), custom-piece form.
 */
import { PLAN, PLAN_SLUG } from "./plan_data.js";

export { PLAN, PLAN_SLUG };

/**
 * @param {{state: import("./state.js").LayoutState,
 *          manifest: object,
 *          viewer: {update: (s:{pieces:object[]})=>void}}} opts
 */
export function initEditor({ state, manifest, viewer }) {
  // ---------- state ----------
  const ppf = PLAN.ppf;      // pixels-per-foot in NATURAL image px (fixed, verified vs Blender)
  let zoom = 1;              // rendered / natural
  let pieces = state.pieces(); // {id,name,w,d,color,x,y,rot}  x,y in feet from top-left
  let sel = null;
  const lib = libFromManifest(manifest);

  const $ = (s) => document.querySelector(s);
  const canvas = $("#canvas"), img = $("#planimg"), stage = $("#stage");

  // one undo unit + autosave + button state
  function commit() { state.commit(); updateUndoButtons(); }

  // ---------- live 3D sync (rAF-throttled so drags follow the cursor) ----------
  let rafPending = false;
  function sync3d() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      viewer.update({ pieces });
    });
  }

  // ---------- library from manifest ----------
  function libFromManifest(mf) {
    const groups = { scan: [], parametric: [], box: [] };
    for (const [name, m] of Object.entries(mf.items)) {
      const g = groups[m.kind] ?? groups.box;
      // clamp for the 2D pane: sub-0.3 ft asset bboxes (mirror 0.06, tapestry
      // 0.05) are undraggable slivers; the old library used 0.3 for these too.
      g.push([name, Math.max(m.w, 0.3), Math.max(m.d, 0.3), m.color ?? "#8ec5ff"]);
    }
    const out = [];
    const add = (hdr, arr) => { if (arr.length) out.push([hdr], ...arr); };
    add("── YOUR FURNITURE (scanned) ──", groups.scan);
    add("── BUILT PIECES ──", groups.parametric);
    add("── PLACEHOLDER BOXES ──", groups.box);
    return out;
  }

  // ---------- plan ----------
  function loadPlan() {
    img.onload = () => { recomputeZoom(); renderAll(); updateTopbar(); };
    img.src = PLAN.img;
    $("#planInfo").innerHTML =
      `Overall <b>${fmtFt(PLAN.overall_w_ft)}</b> wide × <b>${fmtFt(PLAN.overall_d_ft)}</b> deep`;
  }
  function recomputeZoom() {
    // fit the plan into the stage, cap so tall plans still fit reasonably
    const availW = Math.min(stage.clientWidth - 48, 1400);
    const availH = stage.clientHeight - 48;
    let z = availW / PLAN.img_w;
    if (PLAN.img_h * z > availH) z = availH / PLAN.img_h;
    zoom = z;
    canvas.style.width = (PLAN.img_w * z) + "px";
    canvas.style.height = (PLAN.img_h * z) + "px";
  }
  window.addEventListener("resize", () => { recomputeZoom(); renderAll(); });

  // ---------- helpers ----------
  function fmtFt(f) { const ft = Math.floor(f); const inch = Math.round((f - ft) * 12); return inch ? `${ft}'-${inch}"` : `${ft}'`; }
  function rpf() { return ppf * zoom; }   // rendered px per foot

  // ---------- library UI ----------
  function buildLib() {
    const el = $("#lib"); el.innerHTML = "";
    lib.forEach((it) => {
      const [n, w, d, c] = it;
      if (w === undefined) {   // section header
        const h = document.createElement("div"); h.textContent = n;
        h.style.cssText = "color:var(--muted);font-size:10px;letter-spacing:.05em;font-weight:700;padding:10px 2px 3px";
        el.appendChild(h); return;
      }
      const row = document.createElement("div"); row.className = "item";
      row.innerHTML = `<span class="swatch" style="background:${c}"></span><span class="nm">${n}</span><span class="dim">${w}×${d} ft</span>`;
      row.onclick = () => addPiece(n, w, d, c);
      el.appendChild(row);
    });
  }

  // ---------- pieces ----------
  function addPiece(name, w, d, color, x, y, rot) {
    if (x === undefined) { x = (PLAN.overall_w_ft / 2 - w / 2); y = (PLAN.overall_d_ft / 2 - d / 2); }
    const pc = { id: state.nextId(), name, w: +w, d: +d, color, x, y, rot: rot || 0 };
    pieces.push(pc); renderAll(); selectPiece(pc.id); commit(); sync3d();
    return pc;
  }
  function deleteSelected() {
    if (sel == null) return;
    const i = pieces.findIndex((p) => p.id === sel);
    if (i >= 0) pieces.splice(i, 1);   // in place — state holds this array
    sel = null; renderAll(); commit(); sync3d();
  }
  function renderAll() {
    // clear existing piece dom (keep img)
    [...canvas.querySelectorAll(".piece")].forEach((e) => e.remove());
    pieces.forEach((pc) => {
      const el = document.createElement("div"); el.className = "piece" + (sel === pc.id ? " sel" : "");
      el.dataset.id = pc.id;
      const wpx = pc.w * rpf(), dpx = pc.d * rpf();
      el.style.width = wpx + "px"; el.style.height = dpx + "px";
      el.style.left = (pc.x * rpf()) + "px"; el.style.top = (pc.y * rpf()) + "px";
      el.style.transform = `rotate(${pc.rot}deg)`;
      el.style.background = hexA(pc.color, .62);
      el.style.borderColor = pc.color;
      el.innerHTML = `<div class="plabel">${pc.name}<br>${fmtFt(pc.w)}×${fmtFt(pc.d)}</div>` +
        `<div class="rot">⟳</div><div class="delx" title="Delete this piece">✕</div>`;
      canvas.appendChild(el);
      attachDrag(el, pc);
    });
    updateSelInfo(); updateTopbar();
  }
  function hexA(hex, a) { const h = hex.replace("#", ""); const b = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16); return `rgba(${(b >> 16) & 255},${(b >> 8) & 255},${b & 255},${a})`; }

  function selectPiece(id) { sel = id; renderAll(); }
  // select WITHOUT re-rendering (so a piece being dragged/rotated isn't destroyed mid-gesture)
  function setSel(id) {
    sel = id;
    document.querySelectorAll("#canvas .piece").forEach((e) => e.classList.toggle("sel", +e.dataset.id === id));
    updateSelInfo();
  }
  function curPiece() { return pieces.find((p) => p.id === sel); }
  function updateSelInfo() {
    const pc = curPiece();
    $("#selInfo").innerHTML = pc ? `<b>${pc.name}</b> — ${fmtFt(pc.w)} × ${fmtFt(pc.d)} · rot ${pc.rot}°` : "Nothing selected.";
    if (pc) { const r = ((Math.round(pc.rot) % 360) + 360) % 360; $("#rotSlider").value = r; $("#rotNum").value = r; }
    // piece-action controls light up only with a selection (discoverability)
    for (const id of ["rotSlider", "rotNum", "rotM15", "rotP15", "rotL", "rotR", "dupe", "del"])
      $("#" + id).disabled = !pc;
  }
  // set the selected piece's angle to any value (fine rotation), no full re-render
  function setRot(deg, { commitNow = true } = {}) {
    const p = curPiece(); if (!p) return;
    p.rot = ((Math.round(deg) % 360) + 360) % 360;
    const el = canvas.querySelector('.piece[data-id="' + p.id + '"]');
    if (el) el.style.transform = "rotate(" + p.rot + "deg)";
    $("#rotSlider").value = p.rot; $("#rotNum").value = p.rot;
    updateSelInfo(); sync3d();
    if (commitNow) commit();
  }

  // drag + rotate handle
  function attachDrag(el, pc) {
    el.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("rot")) { startRotate(e, pc, el); return; }
      if (e.target.classList.contains("delx")) {
        e.preventDefault(); e.stopPropagation();
        sel = pc.id; deleteSelected(); return;
      }
      e.preventDefault(); setSel(pc.id); el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing";
      const sx = e.clientX, sy = e.clientY, ox = pc.x, oy = pc.y;
      const mv = (ev) => {
        pc.x = ox + (ev.clientX - sx) / rpf(); pc.y = oy + (ev.clientY - sy) / rpf();
        el.style.left = (pc.x * rpf()) + "px"; el.style.top = (pc.y * rpf()) + "px";
        sync3d();   // rAF-throttled — 3D follows the cursor
      };
      const up = () => {
        el.releasePointerCapture(e.pointerId); el.style.cursor = "grab";
        el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up);
        commit(); sync3d(); updateSelInfo();
      };
      el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
    });
  }
  function startRotate(e, pc, el) {
    e.preventDefault(); e.stopPropagation(); setSel(pc.id);
    const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const mv = (ev) => {
      let ang = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
      if (ev.shiftKey) { /* free */ } else ang = Math.round(ang / 5) * 5;   // snap 5° (hold Shift for free)
      pc.rot = ((Math.round(ang) % 360) + 360) % 360;
      el.style.transform = `rotate(${pc.rot}deg)`; updateSelInfo(); sync3d();
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      commit(); sync3d();
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }

  // ---------- topbar (stage info strip) ----------
  function updateTopbar() {
    $("#stagebar").innerHTML =
      `<span><b>${PLAN.name}</b></span><span>${PLAN.sqft} sq ft</span>` +
      `<span>Zoom <b>${(zoom * 100) | 0}%</b></span><span>${pieces.length} pieces</span>`;
  }

  // ---------- variations UI ----------
  function buildVarSel() {
    const s = $("#varSel"); s.innerHTML = "";
    for (const n of state.names()) {
      const o = document.createElement("option"); o.value = n; o.textContent = n; s.appendChild(o);
    }
    s.value = state.active;
  }
  function updateUndoButtons() {
    $("#undoBtn").disabled = !state.canUndo();
    $("#redoBtn").disabled = !state.canRedo();
  }
  /** Full refresh after any state-level change (undo/switch/import/…). */
  function refresh() {
    pieces = state.pieces();
    sel = null;
    buildVarSel(); renderAll(); updateUndoButtons(); sync3d();
  }
  state.onChange = refresh;

  $("#varSel").onchange = (e) => state.switchTo(e.target.value);
  $("#saveAsBtn").onclick = () => {
    const n = prompt("Name for this copy:", state.active + " copy");
    if (n != null && n.trim()) state.saveAsCopy(n.trim());
  };
  $("#renameBtn").onclick = () => {
    const n = prompt("Rename variation:", state.active);
    if (n != null && n.trim()) state.rename(n.trim());
  };
  $("#delVarBtn").onclick = () => {
    if (state.names().length <= 1) { alert("Can't delete the last variation."); return; }
    if (confirm(`Delete variation "${state.active}"?`)) state.remove();
  };
  $("#undoBtn").onclick = () => state.undo();
  $("#redoBtn").onclick = () => state.redo();

  // ---------- export / import (OLD format — feeds Blender hero renders) ----------
  function exportObject() { return state.exportActive(); }
  $("#exportJson").onclick = () => {
    const blob = new Blob([JSON.stringify(exportObject(), null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "JAL_layout_" + PLAN_SLUG + ".json"; a.click();
  };
  $("#importJson").onclick = () => $("#fileIn").click();
  $("#fileIn").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const o = JSON.parse(rd.result);
        const ps = Array.isArray(o) ? o : o.pieces;
        if (!Array.isArray(ps)) throw new Error("no pieces");
        state.importVariation(f.name.replace(/\.json$/i, ""), ps);
      } catch (err) { alert("Bad file"); }
    };
    rd.readAsText(f);
    e.target.value = "";   // same file can be re-imported
  };

  // ---------- selected-piece buttons ----------
  $("#rotL").onclick = () => { const p = curPiece(); if (p) setRot(p.rot - 90); };
  $("#rotR").onclick = () => { const p = curPiece(); if (p) setRot(p.rot + 90); };
  $("#rotM15").onclick = () => { const p = curPiece(); if (p) setRot(p.rot - 15); };
  $("#rotP15").onclick = () => { const p = curPiece(); if (p) setRot(p.rot + 15); };
  $("#rotSlider").oninput = (e) => setRot(+e.target.value, { commitNow: false }); // live, one undo unit…
  $("#rotSlider").onchange = () => { commit(); };   // …on release
  $("#rotNum").oninput = (e) => setRot(+e.target.value, { commitNow: false });
  $("#rotNum").onchange = () => { commit(); };
  $("#dupe").onclick = () => { const p = curPiece(); if (p) addPiece(p.name, p.w, p.d, p.color, p.x + 1, p.y + 1, p.rot); };
  $("#del").onclick = deleteSelected;
  $("#clearAll").onclick = () => {
    if (confirm("Clear all furniture from this variation?")) {
      pieces.length = 0; sel = null; renderAll(); commit(); sync3d();
    }
  };

  // deselect on empty canvas click
  canvas.addEventListener("pointerdown", (e) => { if (e.target === canvas || e.target === img) { sel = null; renderAll(); } });

  // ---------- keyboard ----------
  window.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {           // Cmd+Z / Shift+Cmd+Z
      e.preventDefault();
      if (e.shiftKey) state.redo(); else state.undo();
      updateUndoButtons(); return;
    }
    const p = curPiece();
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); if (p) addPiece(p.name, p.w, p.d, p.color, p.x + 1, p.y + 1, p.rot); return; }
    if (!p) return;
    const step = e.shiftKey ? 1 : 0.25;
    if (e.key === "r") { setRot(p.rot + (e.shiftKey ? -15 : 15)); }
    else if (e.key === "[") { setRot(p.rot - 90); }
    else if (e.key === "]") { setRot(p.rot + 90); }
    else if (e.key === "ArrowLeft") { p.x -= step; renderAll(); commit(); sync3d(); }
    else if (e.key === "ArrowRight") { p.x += step; renderAll(); commit(); sync3d(); }
    else if (e.key === "ArrowUp") { p.y -= step; renderAll(); commit(); sync3d(); }
    else if (e.key === "ArrowDown") { p.y += step; renderAll(); commit(); sync3d(); }
    else if (e.key === "Backspace" || e.key === "Delete") { deleteSelected(); }
    else return;
    e.preventDefault(); updateUndoButtons();
  });

  // ---------- boot ----------
  buildLib(); buildVarSel(); updateUndoButtons(); loadPlan(); sync3d();

  // surface for tests / index.html
  return {
    addPiece, deleteSelected, selectPiece, setSel, curPiece, exportObject,
    renderAll, refresh,
    get pieces() { return pieces; },
    get sel() { return sel; },
  };
}
