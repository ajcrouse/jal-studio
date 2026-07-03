/**
 * viewer3d.js — the three.js pane of the unified JAL studio (Phase 2).
 *
 * Loads the scan environment once + one GLB per furniture item from
 * app/assets/manifest.json, then positions instances from layout state via
 * mapping.js. update(state) reconciles by piece id — add / remove / move
 * without reloading models. All GLBs are Draco-compressed (Phase 1) so the
 * GLTFLoader gets a DRACOLoader with the CDN decoder.
 *
 * The env asset deliberately has NO backdrop: this module adds a big cheap
 * water plane + sky gradient outside the W glazing.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { mapPiece, DEFAULT_PLAN, FT } from "./mapping.js";

const DRACO_DECODER_PATH =
  "https://cdn.jsdelivr.net/npm/three@0.164.1/examples/jsm/libs/draco/gltf/";

export class Viewer3D {
  /**
   * @param {HTMLElement} container
   * @param {{manifest: object, assetsBase?: string, plan?: object}} opts
   *   manifest = parsed app/assets/manifest.json (required)
   */
  constructor(container, { manifest, assetsBase = "./assets/", plan } = {}) {
    this.container = container;
    this.manifest = manifest;
    this.assetsBase = assetsBase;
    this.plan = plan ?? { ...DEFAULT_PLAN, interiorD: manifest.env.interior_d };
    this.warnings = [];
    this.onWarning = null;            // (msg) => void — quiet UI hook
    this.onWalkChange = null;         // (walking: bool) => void — button label hook
    this._walk = null;                // active walk-mode state (stretch goal)
    this._clock = new THREE.Clock();
    this._instances = new Map();      // piece id -> {name, group}
    this._modelCache = new Map();     // item name -> Promise<THREE.Group template>

    const W = manifest.env.interior_w * FT;
    const D = manifest.env.interior_d * FT;
    this._center = new THREE.Vector3(W / 2, 0.6, -D / 2);

    // renderer / scene / camera
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 4000);
    this.camera.position.set(W / 2, 14, -D / 2 + 16); // dollhouse start, SE-ish
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this._center);
    this.controls.maxDistance = 60;
    this.controls.update();

    // loaders (shared DRACO decoder)
    const draco = new DRACOLoader().setDecoderPath(DRACO_DECODER_PATH);
    this.loader = new GLTFLoader().setDRACOLoader(draco);

    this._lights();
    this._backdrop(W, D);
    this._resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", this._resize);
    this._resize();

    this.renderer.setAnimationLoop(() => {
      const dt = this._clock.getDelta();
      if (this._walk?.locked) this._walkMove(dt);
      else this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // ---- walk mode (stretch goal — strictly additive; orbit is the default) ----

  /** Toggle pointer-lock first-person mode. Esc (pointer-lock unlock) exits. */
  toggleWalk() { this._walk ? this._exitWalk() : this._enterWalk(); }
  get walking() { return !!this._walk; }

  _enterWalk() {
    if (this._walk) return;
    const saved = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    const plc = new PointerLockControls(this.camera, this.renderer.domElement);
    const keys = new Set();
    const KEYMAP = { KeyW: "f", ArrowUp: "f", KeyS: "b", ArrowDown: "b",
                     KeyA: "l", ArrowLeft: "l", KeyD: "r", ArrowRight: "r" };
    // capture phase + stopPropagation so the editor's key handler (arrow nudge,
    // delete…) never fires while walking
    const onKeyDown = (e) => {
      const k = KEYMAP[e.code];
      if (k) { keys.add(k); e.preventDefault(); e.stopPropagation(); }
    };
    const onKeyUp = (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); };
    const walk = { plc, saved, keys, onKeyDown, onKeyUp, locked: false };
    this._walk = walk;

    plc.addEventListener("lock", () => {
      walk.locked = true;
      this.controls.enabled = false;
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("keyup", onKeyUp, true);
      // eye height at the orbit target's plan position
      this.camera.position.set(this.controls.target.x, 5.2 * FT, this.controls.target.z);
      if (this.onWalkChange) this.onWalkChange(true);
    });
    plc.addEventListener("unlock", () => this._exitWalk());   // Esc exits
    // request pointer lock ourselves (plc.lock()'s promise is unhandled on refusal)
    try {
      const req = this.renderer.domElement.requestPointerLock();
      if (req && typeof req.catch === "function")
        req.catch(() => { if (this._walk === walk) this._exitWalk(); });
    } catch (e) { this._exitWalk(); return; }
    // belt-and-braces: lock never engaged? revert quietly to orbit
    setTimeout(() => { if (this._walk === walk && !walk.locked) this._exitWalk(); }, 1200);
  }

  _exitWalk() {
    const w = this._walk;
    if (!w) return;
    this._walk = null;
    document.removeEventListener("keydown", w.onKeyDown, true);
    document.removeEventListener("keyup", w.onKeyUp, true);
    if (w.plc.isLocked) w.plc.unlock();
    w.plc.disconnect();
    this.camera.position.copy(w.saved.pos);
    this.controls.target.copy(w.saved.target);
    this.controls.enabled = true;
    this.controls.update();
    if (this.onWalkChange) this.onWalkChange(false);
  }

  _walkMove(dt) {
    const w = this._walk;
    const step = 6 * FT * Math.min(dt, 0.1);   // 6 ft/s, frame-rate independent
    if (w.keys.has("f")) w.plc.moveForward(step);
    if (w.keys.has("b")) w.plc.moveForward(-step);
    if (w.keys.has("l")) w.plc.moveRight(-step);
    if (w.keys.has("r")) w.plc.moveRight(step);
    this.camera.position.y = 5.2 * FT;   // stay at eye height
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xdfeaf4, 0x8a8175, 1.15));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2); // in through the W glazing
    sun.position.set(-30, 40, -this._center.z * 2 + 6);
    this.scene.add(sun);
    const fill = new THREE.PointLight(0xfff1dd, 30, 0, 1.8); // under the deck
    fill.position.copy(this._center).setY(2.6);
    this.scene.add(fill);
  }

  /** Big cheap water plane + sky gradient outside the W glazing (env has none). */
  _backdrop(W, D) {
    // sky: gradient on a huge inward-facing sphere
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1500, 24, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(0x77aede) },
          horizon: { value: new THREE.Color(0xe8f0f2) },
        },
        vertexShader: `varying vec3 vP;
          void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vP;
          void main(){ float t = clamp(normalize(vP).y*1.6, 0.0, 1.0);
            gl_FragColor = vec4(mix(horizon, top, t), 1.0); }`,
      })
    );
    sky.position.copy(this._center).setY(0);
    this.scene.add(sky);

    // water: glossy plane ~80 ft (8th floor) below, stretching to the horizon
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 2600),
      new THREE.MeshStandardMaterial({ color: 0x2e5d78, roughness: 0.18, metalness: 0.55 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(this._center.x, -80 * FT, this._center.z);
    this.scene.add(water);
  }

  _warn(msg) {
    this.warnings.push(msg);
    console.warn("[viewer3d]", msg);
    if (this.onWarning) this.onWarning(msg);
  }

  /** Load scan_room.glb once. Resolves when the env is in the scene. */
  async loadEnv() {
    const file = this.assetsBase + this.manifest.env.file;
    try {
      const gltf = await this.loader.loadAsync(file);
      this.scene.add(gltf.scene); // baked into world frame; identity transform
    } catch (e) {
      this._warn(`environment ${this.manifest.env.file} failed to load (${e.message ?? e})`);
    }
  }

  /** One cached template per item name; clones are cheap per instance. */
  _model(name) {
    if (!this._modelCache.has(name)) {
      const meta = this.manifest.items[name];
      const p = meta
        ? this.loader.loadAsync(this.assetsBase + meta.file).then((g) => g.scene)
        : Promise.reject(new Error("not in manifest"));
      this._modelCache.set(
        name,
        p.catch((e) => {
          this._warn(`asset for "${name}" missing — showing a box (${e.message ?? e})`);
          return this._fallbackBox(name);
        })
      );
    }
    return this._modelCache.get(name);
  }

  _fallbackBox(name) {
    const m = this.manifest.items[name] ?? { w: 2, d: 2, h: 2, color: "#c0c0c0" };
    const geo = new THREE.BoxGeometry(m.w * FT, m.h * FT, m.d * FT);
    geo.translate(0, (m.h * FT) / 2, 0); // origin bottom-center, like real assets
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: new THREE.Color(m.color ?? "#c0c0c0"), roughness: 0.8 })
    );
    const g = new THREE.Group();
    g.add(mesh);
    return g;
  }

  /**
   * Reconcile the 3D scene with layout state: {pieces: [{id,name,x,y,w,d,rot}]}.
   * Adds/removes/moves instances without reloading models.
   */
  update(state) {
    const seen = new Set();
    for (const pc of state.pieces ?? []) {
      const id = pc.id ?? `${pc.name}@${pc.x},${pc.y}`;
      seen.add(id);
      let inst = this._instances.get(id);
      if (inst && inst.name !== pc.name) { // piece swapped type: rebuild
        this.scene.remove(inst.group);
        this._instances.delete(id);
        inst = null;
      }
      if (!inst) {
        inst = { name: pc.name, group: new THREE.Group() };
        this._instances.set(id, inst);
        this.scene.add(inst.group);
        this._model(pc.name).then((tpl) => {
          if (this._instances.get(id) === inst) inst.group.add(tpl.clone(true));
        });
      }
      const meta = this.manifest.items[pc.name] ?? {};
      const t = mapPiece(pc, meta, this.plan);
      inst.group.position.fromArray(t.position);
      inst.group.rotation.set(0, t.rotationY, 0);
    }
    for (const [id, inst] of this._instances) {
      if (!seen.has(id)) {
        this.scene.remove(inst.group);
        this._instances.delete(id);
      }
    }
  }

  /** Resolves when every model requested so far has loaded (or fallen back). */
  whenLoaded() {
    return Promise.all(this._modelCache.values());
  }

  /** Straight-down plan view (used by the visual golden check). */
  topView() {
    this.camera.position.set(this._center.x, 15, this._center.z + 0.01);
    this.controls.target.copy(this._center).setY(0);
    this.controls.update();
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this._resize);
    this.renderer.dispose();
  }
}
