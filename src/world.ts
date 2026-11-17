import gsap from "gsap";
import * as THREE from "three";

// The 3D background. Loaded on demand by main.ts so the text can appear
// before three.js has downloaded.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MIN_CAMERA_Z = 50;
const DEFAULT_CAMERA_Z = 150; // where the page opens; MIN still lets you zoom in
const MAX_CAMERA_Z = 300;
const ZOOM_SPEED = 0.1;
const ZOOM_SMOOTHING = 0.12;
const PARALLAX = { x: 0.05, y: 0.035 }; // max camera tilt (radians)

const isSmallScreen = matchMedia("(pointer: coarse), (max-width: 700px)").matches;

const PLANE_SIZE = 1400;
// Fewer, larger facets on phones: the detail barely shows there and saves CPU.
const PLANE_SEGMENTS = isSmallScreen ? 90 : 130;
/** The surface leans back towards a horizon instead of facing the camera. */
const PLANE_TILT = -1.05; // radians around X
const PLANE_OFFSET_Y = -40;
const DRIFT_SPEED = 0.6; // radians per second
const DRIFT_AMPLITUDE = 0.6;

/** Slow, layered swells that make the surface roll like a dark sea. */
const SWELL_SPEED = 0.35;
const SWELL_HEIGHT = 4;

/** Static relief under the swells: rolling hills and sharp ridges. */
const TERRAIN_HEIGHT = 1;

/** The exit: a warp jump towards the horizon. */
const WARP_STREAKS = isSmallScreen ? 220 : 420;
const WARP_DEPTH = 1400;
const LAUNCH_DISTANCE = 620; // how far the camera travels across the surface
const LAUNCH_FLASH = "#eef0ff"; // the warp ends in light, matching the portfolio

/** Distance fog: the far surface melts into a faint horizon glow. */
const BACKGROUND = 0x02040f;
const HORIZON = 0x0b1640;
const FOG_NEAR = 200;
const FOG_FAR = 680;

/** The glowing brush that follows the pointer. */
const BRUSH_RADIUS = 24;
const BRUSH_LIFT = 5;
const TRAIL_FADE = 0.75; // seconds for the trail to lose ~63% of its glow

/** Shockwaves sent across the surface on click / tap. */
const RIPPLE_SPEED = 110; // units per second
const RIPPLE_REACH = 420;
const RIPPLE_WIDTH = 9;
const RIPPLE_HEIGHT = 6;
const MAX_RIPPLES = 8;
const AMBIENT_RIPPLE_EVERY: [number, number] = [4, 8]; // seconds, min/max

const STAR_COUNT = isSmallScreen ? 900 : 1600;
/** Share of the stars gathered into a faint Milky-Way-like band. */
const STAR_BAND_SHARE = 0.45;

type RGB = readonly [number, number, number];
// Linear-space colours (three converts them to sRGB on output).
// Surface albedo, lit by the scene lights: troughs dark, crests a little lighter.
const TROUGH: RGB = [0.02, 0.035, 0.11];
const CREST: RGB = [0.06, 0.11, 0.32];
// Self-lit glow, added on top of the lighting so it shines even in shadow.
const TRAIL_HOT: RGB = [0.1, 0.45, 1.0]; // fresh: electric blue
const TRAIL_MID: RGB = [0.38, 0.1, 0.85]; // cooling: violet
const TRAIL_COLD: RGB = [0.55, 0.03, 0.08]; // dying: ember red
const RIPPLE_GLOW: RGB = [0.32, 0.05, 0.1];
const LAUNCH_GLOW: RGB = [0.08, 0.3, 0.75]; // the exit's pulse matches the warp

const prefersReducedMotion = matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

// ---------------------------------------------------------------------------
// Scene objects
// ---------------------------------------------------------------------------

interface Ripple {
  x: number;
  y: number;
  /** Seconds since the ripple started. */
  age: number;
  strength: number;
  color: RGB;
}

interface Surface {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  rest: Float32Array;
  phases: Float32Array;
  /** Per-vertex glow left behind by the pointer, 0..1. */
  heat: Float32Array;
}

/**
 * Height of the static landscape at (x, y) in surface space. Deterministic, so
 * the pointer hit-test can follow the same hills the surface is built from.
 */
function terrainHeight(x: number, y: number) {
  // Broad, slow hills.
  let h = Math.sin(x * 0.0055 + 1.3) * Math.cos(y * 0.0048 - 0.7) * 16;
  // Two crossing sets of ridges: |sin| folded upside down gives sharp crests
  // and wide valleys, which catch the light much better than plain waves.
  h += (1 - Math.abs(Math.sin(x * 0.011 + y * 0.0068))) * 20 - 10;
  h += (1 - Math.abs(Math.sin(-x * 0.0085 + y * 0.015 + 2.1))) * 13 - 6.5;
  // A little finer detail.
  h += Math.sin(x * 0.029 + y * 0.021) * 3;
  return h * TERRAIN_HEIGHT;
}

function createSurface(): Surface {
  const geometry = new THREE.PlaneGeometry(
    PLANE_SIZE,
    PLANE_SIZE,
    PLANE_SEGMENTS,
    PLANE_SEGMENTS,
  );
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const positions = position.array as Float32Array;
  const phases = new Float32Array(position.count * 2);
  const cell = PLANE_SIZE / PLANE_SEGMENTS;

  // Jitter every vertex to get the low-poly, crumpled look. Kept in proportion
  // to the facet size so the facets read as shapes rather than noise.
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += (Math.random() - 0.5) * cell * 0.45;
    positions[i + 1] += (Math.random() - 0.5) * cell * 0.45;
    positions[i + 2] +=
      terrainHeight(positions[i], positions[i + 1]) +
      (Math.random() - 0.5) * cell * 0.4;
  }
  for (let i = 0; i < phases.length; i++) {
    phases[i] = (Math.random() - 0.5) * 15;
  }

  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(position.count * 3), 3),
  );
  geometry.setAttribute(
    "glow",
    new THREE.BufferAttribute(new Float32Array(position.count * 3), 3),
  );
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide,
    flatShading: true,
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.35,
  });
  // Feed the per-vertex `glow` attribute into the emissive term, so the trail
  // and shockwaves shine on their own instead of only tinting lit facets.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec3 glow;\nvarying vec3 vGlow;",
      )
      .replace("#include <color_vertex>", "#include <color_vertex>\nvGlow = glow;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGlow;")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;",
      );
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = PLANE_TILT;
  mesh.position.y = PLANE_OFFSET_Y;

  return {
    mesh,
    // A real copy, so the motion oscillates around the rest pose instead of drifting.
    rest: positions.slice(),
    phases,
    heat: new Float32Array(position.count),
  };
}

/** A backdrop dome: horizon haze fading up into the night sky, so the fogged
 *  edge of the surface blends in instead of ending in a hard band. */
function createSky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uHorizon: { value: new THREE.Color(HORIZON) },
      uZenith: { value: new THREE.Color(BACKGROUND) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      varying vec3 vDir;
      void main() {
        // The surface's far edge sits roughly 20 degrees above eye level.
        float t = smoothstep(0.3, 0.62, vDir.y);
        gl_FragColor = vec4(mix(uHorizon, uZenith, t), 1.0);
        #include <encodings_fragment>
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), material);
  sky.renderOrder = -1;
  return sky;
}

const STAR_VERTEX = /* glsl */ `
  attribute float size;
  attribute vec3 tint;
  attribute float phase;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vTint;
  varying float vTwinkle;

  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Two detuned sines give an irregular, non-synchronised twinkle.
    float t = sin(uTime * (0.7 + fract(phase) * 1.6) + phase * 6.2831)
            * sin(uTime * 0.37 + phase * 3.1);
    vTwinkle = 0.72 + 0.28 * t;
    vTint = tint;
    gl_PointSize = size * uPixelRatio;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  varying vec3 vTint;
  varying float vTwinkle;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    if (d > 1.0) discard;
    // A sharp core inside a soft halo, instead of a hard-edged disc.
    float core = exp(-d * d * 18.0);
    float halo = exp(-d * d * 4.0) * 0.35;
    float alpha = (core + halo) * vTwinkle * (1.0 - d);
    gl_FragColor = vec4(vTint * (0.6 + core), alpha);
  }
`;

/** Star colours, from cool blue-white through white to warm. */
const STAR_TINTS: RGB[] = [
  [0.72, 0.82, 1.0],
  [0.85, 0.9, 1.0],
  [1.0, 1.0, 1.0],
  [1.0, 0.93, 0.82],
  [1.0, 0.8, 0.7],
];

function createStarfield(): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const positions = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const tints = new Float32Array(STAR_COUNT * 3);
  const phases = new Float32Array(STAR_COUNT);

  // A tilted great circle for the band of denser, smaller stars.
  const bandNormal = new THREE.Vector3(0.35, 0.25, 1).normalize();
  const bandU = new THREE.Vector3(1, 0, 0).cross(bandNormal).normalize();
  const bandV = bandNormal.clone().cross(bandU);
  const dir = new THREE.Vector3();

  for (let i = 0; i < STAR_COUNT; i++) {
    const inBand = Math.random() < STAR_BAND_SHARE;
    if (inBand) {
      const angle = Math.random() * Math.PI * 2;
      const spread = (Math.random() + Math.random() + Math.random() - 1.5) * 0.18;
      dir
        .copy(bandU)
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(bandV, Math.sin(angle))
        .addScaledVector(bandNormal, spread)
        .normalize();
    } else {
      dir.randomDirection();
    }
    // Most of the sky below the horizon is hidden by the surface anyway.
    if (dir.y < -0.3) dir.y = -dir.y;

    const radius = 700 + Math.random() * 300;
    positions[i * 3] = dir.x * radius;
    positions[i * 3 + 1] = dir.y * radius;
    positions[i * 3 + 2] = dir.z * radius;

    // Many faint stars and a few bright ones, like a real sky.
    const brightness = Math.pow(Math.random(), inBand ? 5 : 3.5);
    sizes[i] = (inBand ? 2.5 : 3) + brightness * 10;

    const tint = STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)];
    const dim = inBand ? 0.55 + Math.random() * 0.3 : 0.75 + Math.random() * 0.25;
    tints[i * 3] = tint[0] * dim;
    tints[i * 3 + 1] = tint[1] * dim;
    tints[i * 3 + 2] = tint[2] * dim;

    phases[i] = Math.random() * 10;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("tint", new THREE.BufferAttribute(tints, 3));
  geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Points(geometry, material);
}

/** Trail colour for a given heat: blue when fresh, violet, then ember red. */
function trailColor(h: number, out: number[]) {
  const [a, b, t] =
    h > 0.5 ? [TRAIL_MID, TRAIL_HOT, (h - 0.5) * 2] : [TRAIL_COLD, TRAIL_MID, h * 2];
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

const randomBetween = (min: number, max: number) =>
  min + Math.random() * (max - min);

/**
 * Streaks for the warp jump, in camera space: a tunnel of lines around the
 * view axis. Each has a bright head and a tail that fades to nothing.
 */
function createWarp() {
  const streaks = new Float32Array(WARP_STREAKS * 3);
  const positions = new Float32Array(WARP_STREAKS * 6);
  const colors = new Float32Array(WARP_STREAKS * 6);

  for (let i = 0; i < WARP_STREAKS; i++) {
    streaks[i * 3] = Math.random() * Math.PI * 2;
    // Keep the very centre clear, so the eye has somewhere to go.
    streaks[i * 3 + 1] = 25 + Math.pow(Math.random(), 0.7) * 260;
    streaks[i * 3 + 2] = -20 - Math.random() * WARP_DEPTH;

    const tint = STAR_TINTS[Math.floor(Math.random() * 3)]; // the cool ones
    const strength = 0.4 + Math.random() * 0.6;
    colors[i * 6] = tint[0] * strength;
    colors[i * 6 + 1] = tint[1] * strength;
    colors[i * 6 + 2] = tint[2] * strength;
    // tail stays black: invisible under additive blending
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  lines.visible = false;
  lines.frustumCulled = false;
  return { lines, streaks };
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export class World {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly raycaster = new THREE.Raycaster();
  /** The surface's rest plane in world space (set once the surface is tilted).
   *  Cheap to hit-test, and close enough to the real surface (it only moves a
   *  few units) to place the brush. */
  private readonly restPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly liftedPlane = new THREE.Plane();
  private readonly hitPoint = new THREE.Vector3();
  private readonly overlay: HTMLElement;
  private readonly clock = new THREE.Clock();
  private readonly pointer = new THREE.Vector2();
  private readonly surface: Surface;
  private readonly stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly cursorLight: THREE.PointLight;
  private readonly roamingLight: THREE.PointLight;
  private readonly ripples: Ripple[] = [];
  private readonly warp: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly warpStreaks: Float32Array; // per streak: angle, radius, z
  /** Exit animation state, driven by gsap: streak visibility and speed. */
  private readonly launch = { warp: 0, speed: 0 };

  /** Smoothed brush position on the plane, and how "on" it is (0..1). */
  private readonly brush = new THREE.Vector2();
  private brushStrength = 0;
  private hasBrushTarget = false;

  private hasPointer = false;
  private targetZ = DEFAULT_CAMERA_Z;
  private isLeaving = false;
  private nextAmbientRipple = randomBetween(...AMBIENT_RIPPLE_EVERY);

  private readonly scratch = [0, 0, 0];

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement) {
    this.overlay = overlay;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setClearColor(BACKGROUND);
    this.scene.add(createSky());

    this.scene.fog = new THREE.Fog(HORIZON, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(
      75,
      innerWidth / innerHeight,
      0.1,
      2000,
    );
    this.camera.position.z = DEFAULT_CAMERA_Z;
    this.scene.add(this.camera);

    // Cool moonlight from beyond the horizon rims the wave crests…
    // It sits low, almost skimming the surface, so every slope facing it lights
    // up and every slope facing away falls into shadow: that is what makes
    // the relief read.
    const moon = new THREE.DirectionalLight(0xa6bfff, 2.1);
    moon.position.set(-0.75, 0.62, -0.9);
    // …a soft fill from the viewer keeps the near facets readable…
    const fill = new THREE.DirectionalLight(0x5a6fb0, 0.35);
    fill.position.set(0.6, -0.2, 1);
    // …and a sky/ground ambient so shadows are deep navy, not black.
    const ambient = new THREE.HemisphereLight(0x2a3f8a, 0x05060f, 0.45);

    this.surface = createSurface();
    const { mesh } = this.surface;

    // The pointer lights live in the surface's own space, so "z" means
    // "above the surface" whatever its tilt.
    // A blue glow that rides just above the pointer…
    this.cursorLight = new THREE.PointLight(0x4d8dff, 0, 110, 2);
    this.cursorLight.position.z = 26;
    // …and a dim red one that wanders, so the surface is alive even untouched.
    this.roamingLight = new THREE.PointLight(0xd54545, 0.6, 170, 2);
    this.roamingLight.position.z = 30;
    mesh.add(this.cursorLight, this.roamingLight);

    mesh.updateMatrixWorld();
    this.restPlane.applyMatrix4(mesh.matrixWorld);

    this.stars = createStarfield();
    this.scene.add(moon, fill, ambient, mesh, this.stars);

    ({ lines: this.warp, streaks: this.warpStreaks } = createWarp());
    this.camera.add(this.warp);

    this.bindEvents();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** Sends a shockwave across the surface from (x, y) in plane space. */
  ripple(x = 0, y = 0, strength = 1, color: RGB = RIPPLE_GLOW) {
    if (this.ripples.length >= MAX_RIPPLES) this.ripples.shift();
    this.ripples.push({ x, y, age: 0, strength, color });
  }

  /**
   * The exit: the surface gathers itself, then the camera launches low across
   * it towards the horizon, stars stretch into warp streaks, and everything
   * dissolves into light. Calls `onDone` at the end.
   */
  flyAway(onDone: () => void) {
    this.isLeaving = true;
    this.hasPointer = false;

    const { position, rotation } = this.camera;
    // Directions in world space: along the surface towards the horizon, and
    // straight out of it. Moving along them keeps the flight parallel to the
    // tilted surface instead of ploughing into it.
    const ahead = new THREE.Vector3(0, Math.cos(PLANE_TILT), Math.sin(PLANE_TILT));
    const up = new THREE.Vector3(0, -Math.sin(PLANE_TILT), Math.cos(PLANE_TILT));
    const crouch = position.clone().addScaledVector(ahead, -25).addScaledVector(up, -15);
    const end = crouch.clone().addScaledVector(ahead, LAUNCH_DISTANCE);
    // Look along the surface, at the horizon, for the run.
    const pitch = Math.atan2(ahead.y, -ahead.z) - 0.08;

    // A strong pulse from the middle of the view: the "charge".
    const centre = this.planePointAt(new THREE.Vector2(0, 0));
    this.ripple(centre?.x ?? 0, centre?.y ?? 0, 1.5, LAUNCH_GLOW);

    gsap
      .timeline({ onComplete: onDone })
      // 1. Charge: ease back and down, narrow the view, turn to the horizon.
      .to(position, { y: crouch.y, z: crouch.z, duration: 0.6, ease: "power2.out" }, 0)
      .to(rotation, { x: pitch, y: 0, z: 0, duration: 0.9, ease: "power2.inOut" }, 0)
      .to(this.camera, { fov: 62, duration: 0.6, ease: "power2.out" }, 0)
      // 2. Launch: accelerate across the surface, view stretches wide,
      //    stars streak past.
      .to(position, { y: end.y, z: end.z, duration: 1.6, ease: "expo.in" }, 0.6)
      .to(this.camera, { fov: 115, duration: 1.6, ease: "expo.in" }, 0.6)
      .to(this.launch, { warp: 1, duration: 0.9, ease: "power2.in" }, 0.75)
      .to(this.launch, { speed: 1, duration: 1.45, ease: "expo.in" }, 0.75)
      // 3. Dissolve into light.
      .set(this.overlay, { backgroundColor: LAUNCH_FLASH }, 1.75)
      .to(this.overlay, { opacity: 1, duration: 0.5, ease: "power2.in" }, 1.75)
      .to({}, { duration: 0.15 });
  }

  /** Puts the camera back (e.g. when the page is restored from bfcache). */
  reset() {
    gsap.killTweensOf([
      this.camera,
      this.camera.position,
      this.camera.rotation,
      this.launch,
    ]);
    this.camera.position.set(0, 0, DEFAULT_CAMERA_Z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();
    this.launch.warp = 0;
    this.launch.speed = 0;
    this.warp.visible = false;
    gsap.set(this.overlay, { backgroundColor: "#000" });
    this.targetZ = DEFAULT_CAMERA_Z;
    this.isLeaving = false;
    this.ripples.length = 0;
  }

  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const time = prefersReducedMotion ? 0 : this.clock.elapsedTime;

    if (!this.isLeaving) {
      // Ease towards the zoom target for smooth scrolling.
      this.camera.position.z +=
        (this.targetZ - this.camera.position.z) * ZOOM_SMOOTHING;

      // Gentle parallax: the camera leans towards the pointer.
      if (!prefersReducedMotion) {
        const rx = this.hasPointer ? this.pointer.y * PARALLAX.y : 0;
        const ry = this.hasPointer ? -this.pointer.x * PARALLAX.x : 0;
        this.camera.rotation.x += (rx - this.camera.rotation.x) * 0.04;
        this.camera.rotation.y += (ry - this.camera.rotation.y) * 0.04;
      }

      this.maybeAmbientRipple(dt);
    }

    if (this.isLeaving) {
      this.camera.updateProjectionMatrix(); // fov is being tweened
      this.updateWarp(dt);
    }

    this.updateBrush();
    this.updateRipples(dt);
    this.updateSurface(time, dt);

    this.roamingLight.position.x = Math.sin(time * 0.23) * 160;
    this.roamingLight.position.y = 60 + Math.cos(time * 0.31) * 90;
    this.stars.rotation.y = time * 0.006;
    this.stars.material.uniforms.uTime.value = time;

    this.renderer.render(this.scene, this.camera);
  }

  /** Rushes the warp streaks towards the camera, longer as speed builds. */
  private updateWarp(dt: number) {
    const { warp, speed } = this.launch;
    this.warp.visible = warp > 0.01;
    if (!this.warp.visible) return;
    this.warp.material.opacity = warp;

    const position = this.warp.geometry.attributes.position as THREE.BufferAttribute;
    const p = position.array as Float32Array;
    const streaks = this.warpStreaks;
    const velocity = 120 + speed * 2600; // units per second
    const length = 6 + speed * 260;

    for (let s = 0, i = 0; s < streaks.length; s += 3, i += 6) {
      let z = streaks[s + 2] + velocity * dt;
      if (z > -20) z -= WARP_DEPTH; // passed the camera: back to the far end
      streaks[s + 2] = z;
      const x = Math.cos(streaks[s]) * streaks[s + 1];
      const y = Math.sin(streaks[s]) * streaks[s + 1];
      p[i] = x;
      p[i + 1] = y;
      p[i + 2] = z;
      p[i + 3] = x;
      p[i + 4] = y;
      p[i + 5] = z - length;
    }
    position.needsUpdate = true;
  }

  private updateBrush() {
    this.hasBrushTarget = false;

    const hit = this.hasPointer && this.planePointAt(this.pointer);
    if (hit) {
      // Snap on first contact so the glow doesn't slide in from far away.
      if (this.brushStrength < 0.05) this.brush.set(hit.x, hit.y);
      this.brush.x += (hit.x - this.brush.x) * 0.35;
      this.brush.y += (hit.y - this.brush.y) * 0.35;
      this.hasBrushTarget = true;
    }

    const target = this.hasBrushTarget ? 1 : 0;
    this.brushStrength += (target - this.brushStrength) * 0.1;

    this.cursorLight.position.x = this.brush.x;
    this.cursorLight.position.y = this.brush.y;
    this.cursorLight.intensity = this.brushStrength * 1.2;
  }

  private updateRipples(dt: number) {
    for (const ripple of this.ripples) ripple.age += dt;
    while (
      this.ripples.length &&
      this.ripples[0].age * RIPPLE_SPEED > RIPPLE_REACH
    ) {
      this.ripples.shift();
    }
  }

  private maybeAmbientRipple(dt: number) {
    if (prefersReducedMotion) return;
    this.nextAmbientRipple -= dt;
    if (this.nextAmbientRipple > 0) return;
    this.nextAmbientRipple = randomBetween(...AMBIENT_RIPPLE_EVERY);
    this.ripple(randomBetween(-260, 260), randomBetween(-60, 260), 0.45);
  }

  /** Moves every vertex and recolours it. One pass, no allocations. */
  private updateSurface(time: number, dt: number) {
    const { mesh, rest, phases, heat } = this.surface;
    const position = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const colorAttr = mesh.geometry.attributes.color as THREE.BufferAttribute;
    const glowAttr = mesh.geometry.attributes.glow as THREE.BufferAttribute;
    const positions = position.array as Float32Array;
    const colors = colorAttr.array as Float32Array;
    const glows = glowAttr.array as Float32Array;

    const drift = time * DRIFT_SPEED;
    const swell = time * SWELL_SPEED;
    const cooling = Math.exp(-dt / TRAIL_FADE);
    const brushOn = this.hasBrushTarget;
    const { x: bx, y: by } = this.brush;
    const brushR2 = BRUSH_RADIUS * BRUSH_RADIUS;
    const lift = BRUSH_LIFT * this.brushStrength;
    const ripples = this.ripples;
    const trail = this.scratch;

    for (let v = 0, i = 0; i < positions.length; v++, i += 3) {
      const ox = rest[i];
      const oy = rest[i + 1];

      // Layered swells: two crossing waves plus a long diagonal roll.
      let z =
        rest[i + 2] +
        SWELL_HEIGHT *
          (Math.sin(ox * 0.035 + swell) * 0.5 +
            Math.sin(oy * 0.045 - swell * 1.3) * 0.5 +
            Math.sin((ox + oy) * 0.012 + swell * 0.6));

      // The brush lifts the surface and leaves a glowing trail behind it.
      let h = heat[v] * cooling;
      const bdx = ox - bx;
      const bdy = oy - by;
      const bd2 = bdx * bdx + bdy * bdy;
      if (bd2 < brushR2) {
        const f = 1 - bd2 / brushR2;
        z += lift * f * f;
        if (brushOn && f > h) h = f;
      }
      heat[v] = h;

      // Shockwaves: a raised ring that glows as it passes.
      // Glow from passing shockwaves, already tinted by each ripple's colour.
      let gr = 0;
      let gg = 0;
      let gb = 0;
      for (let r = 0; r < ripples.length; r++) {
        const ripple = ripples[r];
        const front = ripple.age * RIPPLE_SPEED;
        const rdx = ox - ripple.x;
        const rdy = oy - ripple.y;
        const u = Math.sqrt(rdx * rdx + rdy * rdy) - front;
        if (u > -RIPPLE_WIDTH * 3 && u < RIPPLE_WIDTH * 3) {
          const life = ripple.strength * (1 - front / RIPPLE_REACH);
          const env = Math.exp(-(u * u) / (RIPPLE_WIDTH * RIPPLE_WIDTH));
          z += RIPPLE_HEIGHT * life * env * Math.cos(u * 0.35);
          const a = life * env;
          gr += ripple.color[0] * a;
          gg += ripple.color[1] * a;
          gb += ripple.color[2] * a;
        }
      }

      positions[i] = ox + Math.sin(drift + phases[v * 2]) * DRIFT_AMPLITUDE;
      positions[i + 1] =
        oy - Math.cos(drift + phases[v * 2 + 1]) * DRIFT_AMPLITUDE;
      positions[i + 2] = z;

      // Base colour follows height: valleys sink into the dark, ridges catch light.
      const t = THREE.MathUtils.clamp(z / 55 + 0.42, 0, 1);
      colors[i] = TROUGH[0] + (CREST[0] - TROUGH[0]) * t;
      colors[i + 1] = TROUGH[1] + (CREST[1] - TROUGH[1]) * t;
      colors[i + 2] = TROUGH[2] + (CREST[2] - TROUGH[2]) * t;

      // Self-lit glow: the pointer's trail plus any passing shockwave.
      let er = 0;
      let eg = 0;
      let eb = 0;
      if (h > 0.002) {
        trailColor(h, trail);
        // Ease the fade so the trail's tail dissolves softly.
        const a = h * h * (3 - 2 * h) * 0.9;
        er = trail[0] * a;
        eg = trail[1] * a;
        eb = trail[2] * a;
      }
      glows[i] = er + Math.min(gr, 1);
      glows[i + 1] = eg + Math.min(gg, 1);
      glows[i + 2] = eb + Math.min(gb, 1);
    }

    position.needsUpdate = true;
    colorAttr.needsUpdate = true;
    glowAttr.needsUpdate = true;
  }

  /**
   * Where a screen position (in NDC) lands on the plane, in the surface's own
   * coordinates, or null if it misses. A ray/plane test instead of raycasting
   * ~34k triangles every frame. The returned vector is reused between calls.
   */
  private planePointAt(ndc: THREE.Vector2) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.restPlane, this.hitPoint);
    if (!hit) return null;
    this.surface.mesh.worldToLocal(hit);
    // Refine against the hills: lift the plane to the terrain height found
    // at the last guess and intersect again. Two rounds is plenty.
    for (let round = 0; round < 2; round++) {
      this.liftedPlane.copy(this.restPlane);
      this.liftedPlane.constant -= terrainHeight(hit.x, hit.y);
      if (!this.raycaster.ray.intersectPlane(this.liftedPlane, hit)) return null;
      this.surface.mesh.worldToLocal(hit);
    }
    const half = PLANE_SIZE / 2;
    return Math.abs(hit.x) < half && Math.abs(hit.y) < half ? hit : null;
  }

  private bindEvents() {
    addEventListener("pointermove", (event) => {
      if (this.isLeaving) return;
      this.pointer.set(
        (event.clientX / innerWidth) * 2 - 1,
        (event.clientY / innerHeight) * -2 + 1,
      );
      this.hasPointer = true;
    });

    addEventListener("pointerdown", (event) => {
      if (this.isLeaving || prefersReducedMotion) return;
      // Clicking a link or the terminal should do that, not splash.
      if ((event.target as Element | null)?.closest("a, button, input, .terminal")) return;
      const point = this.planePointAt(
        new THREE.Vector2(
          (event.clientX / innerWidth) * 2 - 1,
          (event.clientY / innerHeight) * -2 + 1,
        ),
      );
      if (point) this.ripple(point.x, point.y, 1);
    });

    document.documentElement.addEventListener("pointerleave", () => {
      this.hasPointer = false;
    });

    addEventListener("pointerup", (event) => {
      // Touch has no hover: stop painting once the finger lifts.
      if (event.pointerType !== "mouse") this.hasPointer = false;
    });

    addEventListener(
      "wheel",
      (event) => {
        if (this.isLeaving) return;
        this.targetZ = THREE.MathUtils.clamp(
          this.targetZ + event.deltaY * ZOOM_SPEED,
          MIN_CAMERA_Z,
          MAX_CAMERA_Z,
        );
      },
      { passive: true },
    );

    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setSize(innerWidth, innerHeight);
      this.stars.material.uniforms.uPixelRatio.value = Math.min(devicePixelRatio, 2);
    });
  }
}
