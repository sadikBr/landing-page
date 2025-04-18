import gsap from "gsap";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const portfolioButton = document.getElementById(
  "go-to-portfolio",
) as HTMLButtonElement;
const pageOverlay = document.querySelector(".overlay") as HTMLDivElement;

addEventListener("DOMContentLoaded", () => {
  gsap.to(pageOverlay, {
    opacity: 0,
  });
});

class World {
  rayCaster: THREE.Raycaster;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  objects: Map<string, THREE.Mesh>;
  // interface: DatGUI;
  frameCount: number;
  mousePosition: THREE.Vector2;

  constructor() {
    this.scene = new THREE.Scene();
    this.rayCaster = new THREE.Raycaster();
    this.camera = new THREE.PerspectiveCamera(
      75,
      innerWidth / innerHeight,
      0.1,
      1000,
    );
    this.camera.position.z = 150;
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      canvas: document.getElementById("canvas") as HTMLCanvasElement,
    });
    this.renderer.setSize(innerWidth, innerHeight);
    this.objects = new Map();

    this.mousePosition = new THREE.Vector2(0, 0);
    this.frameCount = 0;

    new OrbitControls(this.camera, this.renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(0, 1, 1);
    this.scene.add(light);

    const backLight = new THREE.DirectionalLight(0xffffff, 1);
    backLight.position.set(0, 0, -1);
    this.scene.add(backLight);

    // Start Animating the world
    this.animate();
    this.setupMouseEventListener();
    this.listenToPortfolioButton();
  }

  listenToPortfolioButton() {
    portfolioButton.addEventListener("click", () => {
      document.documentElement.style.pointerEvents = "none";
      portfolioButton.setAttribute("disabled", "true");
      gsap.to(this.camera.rotation, {
        x: 1.5,
        y: 0,
        z: 0,
        duration: 2,
      });
      gsap.to(this.camera.position, {
        z: 40,
        duration: 2,
      });
      gsap.to(this.camera.position, {
        y: -100,
        duration: 1,
        delay: 2,
      });
      gsap.to(pageOverlay, {
        opacity: 1,
        duration: 0.5,
        delay: 3,
      });
      gsap.to(this.camera.position, {
        y: 800,
        duration: 0.5,
        delay: 3,
        onComplete: () => {
          window.location.href = "https://portfolio.brahimsadik.com";
        },
      });
    });
  }

  addObject(name: string, object: THREE.Mesh) {
    this.objects.set(name, object);
    this.scene.add(object);
  }

  updateColor(
    color: any,
    face: THREE.Face,
    newColor: { r: number; g: number; b: number },
  ) {
    for (const key in face) {
      if (key === "a" || key === "b" || key === "c") {
        color.setX(face[key], newColor.r);
        color.setY(face[key], newColor.g);
        color.setZ(face[key], newColor.b);
      }
    }

    color.needsUpdate = true;
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.frameCount += 0.01;

    const plane = this.objects.get("plane");
    if (plane != undefined) {
      this.rayCaster.setFromCamera(this.mousePosition, this.camera);

      // @ts-ignore
      const { array, originalPosition, randomValues } =
        plane.geometry.attributes.position;
      for (let i = 0; i < array.length; i += 3) {
        array[i] =
          originalPosition[i] +
          Math.cos(this.frameCount + randomValues[i]) * 0.006;
        array[i + 1] =
          originalPosition[i + 1] +
          Math.sin(this.frameCount + randomValues[i + 1]) * 0.006;
      }
      plane.geometry.attributes.position.needsUpdate = true;

      const intersects = this.rayCaster.intersectObject(plane);

      if (intersects.length > 0) {
        const initialColor = {
          r: 0.01,
          g: 0.03,
          b: 0.12,
        };

        const hoverColor = {
          r: 0.1,
          g: 0.5,
          b: 1,
        };

        // @ts-ignore
        const { color } = intersects[0].object.geometry.attributes;
        this.updateColor(color, intersects[0].face as THREE.Face, hoverColor);

        gsap.to(hoverColor, {
          r: initialColor.r,
          g: initialColor.g,
          b: initialColor.b,
          onUpdate: () => {
            this.updateColor(
              color,
              intersects[0].face as THREE.Face,
              hoverColor,
            );
          },
        });
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  setupMouseEventListener() {
    addEventListener("mousemove", (event) => {
      this.mousePosition.x = (event.clientX / innerWidth) * 2 - 1;
      this.mousePosition.y = (event.clientY / innerHeight) * -2 + 1;
    });
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(innerWidth, innerHeight);
  }
}

const world = new World();

// Plane creation code
const plane = new THREE.Mesh(
  new THREE.PlaneGeometry(1000, 1000, 170, 170),
  new THREE.MeshPhongMaterial({
    // color: 'green',
    side: THREE.DoubleSide,
    flatShading: true,
    vertexColors: true,
  }),
);

function customizePlane(plane: THREE.Mesh) {
  // @ts-ignore
  const { array } = plane.geometry.attributes.position;
  const randomValues = [];

  for (let i = 0; i < array.length; i += 1) {
    if (i % 3 === 0) {
      const x = array[i];
      const y = array[i + 1];
      const z = array[i + 2];

      array[i] = x + (Math.random() - 0.5) * 2;
      array[i + 1] = y + (Math.random() - 0.5) * 2;
      array[i + 2] = z + (Math.random() - 0.5) * 10;
    }

    randomValues.push((Math.random() - 0.5) * 15);
  }

  // @ts-ignore
  plane.geometry.attributes.position.randomValues = randomValues;

  // @ts-ignore
  plane.geometry.attributes.position.originalPosition =
    // @ts-ignore
    plane.geometry.attributes.position.array;

  const colors: number[] = [];
  for (let i = 0; i < plane.geometry.attributes.position.count; i++) {
    colors.push(0.01, 0.03, 0.12);
  }
  // @ts-ignore
  plane.geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(colors), 3),
  );
}

customizePlane(plane);

world.addObject("plane", plane);

// Starfield creation code
for (let i = 0; i < 1000; i++) {
  const star = new THREE.Mesh(
    new THREE.SphereGeometry(Math.random() + 1, 20, 20),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
    }),
  );

  const r = 500 + Math.random() * 500;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.random() * Math.PI;

  star.position.set(
    r * Math.sin(theta) * Math.cos(phi),
    r * Math.sin(theta) * Math.sin(phi),
    r * Math.cos(theta),
  );

  world.addObject(`star${i}`, star);
}

// Event listeners
addEventListener("resize", () => {
  world.resize();
});
