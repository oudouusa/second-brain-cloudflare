/**
 * Projects in the everyday surfaces: the composer's picker, the Memories and
 * recall filters, and the project chip that replaces the raw project: tag.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { PROJECT_ROWS, drain, setupProjects } from "./_projects-harness";

const ROOT = resolve(import.meta.dirname, "../..");
const HTML = readFileSync(resolve(ROOT, "public/index.html"), "utf8");

/** Page order, trimmed to what these surfaces need. */
const SCRIPTS = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/toast.js",
  "public/js/coach.js",
  "public/js/confirm-sheet.js",
  "public/js/api.js",
  "public/js/ui-chat.js",
  "public/js/recall.js",
  "public/js/recent.js",
  "public/js/remember.js",
  "public/js/memory-crud.js",
  "public/js/projects.js",
  "public/js/home.js",
  "public/js/nav.js",
];

const ACTIVE = PROJECT_ROWS.filter((r) => r.status === "active");

function world(over: Record<string, any> = {}) {
  return {
    "GET /projects": { body: { projects: ACTIVE } },
    "POST /list": { body: [] },
    "POST /capture": { body: { ok: true, id: "e1", tags: ["project:website"] } },
    "POST /recall": { body: { ok: true, results: [] } },
    ...over,
  } as Record<string, any>;
}

function boot(over: Record<string, any> = {}, o: { teamMode?: boolean; store?: Record<string, string>; lenient?: boolean } = {}) {
  const h = setupProjects({
    routes: world(over),
    teamMode: o.teamMode,
    scripts: SCRIPTS,
    lenient: o.lenient,
    extra: { autoResize() {}, refreshAll: async () => {} },
  });
  for (const [k, v] of Object.entries(o.store || {})) h.ctx.localStorage.setItem(k, v);
  return h;
}

const options = (h: any, id: string) => h.els.get(id).innerHTML as string;

describe("markup", () => {
  it("puts a project picker in the composer and a filter beside both tag filters", () => {
    expect(HTML).toContain('id="home-project"');
    expect(HTML).toMatch(/id="home-project"[^>]*onchange="onHomeProjectChange\(this\.value\)"/);
    expect(HTML).toMatch(/id="project-filter-recent"[^>]*onchange="onProjectFilterChange\(this\.value\)"/);
    expect(HTML).toMatch(/id="project-filter-recall"[^>]*onchange="onProjectFilterChange\(this\.value\)"/);
  });

  it("ships all three hidden: a brain with no projects sees none of this", () => {
    for (const id of ["home-project-wrap", "project-filter-wrap-recent", "project-filter-wrap-recall"]) {
      expect(HTML).toMatch(new RegExp(`id="${id}"[^>]*style="display: none"`));
    }
  });
});

describe("composer picker", () => {
  it("is fed by GET /projects, without counts or archived rows, and offers No project first", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    const call = h.calls.find((c) => c.path === "/projects")!;
    expect(call.query.has("counts")).toBe(false);
    expect(call.query.has("include_archived")).toBe(false);
    const html = options(h, "home-project");
    expect(html.indexOf("No project")).toBeGreaterThan(-1);
    expect(html.indexOf("No project")).toBeLessThan(html.indexOf("Website relaunch"));
    expect(html).toContain('value="website"');
    expect(html).toContain('value="trip-rome"');
    expect(html).not.toContain("Old app");
    expect(h.els.get("home-project-wrap").style.display).toBe("");
  });

  it("stays out of sight until there is a project to pick", async () => {
    const h = boot({ "GET /projects": { body: { projects: [] } } });
    await h.ctx.loadComposerProjects();
    expect(h.els.get("home-project-wrap").style.display).toBe("none");
  });

  it("stays out of sight, quietly, on a Worker that has no /projects", async () => {
    const h = boot({ "GET /projects": { status: 404, body: {} } });
    await h.ctx.loadComposerProjects();
    expect(h.els.get("home-project-wrap").style.display).toBe("none");
    expect(h.appended).toHaveLength(0);
  });

  it("defaults to no project", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    expect(h.els.get("home-project").value).toBe("");
  });

  it("remembers the last choice under sb-project-last, and offers it again next time", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    h.ctx.onHomeProjectChange("website");
    expect(h.store.get("sb-project-last")).toBe("website");
    const next = boot({}, { store: { "sb-project-last": "website" } });
    await next.ctx.loadComposerProjects();
    expect(next.els.get("home-project").value).toBe("website");
  });

  it("forgets a choice that is no longer there", async () => {
    const h = boot({}, { store: { "sb-project-last": "gone" } });
    await h.ctx.loadComposerProjects();
    expect(h.els.get("home-project").value).toBe("");
  });

  it("clears the remembered choice when No project is picked", async () => {
    const h = boot({}, { store: { "sb-project-last": "website" } });
    await h.ctx.loadComposerProjects();
    h.ctx.onHomeProjectChange("");
    expect(h.store.get("sb-project-last") ?? "").toBe("");
  });

  it("tracks the Projects screen without another request", async () => {
    const h = boot({ "GET /projects": { body: { projects: PROJECT_ROWS } } });
    await h.ctx.loadProjects();
    expect(options(h, "home-project")).toContain("Trip to Rome");
    expect(options(h, "home-project")).not.toContain("Old app");
    expect(h.calls.filter((c) => c.path === "/projects")).toHaveLength(1);
  });

  it("escapes names", async () => {
    const evil = { ...ACTIVE[0], name: '"><script>x()</script>' };
    const h = boot({ "GET /projects": { body: { projects: [evil] } } });
    await h.ctx.loadComposerProjects();
    expect(options(h, "home-project")).not.toContain("<script>");
  });
});

describe("capturing into a project", () => {
  async function capture(h: any, text = "Decided to ship on Friday") {
    h.els.get("home-field").value = text;
    await h.ctx.submitHome();
  }
  const post = (h: any) => h.calls.find((c: any) => c.method === "POST" && c.path === "/capture");

  it("sends the chosen project with the capture", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    h.els.get("home-project").value = "website";
    h.ctx.onHomeProjectChange("website");
    await capture(h);
    expect(post(h).body.project).toBe("website");
    expect(post(h).body.content).toBe("Decided to ship on Friday");
  });

  it("sends none when none is chosen", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    await capture(h);
    expect("project" in post(h).body).toBe(false);
  });

  it("keeps the project selected for the next capture", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    h.els.get("home-project").value = "website";
    h.ctx.onHomeProjectChange("website");
    await capture(h);
    expect(h.els.get("home-project").value).toBe("website");
  });

  it("on a team brain, a project pins the capture to its own workspace", async () => {
    const h = boot({}, { teamMode: true });
    await h.ctx.loadComposerProjects();
    h.els.get("home-project").value = "trip-rome";
    h.ctx.onHomeProjectChange("trip-rome");
    expect(h.els.get("home-layer").value).toBe("company");
    await capture(h);
    expect(post(h).body.workspace).toBe("company");
    expect(post(h).body.project).toBe("trip-rome");
  });

  it("on a solo brain, never sends a workspace", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    h.els.get("home-project").value = "trip-rome";
    h.ctx.onHomeProjectChange("trip-rome");
    await capture(h);
    expect("workspace" in post(h).body).toBe(false);
  });

  it("says which project the memory went to", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    const receipt = h.ctx.captureReceipt({ tags: ["project:website", "work"] }, []);
    expect(receipt.innerHTML).toContain("Website relaunch");
    expect(receipt.innerHTML).not.toContain("project:website");
    expect(receipt.innerHTML).toContain("work");
  });

  /**
   * The 128 KB size cap (Rahil's decision, T-0101.10): POST /capture can 413
   * with { ok:false, error:"too_large", limit_bytes, message }. The composer
   * shows the copy deck's own inline line, and — its explicit promise — keeps
   * the text in the box rather than clearing it like a normal capture does.
   */
  describe("the 128 KB size cap", () => {
    it("shows the size-cap line inline and keeps the text in the box", async () => {
      const h = boot({ "POST /capture": { status: 413, body: { ok: false, error: "too_large", limit_bytes: 131072, message: "Too long..." } } });
      await capture(h, "x".repeat(200000));
      expect(h.els.get("home-field").value).toBe("x".repeat(200000));
      const receiptHtml = h.els.get("home-more").innerHTML as string;
      expect(receiptHtml).toContain(
        "Too long to save as one memory (about 20,000 words at most). Your text is still here, so you can split it.",
      );
      // Not the monospace receipt card: a full sentence in that font reads
      // like a debug log, not a message. Same inline treatment settings'
      // save error uses.
      expect(receiptHtml).toContain('class="inline-error"');
      expect(receiptHtml).not.toContain("receipt-headline");
    });

    it("speaks Italian when the page does", async () => {
      const h = boot({ "POST /capture": { status: 413, body: { ok: false, error: "too_large" } } });
      h.run(`initI18n("it")`);
      await capture(h, "x".repeat(200000));
      expect(h.els.get("home-field").value).toBe("x".repeat(200000));
      expect(h.els.get("home-more").innerHTML).toContain(
        "Troppo lungo per un solo ricordo (al massimo circa 20.000 parole). Il testo è ancora qui, così puoi dividerlo.",
      );
    });

    it("a normal capture still clears the field and stores the receipt", async () => {
      const h = boot();
      await capture(h, "Decided to ship on Friday");
      expect(h.els.get("home-field").value).toBe("");
    });
  });
});

describe("project chips", () => {
  it("name the project, using its display name when it is known", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    const html = h.ctx.projectChipsHtml(["work", "project:website", "project:unknown-one"]) as string;
    expect(html).toContain("Website relaunch");
    expect(html).toContain("unknown-one");
    expect(html).toContain("tag-chip--project");
    expect(html).not.toContain("project:");
    expect(html).not.toContain("work");
  });

  it("are empty for a memory in no project", () => {
    const h = boot();
    expect(h.ctx.projectChipsHtml(["work"])).toBe("");
    expect(h.ctx.projectChipsHtml(null)).toBe("");
  });

  it("escape the name", async () => {
    const evil = { ...ACTIVE[0], name: "<b>x</b>" };
    const h = boot({ "GET /projects": { body: { projects: [evil] } } });
    await h.ctx.loadComposerProjects();
    expect(h.ctx.projectChipsHtml(["project:website"])).not.toContain("<b>");
  });

  it("lead the tag row of a memory card", async () => {
    const h = boot({}, { lenient: true });
    await h.ctx.loadComposerProjects();
    const card = h.ctx.makeRecentCard({ id: "m1", content: "Hello there", tags: JSON.stringify(["work", "project:website"]), created_at: Date.now(), source: "cli" });
    const html = card.innerHTML as string;
    expect(html).toContain("tag-chip--project");
    expect(html.indexOf("tag-chip--project")).toBeLessThan(html.indexOf(">work<"));
  });

  it("show on a recall card too", async () => {
    const h = boot({}, { lenient: true });
    await h.ctx.loadComposerProjects();
    const card = h.ctx.makeRecallCard({ id: "m1", content: "Hello there", tags: ["work", "project:website"], score: 80, hop: 0, created_at: Date.now(), source: "cli" }, 1);
    expect(card.innerHTML).toContain("tag-chip--project");
  });
});

describe("project filter", () => {
  it("lists the active projects, after All projects, in both places", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    for (const id of ["project-filter-recent", "project-filter-recall"]) {
      const html = options(h, id);
      expect(html.indexOf("All projects")).toBeLessThan(html.indexOf("Website relaunch"));
      expect(html).not.toContain("Old app");
    }
    expect(h.els.get("project-filter-wrap-recent").style.display).toBe("");
    expect(h.els.get("project-filter-wrap-recall").style.display).toBe("");
  });

  it("hides with no projects", async () => {
    const h = boot({ "GET /projects": { body: { projects: [] } } });
    await h.ctx.loadComposerProjects();
    expect(h.els.get("project-filter-wrap-recent").style.display).toBe("none");
  });

  it("apiList sends project= only when one is given", async () => {
    const h = boot();
    await h.ctx.apiList(50, undefined, undefined, "", "website");
    await h.ctx.apiList(50);
    const [withProject, without] = h.calls.filter((c) => c.path === "/list");
    expect(withProject.body?.project).toBe("website");
    expect(without.body?.project).toBeUndefined();
  });

  it("narrows the Memories list on the server, and keeps both selects in step", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    h.run(`currentTab = "memories"`);
    h.ctx.onProjectFilterChange("website");
    await drain();
    const list = h.calls.filter((c) => c.path === "/list").pop()!;
    expect(list.body?.project).toBe("website");
    expect(h.els.get("project-filter-recent").value).toBe("website");
    expect(h.els.get("project-filter-recall").value).toBe("website");
  });

  it("combines with a tag filter instead of replacing it", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    h.run(`currentTab = "memories"`);
    h.ctx.onTagChange("work");
    h.ctx.onProjectFilterChange("website");
    await drain();
    const list = h.calls.filter((c) => c.path === "/list").pop()!;
    expect(list.body?.tag).toBe("work");
    expect(list.body?.project).toBe("website");
  });

  it("All projects lifts the filter", async () => {
    const h = boot();
    await h.ctx.loadComposerProjects();
    h.run(`currentTab = "memories"`);
    h.ctx.onProjectFilterChange("website");
    h.ctx.onProjectFilterChange("");
    await drain();
    expect(h.calls.filter((c) => c.path === "/list").pop()!.body?.project).toBeUndefined();
  });

  it("drops a project that has vanished, and shows the list without it", async () => {
    let gone = false;
    const h = boot({
      "POST /list": (c: any) =>
        c.body?.project && !gone
          ? ((gone = true), { status: 404, body: { error: 'unknown project "website"', known_projects: ["trip-rome"] } })
          : { body: [] },
    });
    await h.ctx.loadComposerProjects();
    h.run(`currentTab = "memories"`);
    h.ctx.onProjectFilterChange("website");
    await drain();
    await drain();
    expect(h.els.get("project-filter-recent").value).toBe("");
    const lists = h.calls.filter((c) => c.path === "/list");
    expect(lists.at(-1)!.body?.project).toBeUndefined();
  });

  describe("when the selected project is archived elsewhere", () => {
    const archived = () => ({ "GET /projects": { body: { projects: ACTIVE.filter((r) => r.id !== "website") } } });
    const lists = (h: any) => h.calls.filter((c: any) => c.path === "/list");

    async function selectWebsite(h: any, tab: string) {
      await h.ctx.loadComposerProjects();
      h.run(`currentTab = "${tab}"`);
      h.ctx.onProjectFilterChange("website");
      await drain();
    }

    it("reloads the Memories list unfiltered instead of leaving the old rows under All projects", async () => {
      let projects: any = { projects: ACTIVE };
      const h = boot({ "GET /projects": () => ({ body: projects }) });
      await selectWebsite(h, "memories");
      const before = lists(h).length;

      projects = { projects: ACTIVE.filter((r) => r.id !== "website") };
      await h.ctx.loadComposerProjects();
      await drain();

      expect(h.els.get("project-filter-recent").value).toBe("");
      expect(lists(h).length).toBe(before + 1);
      expect(lists(h).at(-1).body?.project).toBeUndefined();
    });

    it("does not fetch a list when Memories is not the current tab", async () => {
      let projects: any = { projects: ACTIVE };
      const h = boot({ "GET /projects": () => ({ body: projects }) });
      await selectWebsite(h, "home");
      const before = lists(h).length;

      projects = archived()["GET /projects"].body;
      await h.ctx.loadComposerProjects();
      await drain();

      expect(lists(h).length).toBe(before);
    });

    it("does not reload when no project filter was selected", async () => {
      const h = boot();
      await h.ctx.loadComposerProjects();
      h.run(`currentTab = "memories"`);
      const before = lists(h).length;

      await h.ctx.loadComposerProjects();
      await drain();

      expect(lists(h).length).toBe(before);
    });
  });

  it("is sent with a recall, alongside the tag", async () => {
    const h = boot({}, { lenient: true });
    await h.ctx.loadComposerProjects();
    h.ctx.onProjectFilterChange("website");
    await drain();
    h.els.get("recall-input").value = "what did we decide about hosting?";
    await h.ctx.sendRecall();
    const recall = h.calls.find((c) => c.path === "/recall")!;
    expect(recall.body?.project).toBe("website");
  });

  it("does not add project= to a recall when none is chosen", async () => {
    const h = boot({}, { lenient: true });
    h.els.get("recall-input").value = "anything";
    await h.ctx.sendRecall();
    expect(h.calls.find((c) => c.path === "/recall")!.body?.project).toBeUndefined();
  });

  it("clears a project the Worker no longer knows when a recall is refused", async () => {
    const h = boot({ "POST /recall": { status: 404, body: { ok: false, error: 'unknown project "website"', known_projects: [] } } }, { lenient: true });
    await h.ctx.loadComposerProjects();
    h.ctx.onProjectFilterChange("website");
    await drain();
    h.els.get("recall-input").value = "anything";
    await h.ctx.sendRecall();
    expect(h.els.get("project-filter-recall").value).toBe("");
  });
});
