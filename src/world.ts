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

const PLANE_SIZE = 1000;
// Fewer, larger facets on phones: the detail barely shows there and saves CPU.
const PLANE_SEGMENTS = matchMedia("(pointer: coarse), (max-width: 700px)").matches
  ? 110
  : 170;
const DRIFT_SPEED = 0.6; // radians per second
const DRIFT_AMPLITUDE = 0.6;

/** Slow, layered swells that make the surface roll like a dark sea. */
const SWELL_SPEED = 0.35;
const SWELL_HEIGHT = 3.2;

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

const STAR_COUNT = 1000;

type RGB = readonly [number, number, number];
// Linear-space colours (three converts them to sRGB on output).
const TROUGH: RGB = [0.004, 0.012, 0.055];
const CREST: RGB = [0.022, 0.06, 0.19];
const TRAIL_HOT: RGB = [0.15, 0.55, 1.0]; // fresh: electric blue
const TRAIL_MID: RGB = [0.42, 0.14, 0.85]; // cooling: violet
const TRAIL_COLD: RGB = [0.6, 0.05, 0.1]; // dying: ember red
const RIPPLE_GLOW: RGB = [0.42, 0.07, 0.11];

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
}

interface Surface {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhongMaterial>;
  rest: Float32Array;
  phases: Float32Array;
  /** Per-vertex glow left behind by the pointer, 0..1. */
  heat: Float32Array;
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

  // Jitter every vertex to get the low-poly, crumpled look.
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += (Math.random() - 0.5) * 2;
    positions[i + 1] += (Math.random() - 0.5) * 2;
    positions[i + 2] += (Math.random() - 0.5) * 10;
  }
  for (let i = 0; i < phases.length; i++) {
    phases[i] = (Math.random() - 0.5) * 15;
  }

  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(position.count * 3), 3),
  );
  geometry.computeBoundingSphere();

  const material = new THREE.MeshPhongMaterial({
    side: THREE.DoubleSide,
    flatShading: true,
    vertexColors: true,
    shininess: 30,
    specular: new THREE.Color(0x0a1230),
  });

  return {
    mesh: new THREE.Mesh(geometry, material),
    // A real copy, so the motion oscillates around the rest pose instead of drifting.
    rest: positions.slice(),
    phases,
    heat: new Float32Array(position.count),
  };
}

function createStarfield(): THREE.InstancedMesh {
  // One draw call for all stars instead of one mesh per star.
  const stars = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    STAR_COUNT,
  );

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();

  for (let i = 0; i < STAR_COUNT; i++) {
    const radius = 500 + Math.random() * 500;
    position.randomDirection().multiplyScalar(radius);
    scale.setScalar(Math.random() + 1);
    matrix.compose(position, rotation, scale);
    stars.setMatrixAt(i, matrix);
  }
  stars.instanceMatrix.needsUpdate = true;

  return stars;
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

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export class World {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly raycaster = new THREE.Raycaster();
  /** The surface's rest plane. Cheap to hit-test, and close enough to the
   *  real surface (it only moves a few units) to place the brush. */
  private readonly restPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly hitPoint = new THREE.Vector3();
  private readonly overlay: HTMLElement;
  private readonly clock = new THREE.Clock();
  private readonly pointer = new THREE.Vector2();
  private readonly surface: Surface;
  private readonly stars: THREE.InstancedMesh;
  private readonly cursorLight: THREE.PointLight;
  private readonly roamingLight: THREE.PointLight;
  private readonly ripples: Ripple[] = [];

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

    this.camera = new THREE.PerspectiveCamera(
      75,
      innerWidth / innerHeight,
      0.1,
      1000,
    );
    this.camera.position.z = DEFAULT_CAMERA_Z;
    this.scene.add(this.camera);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(0, 1, 1);
    const backLight = new THREE.DirectionalLight(0xffffff, 1);
    backLight.position.set(0, 0, -1);

    // A blue glow that rides just above the pointer…
    this.cursorLight = new THREE.PointLight(0x4d8dff, 0, 90, 2);
    this.cursorLight.position.z = 26;
    // …and a dim red one that wanders, so the surface is alive even untouched.
    this.roamingLight = new THREE.PointLight(0xd54545, 0.45, 130, 2);
    this.roamingLight.position.z = 26;

    this.scene.add(light, backLight, this.cursorLight, this.roamingLight);

    this.surface = createSurface();
    this.stars = createStarfield();
    this.scene.add(this.surface.mesh, this.stars);

    this.bindEvents();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** Sends a shockwave across the surface from (x, y) in plane space. */
  ripple(x = 0, y = 0, strength = 1) {
    if (this.ripples.length >= MAX_RIPPLES) this.ripples.shift();
    this.ripples.push({ x, y, age: 0, strength });
  }

  /** Flies the camera up through the plane, then calls `onDone`. */
  flyAway(onDone: () => void) {
    this.isLeaving = true;
    this.hasPointer = false;
    this.ripple(0, 0, 1.6);

    gsap
      .timeline({ onComplete: onDone })
      .to(this.camera.rotation, { x: 1.5, y: 0, z: 0, duration: 2 }, 0)
      .to(this.camera.position, { z: 40, duration: 2 }, 0)
      .to(this.camera.position, { y: -100, duration: 1 }, 2)
      .to(this.overlay, { opacity: 1, duration: 0.5 }, 3)
      .to(this.camera.position, { y: 800, duration: 0.5 }, 3);
  }

  /** Puts the camera back (e.g. when the page is restored from bfcache). */
  reset() {
    gsap.killTweensOf([this.camera.position, this.camera.rotation]);
    this.camera.position.set(0, 0, DEFAULT_CAMERA_Z);
    this.camera.rotation.set(0, 0, 0);
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

    this.updateBrush();
    this.updateRipples(dt);
    this.updateSurface(time, dt);

    this.roamingLight.position.x = Math.sin(time * 0.23) * 120;
    this.roamingLight.position.y = Math.cos(time * 0.31) * 70;
    this.stars.rotation.z = time * 0.01;

    this.renderer.render(this.scene, this.camera);
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
    this.ripple(randomBetween(-200, 200), randomBetween(-110, 110), 0.45);
  }

  /** Moves every vertex and recolours it. One pass, no allocations. */
  private updateSurface(time: number, dt: number) {
    const { mesh, rest, phases, heat } = this.surface;
    const position = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const colorAttr = mesh.geometry.attributes.color as THREE.BufferAttribute;
    const positions = position.array as Float32Array;
    const colors = colorAttr.array as Float32Array;

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
      let glow = 0;
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
          glow += life * env;
        }
      }

      positions[i] = ox + Math.sin(drift + phases[v * 2]) * DRIFT_AMPLITUDE;
      positions[i + 1] =
        oy - Math.cos(drift + phases[v * 2 + 1]) * DRIFT_AMPLITUDE;
      positions[i + 2] = z;

      // Base colour follows height: troughs sink into the dark, crests catch light.
      const t = THREE.MathUtils.clamp((z - rest[i + 2]) / (SWELL_HEIGHT * 4) + 0.5, 0, 1);
      let r = TROUGH[0] + (CREST[0] - TROUGH[0]) * t;
      let g = TROUGH[1] + (CREST[1] - TROUGH[1]) * t;
      let b = TROUGH[2] + (CREST[2] - TROUGH[2]) * t;

      if (h > 0.002) {
        trailColor(h, trail);
        const a = Math.min(1, h * 1.6);
        r += (trail[0] - r) * a;
        g += (trail[1] - g) * a;
        b += (trail[2] - b) * a;
      }
      if (glow > 0.002) {
        const a = Math.min(1, glow);
        r += RIPPLE_GLOW[0] * a;
        g += RIPPLE_GLOW[1] * a;
        b += RIPPLE_GLOW[2] * a;
      }

      colors[i] = r;
      colors[i + 1] = g;
      colors[i + 2] = b;
    }

    position.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  /**
   * Where a screen position (in NDC) lands on the plane, or null if it misses.
   * A ray/plane test instead of raycasting ~58k triangles every frame.
   * The returned vector is reused between calls.
   */
  private planePointAt(ndc: THREE.Vector2) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.restPlane, this.hitPoint);
    const half = PLANE_SIZE / 2;
    return hit && Math.abs(hit.x) < half && Math.abs(hit.y) < half ? hit : null;
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
      // Clicking the link should navigate, not splash.
      if ((event.target as Element | null)?.closest("a, button")) return;
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
    });
  }
}
