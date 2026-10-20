// A 3D "specimen case": renders one moment of a game (O players, D players, triangulation, nerve, hits).
import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function palette() {
  return {
    stage: cssVar("--stage", "#121a26"),
    ink: cssVar("--stage-ink", "#dce3ea"),
    ink2: cssVar("--stage-ink-2", "#93a0af"),
    exposed: cssVar("--o-exposed", "#cb7e16"),
    shielded: cssVar("--o-shielded", "#3c9cc6"),
    d: cssVar("--d", "#d9487a"),
    dead: cssVar("--dead", "#5b6676"),
    neutral: "#b7c1cd",
  };
}

const MAX_SEG = 2048;

class Lines {
  constructor(parent, color, opacity, dashed = false) {
    this.pos = new Float32Array(MAX_SEG * 6);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.mat = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.06, gapSize: 0.06, depthWrite: false })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    this.obj = new THREE.LineSegments(this.geo, this.mat);
    this.obj.frustumCulled = false;
    this.dashed = dashed;
    parent.add(this.obj);
  }
  set(segs, opacity) {
    const n = Math.min(segs.length, MAX_SEG);
    for (let i = 0; i < n; i++) { const [a, b] = segs[i]; this.pos.set(a, i * 6); this.pos.set(b, i * 6 + 3); }
    this.geo.setDrawRange(0, n * 2);
    this.geo.attributes.position.needsUpdate = true;
    if (this.dashed && n) this.obj.computeLineDistances();
    if (opacity !== undefined) this.mat.opacity = opacity;
    this.obj.visible = n > 0 && this.mat.opacity > 0.001;
  }
}

class Tris {
  constructor(parent, color, opacity) {
    this.pos = new Float32Array(MAX_SEG * 9);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
    this.obj = new THREE.Mesh(this.geo, this.mat);
    this.obj.frustumCulled = false;
    parent.add(this.obj);
  }
  set(tris, opacity, color) {
    const n = Math.min(tris.length, MAX_SEG);
    for (let i = 0; i < n; i++) { const [a, b, c] = tris[i]; this.pos.set(a, i * 9); this.pos.set(b, i * 9 + 3); this.pos.set(c, i * 9 + 6); }
    this.geo.setDrawRange(0, n * 3);
    this.geo.attributes.position.needsUpdate = true;
    if (opacity !== undefined) this.mat.opacity = opacity;
    if (color) this.mat.color.set(color);
    this.obj.visible = n > 0 && this.mat.opacity > 0.001;
  }
}

export class Stage {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = { autoRotate: false, playerRadius: 0.11, ...opts };
    this.C = palette();
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(this.C.stage, 1);
    r.domElement.setAttribute("role", "img");
    r.domElement.setAttribute("aria-label", this.opts.label || "3D view of the formation. Drag to turn it, scroll to zoom. The text above the view describes what it shows.");
    host.appendChild(r.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(6, -7, 4);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.autoRotate = !!this.opts.autoRotate;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.rotateSpeed = 0.7;
    this.scene.add(new THREE.HemisphereLight(0xe8eef5, 0x0b1018, 1.25));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, -3, 7);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbfd3ff, 0.45);
    fill.position.set(-5, 4, -2);
    this.scene.add(fill);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.sphereGeo = new THREE.IcosahedronGeometry(1, 3);
    this.shellGeo = new THREE.IcosahedronGeometry(1, 1);
    this.oMesh = []; this.oShell = []; this.dMesh = []; this.dHalo = []; this.dHaloBack = []; this.cMesh = [];
    this.edgesSolid = new Lines(this.root, this.C.ink, 0.55);
    this.edgesDash = new Lines(this.root, this.C.ink2, 0.35, true);
    this.edgesHot = new Lines(this.root, "#ffffff", 0.9);
    this.nerveLines = new Lines(this.root, this.C.d, 0.8);
    this.attackLines = new Lines(this.root, "#ffffff", 0.95);
    this.blockedLines = new Lines(this.root, this.C.exposed, 0.9, true);
    this.trailLines = new Lines(this.root, this.C.d, 0.5, true);
    this.coverLines = new Lines(this.root, this.C.d, 0.35);
    this.hullTris = new Tris(this.root, this.C.ink, 0.04);
    this.hotTris = new Tris(this.root, this.C.d, 0.18);
    this.grid = null;
    this.selectRing = null;

    this.visible = true;
    this.onFrame = null;
    this._last = performance.now();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(host);
    this.resize();
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => { for (const e of es) this.visible = e.isIntersecting; }, { rootMargin: "120px" }).observe(host);
    }
    const loop = (t) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (t - this._last) / 1000);
      this._last = t;
      if (!this.visible || document.hidden) return;
      if (this.onFrame) this.onFrame(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = this.host.clientWidth || 300, h = this.host.clientHeight || 300;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (this.shift) this.camera.setViewOffset(w, h, -this.shift * w, 0, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** shift the picture sideways by a fraction of the width (positive = right) */
  setShift(fx) { this.shift = fx; this.resize(); }

  setAutoRotate(on) { this.controls.autoRotate = on; }

  /** frame the camera on a set of points (keeps the current viewing direction) */
  fit(points, pad = 1.25) {
    if (!points || !points.length) return;
    const c = [0, 0, 0];
    for (const p of points) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= points.length; c[1] /= points.length; c[2] /= points.length;
    let rad = 0.5;
    for (const p of points) rad = Math.max(rad, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    rad = rad * pad + 0.3;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!isFinite(dir.x)) dir.set(0.55, -0.65, 0.5).normalize();
    const fov = (this.camera.fov * Math.PI) / 180;
    const fitH = rad / Math.sin(fov / 2);
    const fitW = fitH / Math.min(1, this.camera.aspect);
    const d = Math.max(fitH, fitW);
    this.controls.target.set(c[0], c[1], c[2]);
    this.camera.position.set(c[0] + dir.x * d, c[1] + dir.y * d, c[2] + dir.z * d);
    this.camera.near = Math.max(0.01, d / 100);
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  _ensure(list, n, make) {
    while (list.length < n) { const m = make(); this.root.add(m); list.push(m); }
    for (let i = 0; i < list.length; i++) list[i].visible = i < n;
  }

  _mat(color, opacity = 1, extra = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05, transparent: opacity < 1, opacity, ...extra });
  }

  /**
   * Draw one state. s = { O, oKind[], oScale[], D, dScale[], spheres, haloAlpha, edges [[a,b,supp]], edgeAlpha,
   * hot [[a,b]], hotTets [[a,b,c,d]], hull [[a,b,c]], nerve [[j,k]], attacks [{d,o,result,p}], trails [[from,to]],
   * cands [{pos, size, alpha, chosen}], cover [[candPos, oIndex]], select }
   */
  show(s) {
    const C = this.C, R = this.opts.playerRadius;
    const O = s.O || [];
    // O players
    this._ensure(this.oMesh, O.length, () => new THREE.Mesh(this.sphereGeo, this._mat(C.exposed)));
    this._ensure(this.oShell, O.length, () => new THREE.Mesh(this.shellGeo, new THREE.MeshBasicMaterial({ color: C.shielded, wireframe: true, transparent: true, opacity: 0.55, depthWrite: false })));
    O.forEach((p, i) => {
      const kind = (s.oKind && s.oKind[i]) || "neutral";
      const sc = s.oScale ? s.oScale[i] : 1;
      const m = this.oMesh[i];
      m.position.set(p[0], p[1], p[2]);
      const col = kind === "exposed" ? C.exposed : kind === "shielded" ? C.shielded : kind === "dead" ? C.dead : C.neutral;
      m.material.color.set(col);
      const op = kind === "dead" ? 0.28 : 1;
      m.material.opacity = op; m.material.transparent = op < 1; m.material.depthWrite = op >= 1;
      m.visible = kind !== "hidden" && sc > 0.01;
      m.scale.setScalar(R * (kind === "dead" ? 0.6 : 1) * sc);
      const sh = this.oShell[i];
      sh.visible = kind === "shielded" && m.visible;
      sh.position.copy(m.position);
      sh.scale.setScalar(R * 1.9 * sc);
      if (s.glow && s.glow[i]) { m.material.emissive.set(col); m.material.emissiveIntensity = 0.6 * s.glow[i]; }
      else m.material.emissiveIntensity = 0;
    });
    // D players and spheres of influence
    const D = s.D || [];
    const r = s.r || 1;
    this._ensure(this.dMesh, D.length, () => new THREE.Mesh(this.sphereGeo, this._mat(C.d)));
    this._ensure(this.dHalo, D.length, () => new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: C.d, transparent: true, opacity: 0.06, depthWrite: false })));
    this._ensure(this.dHaloBack, D.length, () => new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: C.d, transparent: true, opacity: 0.1, side: THREE.BackSide, depthWrite: false })));
    D.forEach((p, j) => {
      const sc = s.dScale ? s.dScale[j] : 1;
      const m = this.dMesh[j];
      m.position.set(p[0], p[1], p[2]);
      m.scale.setScalar(R * 1.18 * sc);
      m.visible = sc > 0.01;
      const ha = (s.haloAlpha ?? 1) * sc;
      const h = this.dHalo[j], hb = this.dHaloBack[j];
      h.position.copy(m.position); hb.position.copy(m.position);
      h.scale.setScalar(r * Math.max(sc, 0.001)); hb.scale.setScalar(r * Math.max(sc, 0.001));
      h.material.opacity = 0.05 * ha; hb.material.opacity = 0.07 * ha;
      h.visible = hb.visible = s.spheres !== false && ha > 0.01;
    });
    // candidate spots (placement)
    const cands = s.cands || [];
    this._ensure(this.cMesh, cands.length, () => new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: C.ink, transparent: true, opacity: 0.8, depthWrite: false })));
    cands.forEach((c, k) => {
      const m = this.cMesh[k];
      m.position.set(c.pos[0], c.pos[1], c.pos[2]);
      m.scale.setScalar(R * 0.42 * (c.size ?? 1));
      m.material.opacity = c.alpha ?? 0.8;
      m.material.color.set(c.chosen ? C.d : C.ink);
    });
    // lines
    const P = (i) => O[i];
    const edges = s.edges || [];
    const ea = s.edgeAlpha ?? 1;
    this.edgesSolid.set(edges.filter((e) => e[2] && O[e[0]] && O[e[1]]).map((e) => [P(e[0]), P(e[1])]), 0.5 * ea);
    this.edgesDash.set(edges.filter((e) => !e[2] && O[e[0]] && O[e[1]]).map((e) => [P(e[0]), P(e[1])]), 0.3 * ea);
    this.edgesHot.set((s.hot || []).map(([a, b]) => [P(a), P(b)]), s.hotAlpha ?? 0.9);
    const hotT = [];
    for (const t of s.hotTets || []) for (const f of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) hotT.push(f.map((q) => P(t[q])));
    this.hotTris.set(hotT, s.hotTetAlpha ?? 0.16);
    this.hullTris.set((s.hull || []).filter((f) => f.every((v) => O[v])).map((f) => f.map(P)), (s.hullAlpha ?? 0) * 0.07);
    this.nerveLines.set((s.nerve || []).map(([a, b]) => [D[a], D[b]]), (s.nerveAlpha ?? 1) * 0.75);
    const att = s.attacks || [];
    const seg = (h) => {
      const a = D[h.d], b = O[h.o];
      const p = Math.max(0, Math.min(1, h.p ?? 1));
      return [a, [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p, a[2] + (b[2] - a[2]) * p]];
    };
    this.attackLines.set(att.filter((h) => h.result === "eliminated" && D[h.d] && O[h.o]).map(seg), 0.95);
    this.blockedLines.set(att.filter((h) => h.result !== "eliminated" && D[h.d] && O[h.o]).map(seg), 0.9);
    this.trailLines.set(s.trails || [], 0.55);
    this.coverLines.set(s.cover || [], 0.4);
    // selection ring for the builder
    if (s.select !== undefined && s.select !== null && O[s.select]) {
      if (!this.selectRing) {
        this.selectRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 8, 40), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
        this.root.add(this.selectRing);
      }
      this.selectRing.visible = true;
      this.selectRing.position.set(...O[s.select]);
      this.selectRing.scale.setScalar(R * 1.9);
      this.selectRing.quaternion.copy(this.camera.quaternion);
    } else if (this.selectRing) this.selectRing.visible = false;
  }

  // ---------------------------------------------------------------- builder helpers
  setGrid(z, size = 8, visible = true) {
    if (!this.grid) {
      this.grid = new THREE.GridHelper(1, 16, this.C.ink2, this.C.ink2);
      this.grid.rotation.x = Math.PI / 2;
      this.grid.material.transparent = true;
      this.grid.material.opacity = 0.22;
      this.grid.material.depthWrite = false;
      this.root.add(this.grid);
    }
    this.grid.visible = visible;
    this.grid.position.z = z;
    this.grid.scale.set(size, 1, size);
  }

  _ray(ev) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(x, y), this.camera);
    return rc;
  }

  /** index of the O player under the pointer, or -1 */
  pickO(ev) {
    const rc = this._ray(ev);
    const vis = this.oMesh.filter((m) => m.visible);
    const hits = rc.intersectObjects(vis, false);
    if (!hits.length) return -1;
    return this.oMesh.indexOf(hits[0].object);
  }

  /** point where the pointer ray meets the horizontal plane at height z (null if parallel) */
  planePoint(ev, z) {
    const rc = this._ray(ev);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
    const out = new THREE.Vector3();
    const hit = rc.ray.intersectPlane(plane, out);
    return hit ? [out.x, out.y, out.z] : null;
  }
}
