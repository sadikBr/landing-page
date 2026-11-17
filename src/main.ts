import gsap from "gsap";
import { createTerminal } from "./terminal";
import type { World } from "./world";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORTFOLIO_URL = "https://portfolio.brahimsadik.com";

const prefersReducedMotion = matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const portfolioLink = document.getElementById(
  "go-to-portfolio",
) as HTMLAnchorElement;
const pageOverlay = document.querySelector(".overlay") as HTMLDivElement;
const revealItems = document.querySelectorAll<HTMLElement>("[data-reveal]");

const terminal = createTerminal({
  form: document.querySelector(".prompt") as HTMLFormElement,
  input: document.querySelector(".prompt__input") as HTMLInputElement,
  display: document.querySelector(".prompt__cmd") as HTMLElement,
  panel: document.getElementById("terminal") as HTMLElement,
  onPortfolio: () => portfolioLink.click(),
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let world: World | null = null;

/** Loads three.js after the text is on screen, then fades the scene in. */
async function startWorld() {
  try {
    const { World } = await import("./world");
    world = new World(canvas, pageOverlay);
    gsap.to(canvas, { opacity: 1, duration: 1.2, ease: "power2.out" });
    if (!prefersReducedMotion) world.ripple(0, 0, 1);
  } catch (error) {
    // No WebGL (or the chunk failed to load): the page works on the plain background.
    console.warn("3D background unavailable.", error);
    canvas.remove();
  }
}

function intro() {
  gsap.to(pageOverlay, { opacity: 0, duration: 1, ease: "power2.out" });
  if (!prefersReducedMotion) {
    gsap.from(revealItems, {
      opacity: 0,
      y: 24,
      duration: 1,
      delay: 0.2,
      stagger: 0.12,
      ease: "power3.out",
    });
    terminal.typeIntro();
  }
}

intro();
void startWorld();

portfolioLink.addEventListener("click", (event) => {
  // Let ctrl/cmd/shift/middle-click open a new tab/window as usual.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
    return;
  }
  event.preventDefault();

  document.body.classList.add("is-leaving");
  terminal.close();
  portfolioLink.setAttribute("aria-disabled", "true");

  const go = () => window.location.assign(PORTFOLIO_URL);

  if (world && !prefersReducedMotion) {
    // Lift the content away as the camera starts to move.
    gsap.to(revealItems, {
      opacity: 0,
      y: -16,
      duration: 0.6,
      stagger: 0.05,
      ease: "power2.in",
    });
    world.flyAway(go);
  } else {
    gsap.to(pageOverlay, { opacity: 1, duration: 0.4, onComplete: go });
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts (shown on the matching links)
// ---------------------------------------------------------------------------

addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  if ((event.target as Element | null)?.closest("input, textarea, select")) return;
  if (document.body.classList.contains("is-leaving")) return;

  if (event.key === "/" || event.key === "`") {
    event.preventDefault();
    terminal.focus();
    return;
  }
  if (event.key.toLowerCase() === "p") {
    portfolioLink.click();
    return;
  }
  if (!/^[a-z]$/i.test(event.key)) return;
  const target = document.querySelector<HTMLAnchorElement>(
    `[data-key="${event.key.toLowerCase()}"]`,
  );
  target?.click();
});

// Restore the page if the user comes back with the browser's back button.
addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  document.body.classList.remove("is-leaving");
  portfolioLink.removeAttribute("aria-disabled");
  world?.reset();
  gsap.killTweensOf(revealItems);
  gsap.set(revealItems, { clearProps: "opacity,transform" });
  intro();
});
