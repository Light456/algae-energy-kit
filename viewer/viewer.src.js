// Algae Energy Kit 3D viewer. Source for viewer.js.
// Rebuild: npm i three esbuild, then npx esbuild viewer/viewer.src.js --bundle --minify --format=iife "--define:import.meta.url=document.baseURI" --legal-comments=eof --outfile=viewer/viewer.js
import {
  AnimationMixer, BackSide, BoxGeometry, Color, DirectionalLight,
  FrontSide, MathUtils, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, NeutralToneMapping,
  PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, ShadowMaterial, SRGBColorSpace, Vector3,
  VSMShadowMap, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const $ = (s) => document.querySelector(s);
const track = $('#track');
const stage = $('#stage');
const canvas = $('#scene');
const status = $('#status');
const hint = $('#hint');
const panels = [...document.querySelectorAll('.panel')];
const tabs = [...document.querySelectorAll('.tabs button')];
const spinBtn = $('#spin');
const base = new URL('.', document.currentScript.src);

const BG = '#e6e9e6';
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const { clamp, lerp, smoothstep } = MathUtils;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// Views, in meters, Three.js axes (Y up, front faces +Z).
// spin: keep the whole box in frame at every angle, so a full turn never clips.
const VIEWS = [
  { c: [-0.045, 0.045, 0.035], h: [0.27, 0.06, 0.13], yaw: 22, pitch: 20, spin: true },    // whole kit
  { c: [0, 0.05, 0], h: [0.10, 0.058, 0.09], yaw: 24, pitch: 30, spin: true },             // chamber, down through the lid
  { c: [0, 0.088, 0], h: [0.075, 0.03, 0.045], yaw: 18, pitch: 40 },                       // electrodes and clamps
  { c: [0.176, 0.052, 0.012], h: [0.045, 0.056, 0.04], yaw: -6, pitch: 14, spin: true },   // voltmeter
  { c: [-0.02, 0.11, 0.03], h: [0.27, 0.13, 0.13], yaw: 14, pitch: 14 },                   // exploded
];
const EXPLODE = {            // straight axes, meters
  Lid: [0, 0.13, 0], Electrode_Anode: [0, 0.075, 0], Electrode_Cathode: [0, 0.075, 0],
  Board: [0.05, 0, 0], Pump_Body: [-0.03, 0, 0],
};
const HIDE = ['Lead_Black', 'Lead_Red', 'Tube'];   // the check valve is a child of Tube and fades with it

// ------------------------------------------------------------------ fallback
function fail(message) {
  stage.classList.remove('ready');
  stage.classList.add('failed');
  status.hidden = false;
  status.textContent = message;
}

let renderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  fail('This browser cannot show the 3D model.');
}
if (renderer) start();

function start() {
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = VSMShadowMap;
  renderer.transmissionResolutionScale = 0.75;

  const scene = new Scene();
  scene.background = new Color(BG);
  const camera = new PerspectiveCamera(26, 1, 0.02, 12);
  scene.environment = studioEnvironment();
  scene.environmentIntensity = 0.95;

  const key = new DirectionalLight('#fff8ef', 1.7);
  key.position.set(-0.75, 1.25, 0.85);
  key.target.position.set(-0.04, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -0.75, right: 0.75, top: 0.75, bottom: -0.75, near: 0.2, far: 3.2 });
  key.shadow.radius = 9;
  key.shadow.blurSamples = 20;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.004;
  scene.add(key, key.target);

  const floor = new Mesh(new PlaneGeometry(8, 8), new ShadowMaterial({ opacity: 0.22, color: '#1b2a20' }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.0005;
  floor.receiveShadow = true;
  scene.add(floor);

  function studioEnvironment() {
    const room = new Scene();
    room.background = new Color('#b9bdba');
    const panel = (color, power, w, h, pos) => {
      const m = new Mesh(new BoxGeometry(w, h, 0.05), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(power) }));
      m.position.set(...pos);
      m.lookAt(0, 0, 0);
      room.add(m);
    };
    panel('#fffaf2', 9, 4, 4, [-5, 5, 4]);        // large softbox, upper left
    panel('#f2f8ff', 3, 2.5, 3, [6, 2.5, 3]);     // weak fill, right
    panel('#ffffff', 3.5, 5, 2, [0, 2.5, -6]);    // soft backlight
    panel('#ffffff', 2, 6, 6, [0, 8, 0]);
    const pmrem = new PMREMGenerator(renderer);
    const tex = pmrem.fromScene(room, 0.03).texture;
    pmrem.dispose();
    return tex;
  }

  // ------------------------------------------------------------------ model
  const draco = new DRACOLoader().setDecoderPath(new URL('draco/', base).href);
  const parts = {};
  const homes = {};
  const fading = [];
  let mixer = null;
  let ready = false;

  new GLTFLoader().setDRACOLoader(draco).load(
    new URL('../models/algae-energy-kit-v2.glb', base).href,
    (gltf) => { draco.dispose(); onModel(gltf); },
    (e) => {
      if (e.lengthComputable) status.textContent = `Loading 3D model ${Math.round((e.loaded / e.total) * 100)}%`;
    },
    () => fail(location.protocol === 'file:'
      ? 'Open this page through a local web server to load the 3D model.'
      : 'The 3D model did not load. Reload to try again.'),
  );

  function onModel(gltf) {
    const kit = gltf.scene;
    kit.traverse((o) => {
      parts[o.name] = o;
      if (!o.isMesh) return;
      const clear = /^(Lid$|Culture$|Bubble_|Tube$|CheckValve$|Pump_Cord$)/.test(o.name);
      o.castShadow = !clear;
      o.receiveShadow = !clear;
    });

    // Clear acrylic lid: alpha blended, because Three.js cannot stack transmissive surfaces and the
    // culture under it is the one transmissive material. Edges get denser with a Fresnel term.
    const lid = parts.Lid;
    const acrylic = (side) => {
      const m = lid.material.clone();
      Object.assign(m, { side, transparent: true, opacity: 0.07, depthWrite: false, roughness: 0.04, envMapIntensity: 1.5 });
      m.color.set('#dbe8df');
      m.onBeforeCompile = (s) => {
        s.fragmentShader = s.fragmentShader.replace('#include <opaque_fragment>', `
          float edge = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 3.0);
          float glint = clamp(max(max(reflectedLight.directSpecular.r, reflectedLight.indirectSpecular.r) - 0.05, 0.0), 0.0, 0.5);
          diffuseColor.a = clamp(diffuseColor.a + edge * 0.5 + glint, 0.0, 0.9);
          #include <opaque_fragment>`);
      };
      return m;
    };
    const inner = new Mesh(lid.geometry, acrylic(BackSide));     // back faces first, as a child so it lifts with the lid
    inner.name = 'Lid_Back';
    inner.renderOrder = 1;
    lid.add(inner);
    lid.material = acrylic(FrontSide);
    lid.renderOrder = 3;

    // Culture: murky, low gloss, slightly transmissive so the electrodes fade into it. Its color is a baked map.
    const baked = parts.Culture.material;
    parts.Culture.material = new MeshPhysicalMaterial({
      map: baked.map, roughness: 0.32, metalness: 0, transmission: 0.34, thickness: 0.02, ior: 1.2,
      specularIntensity: 0.35, envMapIntensity: 0.6,
    });
    parts.Culture.renderOrder = 2;

    // Alpha blended: tubing, check valve, bubbles
    const blend = (o, opacity, extra) => {
      o.material = o.material.clone();
      Object.assign(o.material, { transparent: true, opacity, depthWrite: false }, extra);
      o.material.userData.opacity = opacity;
      o.renderOrder = 4;
    };
    if (parts.Tube) blend(parts.Tube, 0.42, { roughness: 0.15 });
    if (parts.CheckValve) blend(parts.CheckValve, 0.78, { roughness: 0.2 });
    let bubble = null;
    kit.traverse((o) => {
      if (!o.isMesh || !/^Bubble_/.test(o.name)) return;
      if (!bubble) { blend(o, 0.55, { roughness: 0.05, metalness: 0.2, envMapIntensity: 1.6 }); bubble = o.material; }
      o.material = bubble;
      o.renderOrder = 2.5;
    });

    // The power cord runs out of the scene: fade its far end instead of ending it in a cut.
    const cord = parts.Pump_Cord;
    if (cord) {
      cord.material = cord.material.clone();
      cord.material.transparent = true;
      cord.material.onBeforeCompile = (s) => {
        s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCord;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCord = position;');
        s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCord;')
          .replace('#include <opaque_fragment>', 'diffuseColor.a *= 1.0 - smoothstep(0.13, 0.24, length(vCord.xz));\n#include <opaque_fragment>');
      };
    }

    for (const name of Object.keys(EXPLODE)) homes[name] = parts[name].position.clone();
    for (const name of HIDE) {
      parts[name].traverse((m) => {
        if (!m.isMesh) return;
        if (m.material.userData.opacity === undefined) { m.material = m.material.clone(); m.material.userData.opacity = 1; }
        m.material.transparent = true;
        fading.push(m);
      });
    }

    if (gltf.animations.length) {
      mixer = new AnimationMixer(kit);
      for (const clip of gltf.animations) mixer.clipAction(clip).play();
    }
    scene.add(kit);
    ready = true;
    resize();
    renderer.compile(scene, camera);
    status.hidden = true;
    stage.classList.add('ready');
    wake();
  }

  // ------------------------------------------------------------------ state
  const user = { yaw: 0, pitch: 0, zoom: 1 };      // what the visitor asked for
  const shown = { yaw: -0, pitch: 0, zoom: 1, p: 0 };   // eased toward it
  const vel = { yaw: 0, pitch: 0 };
  let dragging = false;
  let spinning = false;
  let settle = true;               // ease back to the view's own angle
  let touched = false;
  let view = 0;

  let picked = 0;                                  // view chosen with the view buttons; scrolling does not move the camera
  const scrollP = () => picked;
  const hold = (p) => Math.floor(p) + smoothstep(p - Math.floor(p), 0.22, 0.78);   // rest on each view

  // ------------------------------------------------------------------ framing
  let safe = { x: 0, y: 0, w: 1, h: 1, cx: 0, cy: 0 };
  let W = 1; let H = 1; let dpr = Math.min(devicePixelRatio || 1, 2);

  function resize() {
    if (!stage.clientWidth || !stage.clientHeight) return;     // hidden: keep the last size
    W = stage.clientWidth; H = stage.clientHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    // Keep the product clear of the text: text sits left on wide screens, on top on narrow ones.
    const wide = W >= 900;
    const left = wide ? Math.min(W * 0.33, 420) : 0;
    const top = wide ? 40 : panels.reduce((m, el) => Math.max(m, el.offsetTop + el.offsetHeight), 0) + 8;
    const bottom = H - Math.min($('.bar').offsetTop, H) + 8;
    const w = W - left - (wide ? 40 : 16);
    const h = Math.max(H - top - bottom, 160);
    safe = { w: w / W, h: h / H, cx: left + w / 2 - W / 2 + (wide ? 0 : 0), cy: top + h / 2 - H / 2 };
    camera.setViewOffset(W, H, -safe.cx, -safe.cy, W, H);
    for (const v of VIEWS) v.dist = fit(v);
    wake();
  }

  function fit(v) {
    const ty = Math.tan((camera.fov * DEG) / 2) * safe.h;
    const tx = Math.tan((camera.fov * DEG) / 2) * camera.aspect * safe.w;
    let best = 0;
    const yaws = v.spin ? Array.from({ length: 36 }, (_, i) => i * 10) : [v.yaw];
    const pitch = v.pitch * DEG;
    const pad = 1.04;
    for (const deg of yaws) {
      const a = deg * DEG;
      const f = new Vector3(Math.sin(a) * Math.cos(pitch), Math.sin(pitch), Math.cos(a) * Math.cos(pitch));
      const r = new Vector3(Math.cos(a), 0, -Math.sin(a));
      const u = new Vector3().crossVectors(f, r);
      for (let i = 0; i < 8; i++) {
        const p = new Vector3(i & 1 ? v.h[0] : -v.h[0], i & 2 ? v.h[1] : -v.h[1], i & 4 ? v.h[2] : -v.h[2]);
        best = Math.max(best, (Math.abs(p.dot(r)) * pad) / tx + p.dot(f), (Math.abs(p.dot(u)) * pad) / ty + p.dot(f));
      }
    }
    return best;
  }

  const tmpC = new Vector3();
  function pose() {
    const q = hold(shown.p);
    const i = Math.min(Math.floor(q), VIEWS.length - 2);
    const t = q - i;
    const A = VIEWS[i]; const B = VIEWS[i + 1];
    tmpC.set(...A.c).lerp(new Vector3(...B.c), t);
    const yaw = lerp(A.yaw, B.yaw, t) * DEG + shown.yaw;
    const basePitch = lerp(A.pitch, B.pitch, t) * DEG;
    const pitch = clamp(basePitch + shown.pitch, 2 * DEG, 78 * DEG);     // never below the table
    const dist = Math.exp(lerp(Math.log(A.dist), Math.log(B.dist), t)) / shown.zoom;
    camera.position.set(
      tmpC.x + Math.sin(yaw) * Math.cos(pitch) * dist,
      Math.max(tmpC.y + Math.sin(pitch) * dist, 0.012),
      tmpC.z + Math.cos(yaw) * Math.cos(pitch) * dist,
    );
    camera.lookAt(tmpC);
    camera.near = clamp(dist * 0.02, 0.005, 0.1);
    camera.updateProjectionMatrix();

    const ex = clamp(q - 3, 0, 1);
    for (const [name, d] of Object.entries(EXPLODE)) {
      const o = parts[name]; const home = homes[name];
      o.position.set(home.x + d[0] * ex, home.y + d[1] * ex, home.z + d[2] * ex);
    }
    const a = 1 - smoothstep(ex, 0.0, 0.25);
    for (const m of fading) {
      const solid = m.material.userData.opacity === 1;
      m.visible = a > 0.01; m.material.opacity = a * m.material.userData.opacity;
      m.material.depthWrite = solid && a > 0.5; m.castShadow = solid && a > 0.5;
    }
  }

  function limits() {
    const base = VIEWS[view].pitch * DEG;
    user.pitch = clamp(user.pitch, 2 * DEG - base, 78 * DEG - base);
    user.zoom = clamp(user.zoom, 0.7, 2.4);
  }

  function updateText(p) {
    const n = Math.round(p);
    if (n !== view) {
      view = n;
      setSpin(false);
      settle = true;
      vel.yaw = vel.pitch = 0;
    }
    panels.forEach((el, i) => {
      const o = 1 - smoothstep(Math.abs(p - i), 0.22, 0.48);
      el.style.opacity = o;
      el.style.visibility = o < 0.01 ? 'hidden' : 'visible';
    });
    hint.classList.toggle('gone', touched || n > 0);
    tabs.forEach((b, i) => (i === n ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
  }

  // ------------------------------------------------------------------ loop
  let last = 0;
  let raf = 0; let onScreen = true; let slow = 0; let frames = 0;

  function wake() {
    if (!raf && ready && onScreen && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }

  function tick() {
    raf = 0;
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const still = reduced.matches;
    const target = scrollP();
    updateText(target);

    if (spinning) user.yaw += dt * 0.55;
    if (!dragging && !still) {                     // momentum after a flick
      user.yaw += vel.yaw * dt;
      user.pitch += vel.pitch * dt;
      const k = Math.exp(-dt * 3.2);
      vel.yaw *= k; vel.pitch *= k;
      if (Math.abs(vel.yaw) < 0.01) vel.yaw = 0;
      if (Math.abs(vel.pitch) < 0.01) vel.pitch = 0;
    }
    if (settle && !dragging && !spinning) {
      const home = Math.round(user.yaw / TAU) * TAU;
      const k = still ? 1 : 1 - Math.exp(-dt * 3);
      user.yaw += (home - user.yaw) * k;
      user.pitch += -user.pitch * k;
      user.zoom += (1 - user.zoom) * k;
      if (Math.abs(home - user.yaw) < 1e-4 && Math.abs(user.pitch) < 1e-4 && Math.abs(user.zoom - 1) < 1e-4) {
        shown.yaw -= home; user.yaw = 0; user.pitch = 0; user.zoom = 1; settle = false;
      }
    }
    limits();

    const ease = still ? 1 : 1 - Math.exp(-dt * 14);
    shown.yaw += (user.yaw - shown.yaw) * ease;
    shown.pitch += (user.pitch - shown.pitch) * ease;
    shown.zoom += (user.zoom - shown.zoom) * ease;
    shown.p += (target - shown.p) * (still ? 1 : 1 - Math.exp(-dt * 9));
    if (Math.abs(target - shown.p) < 1e-4) shown.p = target;

    if (mixer && !still) mixer.update(dt);
    pose();
    renderer.render(scene, camera);

    // Drop resolution on slow devices.
    frames++;
    if (frames > 20) {
      slow = slow * 0.95 + (dt > 0.03 ? 1 : 0) * 0.05;
      if (slow > 0.6 && dpr > 1) { dpr = Math.max(1, dpr - 0.5); slow = 0; frames = 0; resize(); }
    }
    const moving = !still || spinning || dragging || settle;
    if (moving) raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ input
  const speed = () => Math.PI * 1.15 / Math.max(Math.min(W, 1000), 320);   // radians per pixel
  const pointers = new Map();
  let pinch = 0;

  function interact() {
    settle = false;
    if (!touched) { touched = true; hint.classList.add('gone'); }
    wake();
  }
  function setSpin(on) {
    spinning = on;
    spinBtn.setAttribute('aria-pressed', String(on));
    spinBtn.querySelector('span').textContent = on ? 'Stop' : 'Spin';
    if (on) vel.yaw = vel.pitch = 0;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
    vel.yaw = vel.pitch = 0;
    setSpin(false);
    stage.classList.add('grabbing');
    if (pointers.size === 2) pinch = spread();
    interact();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x; const dy = e.clientY - p.y;
    const dt = Math.max((e.timeStamp - p.t) / 1000, 0.001);
    Object.assign(p, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (pointers.size >= 2) {
      const s = spread();
      if (pinch > 0) user.zoom *= s / pinch;
      pinch = s;
    } else {
      const k = speed();
      user.yaw -= dx * k;
      vel.yaw = lerp(vel.yaw, (-dx * k) / dt, 0.45);
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {     // vertical swipes belong to page scroll
        user.pitch += dy * k * 0.7;
        vel.pitch = lerp(vel.pitch, (dy * k * 0.7) / dt, 0.45);
      }
      p.moved = e.timeStamp;
    }
    limits();
    interact();
  });
  const release = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    pinch = 0;
    if (pointers.size) return;
    dragging = false;
    stage.classList.remove('grabbing');
    if (reduced.matches || e.type === 'pointercancel' || e.timeStamp - (p.moved || 0) > 80) vel.yaw = vel.pitch = 0;
    vel.yaw = clamp(vel.yaw, -9, 9);
    vel.pitch = clamp(vel.pitch, -3, 3);
    wake();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dragstart', (e) => e.preventDefault());
  canvas.addEventListener('dblclick', reset);
  const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };

  // Trackpad pinch arrives as ctrl+wheel. A plain wheel always scrolls the page.
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    user.zoom *= Math.exp(-e.deltaY * 0.01);
    limits(); interact();
  }, { passive: false });

  function zoom(f) { user.zoom *= f; limits(); interact(); }
  function turn(dYaw, dPitch) { setSpin(false); vel.yaw = vel.pitch = 0; user.yaw += dYaw; user.pitch += dPitch; limits(); interact(); }
  function reset() { setSpin(false); vel.yaw = vel.pitch = 0; settle = true; wake(); }

  $('#in').addEventListener('click', () => zoom(1.25));
  $('#out').addEventListener('click', () => zoom(0.8));
  $('#reset').addEventListener('click', reset);
  spinBtn.addEventListener('click', () => { const on = !spinning; interact(); setSpin(on); wake(); });
  tabs.forEach((b, i) => b.addEventListener('click', () => {
    picked = i;
    wake();
  }));

  addEventListener('keydown', (e) => {
    if (!onScreen || track.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    const step = 15 * DEG;
    const focused = document.activeElement === canvas;
    if (e.key === 'ArrowLeft') turn(-step, 0);
    else if (e.key === 'ArrowRight') turn(step, 0);
    else if (e.key === 'ArrowUp' && focused) turn(0, step / 2);      // up and down scroll the page otherwise
    else if (e.key === 'ArrowDown' && focused) turn(0, -step / 2);
    else if (e.key === '+' || e.key === '=') zoom(1.2);
    else if (e.key === '-' || e.key === '_') zoom(1 / 1.2);
    else return;
    e.preventDefault();
  });

  new ResizeObserver(resize).observe(stage);
  document.addEventListener('visibilitychange', wake);
  reduced.addEventListener('change', wake);
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake(); if (!onScreen && raf) { cancelAnimationFrame(raf); raf = 0; } }).observe(stage);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; ready = false; fail('The 3D view stopped. Reload to try again.'); });

  updateText(scrollP());

  window.algaeViewer = {       // read-only, for tests
    get state() {
      return { ready, view, p: shown.p, yaw: shown.yaw, pitch: shown.pitch, zoom: shown.zoom, velYaw: vel.yaw, spinning,
        camY: camera.position.y, time: mixer ? mixer.time : 0, dpr, calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
        lid: parts.Lid ? parts.Lid.position.y - homes.Lid.y : 0, leads: parts.Lead_Red ? parts.Lead_Red.visible : null };
    },
  };
}
