import gsap from "gsap";

// The prompt pill in the hero, turned into a small working terminal.
//
// Links and projects are read from the page itself (`[data-link]` and
// `.project` elements), so the HTML stays the single source of truth and the
// terminal never disagrees with what is on screen.

interface TerminalOptions {
  form: HTMLFormElement;
  input: HTMLInputElement;
  /** Where the command line is drawn (the real input is invisible on top). */
  display: HTMLElement;
  panel: HTMLElement;
  /** Starts the trip to the portfolio (the fly-away). */
  onPortfolio: () => void;
}

interface Project {
  name: string;
  description: string;
  href: string;
  code?: string;
}

type Print = (...parts: (string | Node)[]) => void;

const INTRO_COMMAND = "whoami";

const link = (text: string, href: string) => {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  if (!href.startsWith("mailto:")) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  return a;
};

const span = (text: string, className: string) => {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
};

const openUrl = (href: string) => {
  if (href.startsWith("mailto:")) window.location.href = href;
  else window.open(href, "_blank", "noopener");
};

export function createTerminal(options: TerminalOptions) {
  const { form, input, display, panel, onPortfolio } = options;

  const links = new Map<string, string>();
  for (const el of document.querySelectorAll<HTMLAnchorElement>("[data-link]")) {
    links.set(el.dataset.link!, el.href);
  }
  const email = (links.get("email") ?? "").replace(/^mailto:/, "");

  const projects: Project[] = [
    ...document.querySelectorAll<HTMLAnchorElement>(".project"),
  ].map((el) => ({
    name: el.querySelector(".project__name")?.textContent?.trim() ?? "",
    description: el.querySelector(".project__desc")?.textContent?.trim() ?? "",
    href: el.href,
    code: el.dataset.code,
  }));

  const history: string[] = [];
  let historyIndex = 0;
  let introTween: gsap.core.Tween | null = null;

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  const print: Print = (...parts) => {
    const line = document.createElement("p");
    line.className = "terminal__line";
    line.append(...parts);
    panel.append(line);
  };

  const echo = (command: string) => {
    const line = document.createElement("p");
    line.className = "terminal__line terminal__line--echo";
    line.append(span("$ ", "terminal__sigil"), command);
    panel.append(line);
  };

  const open = () => {
    if (!panel.hidden) return;
    panel.hidden = false;
    gsap.fromTo(
      panel,
      { opacity: 0, y: -6 },
      { opacity: 1, y: 0, duration: 0.25, ease: "power2.out" },
    );
  };

  const close = () => {
    panel.hidden = true;
  };

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  const projectByName = (query: string) => {
    const q = query.toLowerCase();
    return projects.find((p) => p.name.toLowerCase().includes(q));
  };

  /** `open <thing>`: a link, a project, or the portfolio. */
  const openThing = (what: string) => {
    if (!what) return print("usage: open <portfolio|github|linkedin|cv|project name>");
    if (what === "portfolio") return commands.portfolio.run([]);
    const href = links.get(what === "resume" ? "cv" : what);
    if (href) {
      print("opening ", what, "…");
      return openUrl(href);
    }
    const project = projectByName(what);
    if (project) {
      print("opening ", project.name, "…");
      return openUrl(project.href);
    }
    print(span(`nothing called "${what}". Try `, "terminal__muted"), span("projects", "terminal__cmd"));
  };

  const commands: Record<string, { help?: string; run: (args: string[]) => void }> = {
    help: {
      help: "list commands",
      run: () => {
        for (const [name, { help }] of Object.entries(commands)) {
          if (help) print(span(name.padEnd(11), "terminal__cmd"), span(help, "terminal__muted"));
        }
        print(span("tab completes, ↑/↓ for history, esc to close", "terminal__muted"));
      },
    },
    whoami: {
      help: "who is this?",
      run: () => {
        print("Brahim SADIK. Full-stack developer and software engineer, based in Morocco.");
        print(span("Software Engineer @ PercallGroup · 5+ years writing code", "terminal__muted"));
      },
    },
    status: {
      help: "what I'm up to",
      run: () => {
        print(span("● ", "terminal__ok"), "Open to new opportunities.");
        print(span("Building things for the web, the desktop and the tablet.", "terminal__muted"));
      },
    },
    projects: {
      help: "things I've built",
      run: () => {
        projects.forEach((p, i) => {
          print(span(`0${i + 1} `, "terminal__muted"), link(p.name, p.href), span(` ${p.description}`, "terminal__muted"));
        });
        const github = links.get("github");
        if (github) print(span("more on ", "terminal__muted"), link("github", github));
      },
    },
    contact: {
      help: "ways to reach me",
      run: () => {
        if (email) print(span("email    ", "terminal__muted"), link(email, `mailto:${email}`));
        for (const key of ["linkedin", "github"]) {
          const href = links.get(key);
          if (href) print(span(key.padEnd(9), "terminal__muted"), link(href.replace(/^https?:\/\//, ""), href));
        }
      },
    },
    email: {
      help: "copy my email address",
      run: () => {
        if (!email) return;
        navigator.clipboard?.writeText(email).then(
          () => print(span("✓ ", "terminal__ok"), "copied ", email),
          () => print(link(email, `mailto:${email}`)),
        );
      },
    },
    cv: {
      help: "my résumé",
      run: () => openThing("cv"),
    },
    open: {
      help: "open <github|linkedin|cv|project>",
      run: (args) => openThing(args.join(" ").toLowerCase()),
    },
    portfolio: {
      help: "the full story (take the ship)",
      run: () => {
        print("engaging warp drive…");
        input.blur();
        setTimeout(onPortfolio, 350);
      },
    },
    clear: {
      help: "clear the screen",
      run: () => panel.replaceChildren(),
    },
    exit: {
      run: () => {
        close();
        input.blur();
      },
    },
    // A few aliases and things people will try anyway.
    ls: { run: () => print("about  projects  contact  cv  portfolio") },
    cd: {
      run: (args) =>
        args[0]?.replace(/\/$/, "") === "portfolio"
          ? commands.portfolio.run([])
          : print(span("try ", "terminal__muted"), span("cd portfolio", "terminal__cmd")),
    },
    resume: { run: () => openThing("cv") },
    github: { run: () => openThing("github") },
    linkedin: { run: () => openThing("linkedin") },
    sudo: { run: () => print("nice try. this incident will be reported.") },
    hire: { run: () => commands.contact.run([]) },
  };

  const run = (raw: string) => {
    const line = raw.trim();
    open();
    echo(line);
    if (!line) return;
    history.push(line);
    historyIndex = history.length;

    const [name, ...args] = line.split(/\s+/);
    const command = commands[name.toLowerCase()];
    if (command) command.run(args);
    else print(span(`command not found: ${name}. Type `, "terminal__muted"), span("help", "terminal__cmd"));
    panel.scrollTop = panel.scrollHeight;
  };

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  /** The visible command line mirrors the hidden input. */
  const render = () => {
    display.textContent = input.value;
  };

  const complete = () => {
    const value = input.value.trimStart().toLowerCase();
    if (!value || value.includes(" ")) return;
    const matches = Object.keys(commands).filter((c) => c.startsWith(value));
    if (matches.length === 1) input.value = `${matches[0]} `;
    else if (matches.length > 1) {
      open();
      print(span(matches.join("  "), "terminal__muted"));
    }
    render();
  };

  input.addEventListener("input", render);

  input.addEventListener("focus", () => {
    introTween?.kill();
    form.classList.add("is-active");
    // Clear the intro text, and greet on first use.
    if (!input.value) render();
    if (!panel.childElementCount) {
      open();
      print("Hi! This terminal works. Type ", span("help", "terminal__cmd"), " to see what it can do.");
    } else {
      open();
    }
  });

  input.addEventListener("blur", () => {
    form.classList.remove("is-active");
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      complete();
    } else if (event.key === "Escape") {
      close();
      input.blur();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (!history.length) return;
      event.preventDefault();
      historyIndex += event.key === "ArrowUp" ? -1 : 1;
      historyIndex = Math.max(0, Math.min(history.length, historyIndex));
      input.value = history[historyIndex] ?? "";
      render();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = "";
    render();
    run(value);
  });

  // Clicking anywhere else closes the panel (but not while typing in it).
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (!form.contains(target) && !panel.contains(target)) close();
  });

  return {
    /** Types the intro command, one key at a time, unless the user got there first. */
    typeIntro(delay = 0.7) {
      const progress = { chars: 0 };
      display.textContent = "";
      introTween = gsap.to(progress, {
        chars: INTRO_COMMAND.length,
        duration: INTRO_COMMAND.length * 0.09,
        delay,
        ease: "none",
        snap: { chars: 1 },
        onUpdate: () => {
          display.textContent = INTRO_COMMAND.slice(0, progress.chars);
        },
      });
    },
    focus() {
      input.focus();
    },
    close,
  };
}
