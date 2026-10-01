/**
 * Project detail view: memories through the shared card, the alias editor and
 * its suggestions, rename and description, the on-demand digest, capsule
 * status, and archive / delete.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { PROJECT_ROWS, PROJECT_SCRIPTS, drain, setupProjects, type ProjectRow } from "./_projects-harness";

const ROOT = resolve(import.meta.dirname, "../..");
const HTML = readFileSync(resolve(ROOT, "public/index.html"), "utf8");

const DELETE_BODY = "Memories are kept; only the project grouping is removed.";

const tagsOf = (...t: string[]) => JSON.stringify(t);
const MEMORIES = [
  { id: "m1", content: "Decided on the new hosting plan.", tags: tagsOf("project:website", "work"), created_at: 1000 },
  { id: "m2", content: "Landing copy draft.", tags: tagsOf("landing"), created_at: 900 },
];
const CAPSULE_ENTRIES = [
  { id: "c1", content: "Where things stand.", tags: tagsOf("capsule:project:website", "capsule-slot:current-state", "status:canonical") },
  { id: "c2", content: "A draft decision.", tags: tagsOf("capsule:project:website", "capsule-slot:decisions", "status:draft") },
];

type Row = ProjectRow;

/** A Worker that remembers what was patched or deleted, like the real one. */
function world(over: Record<string, any> = {}, opts: { memories?: any[]; capsule?: any[]; tags?: any } = {}) {
  const rows: Row[] = PROJECT_ROWS.map((r) => ({ ...r, aliases: [...r.aliases] }));
  const routes: Record<string, any> = {
    "GET /projects": () => ({ body: { projects: rows } }),
    "POST /list": (c: any) => ({ body: c.body?.tag?.startsWith("capsule:") ? (opts.capsule ?? CAPSULE_ENTRIES) : (opts.memories ?? MEMORIES) }),
    "GET /tags": () => ({ body: opts.tags ?? ["web", "landing", "cycling", "work", "kind:episodic", "project:website"] }),
    "PATCH /projects/website": (c: any) => {
      const row = rows.find((r) => r.id === "website")!;
      Object.assign(row, c.body);
      return { body: { project: row } };
    },
    "DELETE /projects/website": () => {
      rows.splice(rows.findIndex((r) => r.id === "website"), 1);
      return { body: { ok: true } };
    },
    ...over,
  };
  return { rows, routes };
}

async function open(over: Record<string, any> = {}, o: { teamMode?: boolean; slug?: string; layer?: string; extra?: Record<string, any>; world?: Parameters<typeof world>[1] } = {}) {
  const w = world(over, o.world);
  const h = setupProjects({
    routes: w.routes,
    teamMode: o.teamMode,
    extra: { makeRecentCard: (e: any) => ({ entry: e }), openCapsuleMemory: () => {}, ...(o.extra || {}) },
  });
  await h.ctx.loadProjects();
  await h.ctx.openProject(o.slug ?? "website", o.layer ?? "personal");
  return { ...h, rows: w.rows };
}

const patches = (h: any) => h.calls.filter((c: any) => c.method === "PATCH");
const lists = (h: any) => h.calls.filter((c: any) => c.method === "POST" && c.path === "/list");

describe("opening a project", () => {
  it("swaps the list for the detail view, and back", async () => {
    const h = await open();
    expect(h.els.get("projects-list-view").hidden).toBe(true);
    expect(h.els.get("projects-detail-view").hidden).toBe(false);
    h.ctx.backToProjects();
    expect(h.els.get("projects-list-view").hidden).toBe(false);
    expect(h.els.get("projects-detail-view").hidden).toBe(true);
    expect(HTML).toContain('onclick="backToProjects()"');
  });

  it("moves keyboard focus to the back button, since the pressed row has left the screen", async () => {
    const h = await open();
    expect(h.els.get("project-back-btn").focusCalls).toBeGreaterThan(0);
  });

  it("returns to the list when the Projects tab is pressed again", async () => {
    const w = world();
    const h = setupProjects({
      routes: w.routes,
      scripts: [...PROJECT_SCRIPTS, "public/js/nav.js"],
      extra: { makeRecentCard: (e: any) => ({ entry: e }) },
    });
    h.ctx.switchTab("projects");
    await drain();
    await h.ctx.openProject("website", "personal");
    expect(h.els.get("projects-detail-view").hidden).toBe(false);
    h.ctx.switchTab("projects");
    expect(h.els.get("projects-detail-view").hidden).toBe(true);
    expect(h.els.get("projects-list-view").hidden).toBe(false);
  });

  it("does nothing for a project it does not know", async () => {
    const h = await open({}, { slug: "ghost" });
    expect(h.els.get("projects-detail-view").hidden).toBe(true);
  });

  it("names the project in the header, with its slug and full description", async () => {
    const h = await open();
    const head = h.els.get("project-head").innerHTML as string;
    expect(head).toContain("Website relaunch");
    expect(head).toContain("website");
    expect(head).toContain("Marketing site and docs.");
    expect(head).toContain("Second line.");
  });

  it("marks an archived project as such", async () => {
    const h = await open({}, { slug: "old-app" });
    expect(h.els.get("project-head").innerHTML).toContain("Archived");
    expect(h.els.get("project-archive-btn").textContent).toContain("Restore project");
  });

  it("escapes the name and description", async () => {
    const w = world();
    w.rows[0].name = "<img src=x onerror=1>";
    w.rows[0].description = "<script>x()</script>";
    const h = setupProjects({ routes: w.routes, extra: { makeRecentCard: (e: any) => ({ entry: e }) } });
    await h.ctx.loadProjects();
    await h.ctx.openProject("website", "personal");
    const head = h.els.get("project-head").innerHTML as string;
    expect(head).not.toContain("<img");
    expect(head).not.toContain("<script>");
  });
});

describe("memories", () => {
  it("asks for the project's memories with project=, and no workspace on a solo brain", async () => {
    const h = await open();
    const scan = lists(h).find((c: any) => c.body?.project === "website")!;
    expect(scan.body?.n).toBe(50);
    expect(scan.body?.workspace).toBeUndefined();
    expect(scan.body?.tag).toBeUndefined();
  });

  it("scopes the request to the project's workspace on a team brain", async () => {
    const h = await open({}, { teamMode: true, slug: "website", layer: "personal" });
    const scan = lists(h).find((c: any) => c.body?.project === "website")!;
    expect(scan.body?.workspace).toBe("personal");
  });

  it("renders each memory through the shared card", async () => {
    const h = await open();
    const box = h.els.get("project-memories");
    expect(box.children.map((c: any) => c.entry.id)).toEqual(["m1", "m2"]);
  });

  it("explains an empty project and points at aliases", async () => {
    const h = await open({}, { world: { memories: [] } });
    expect(h.els.get("project-memories").innerHTML).toContain("Nothing filed here yet");
    expect(h.els.get("project-memories").children).toHaveLength(0);
  });

  it("says so when the memories cannot be loaded", async () => {
    const h = await open({ "POST /list": (c: any) => (c.body?.project ? { status: 500, body: {} } : { body: [] }) });
    expect(h.els.get("project-memories").innerHTML).toContain("Could not load memories");
  });

  it("notes when only the latest slice is shown", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, content: "x", tags: tagsOf("project:website"), created_at: i }));
    const h = await open({}, { world: { memories: many } });
    expect(h.els.get("project-memories-note").hidden).toBe(false);
    expect(h.els.get("project-memories-note").textContent).toContain("latest 50");
  });
});

describe("aliases", () => {
  it("lists the current aliases as removable chips", async () => {
    const h = await open();
    const html = h.els.get("project-aliases").innerHTML as string;
    expect(html).toContain("web");
    expect(html).toContain("landing");
    expect(html).toContain("removeProjectAlias('web')");
    expect(html).toContain("Remove alias web");
  });

  it("says there are none, in a line rather than an empty box", async () => {
    const h = await open({}, { slug: "trip-rome", layer: "company" });
    expect(h.els.get("project-aliases").innerHTML).toContain("No aliases yet");
  });

  it("adds an alias with a partial PATCH and refreshes the chips and the memories", async () => {
    const h = await open();
    h.els.get("project-alias-input").value = "  #Cycling ";
    const before = lists(h).length;
    await h.ctx.addProjectAlias();
    expect(patches(h)).toHaveLength(1);
    expect(patches(h)[0].body).toEqual({ aliases: ["web", "landing", "cycling"] });
    expect(patches(h)[0].path).toBe("/projects/website");
    expect(h.els.get("project-aliases").innerHTML).toContain("cycling");
    expect(h.els.get("project-alias-input").value).toBe("");
    // The OR-group changed, so the memories that belong here did too.
    expect(lists(h).length).toBeGreaterThan(before);
  });

  it("adds from a suggestion chip without touching the input", async () => {
    const h = await open();
    await h.ctx.addProjectAlias("work");
    expect(patches(h)[0].body).toEqual({ aliases: ["web", "landing", "work"] });
  });

  it("passes the row's workspace on a team brain only", async () => {
    const team = await open({}, { teamMode: true });
    await team.ctx.addProjectAlias("work");
    expect(patches(team)[0].query.get("workspace")).toBe("personal");
    const solo = await open();
    await solo.ctx.addProjectAlias("work");
    expect(patches(solo)[0].query.has("workspace")).toBe(false);
  });

  it("ignores a duplicate and an empty entry", async () => {
    const h = await open();
    await h.ctx.addProjectAlias("web");
    await h.ctx.addProjectAlias("   ");
    expect(patches(h)).toHaveLength(0);
  });

  it("refuses reserved tags before the Worker has to", async () => {
    const h = await open();
    for (const bad of ["kind:episodic", "project:other", "status:canonical", "capsule:core"]) {
      h.els.get("project-alias-input").value = bad;
      await h.ctx.addProjectAlias();
    }
    expect(patches(h)).toHaveLength(0);
    expect(h.els.get("project-alias-error").hidden).toBe(false);
    expect(h.els.get("project-alias-error").textContent).toContain("plain tag");
  });

  it("stops at sixteen", async () => {
    const w = world();
    w.rows[0].aliases = Array.from({ length: 16 }, (_, i) => `t${i}`);
    const h = setupProjects({ routes: w.routes, extra: { makeRecentCard: (e: any) => ({ entry: e }) } });
    await h.ctx.loadProjects();
    await h.ctx.openProject("website", "personal");
    await h.ctx.addProjectAlias("extra");
    expect(h.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(h.els.get("project-alias-error").textContent).toContain("16");
  });

  it("removes an alias with a partial PATCH", async () => {
    const h = await open();
    await h.ctx.removeProjectAlias("web");
    expect(patches(h)[0].body).toEqual({ aliases: ["landing"] });
    expect(h.els.get("project-aliases").innerHTML).not.toContain("removeProjectAlias('web')");
  });

  it("keeps the chips as they were and says why when the Worker refuses", async () => {
    const h = await open({ "PATCH /projects/website": { status: 400, body: { error: "alias not allowed" } } });
    await h.ctx.addProjectAlias("work");
    expect(h.els.get("project-alias-error").textContent).toContain("alias not allowed");
    expect(h.els.get("project-aliases").innerHTML).not.toContain("removeProjectAlias('work')");
  });

  it("falls back to a plain message when the network fails", async () => {
    const h = await open({ "PATCH /projects/website": () => { throw new Error("offline"); } });
    await h.ctx.addProjectAlias("work");
    expect(h.els.get("project-alias-error").textContent).toContain("Could not update aliases");
  });
});

describe("alias suggestions", () => {
  const html = (h: any) => h.els.get("project-alias-suggest").innerHTML as string;

  it("come from the tag vocabulary, minus what the brain writes itself and what is already an alias", async () => {
    const h = await open();
    const out = html(h);
    expect(out).toContain("addProjectAlias('work')");
    expect(out).toContain("addProjectAlias('cycling')");
    expect(out).not.toContain("'web'");
    expect(out).not.toContain("'landing'");
    expect(out).not.toContain("kind:episodic");
    expect(out).not.toContain("project:website");
  });

  it("show a count per tag, most used first, from the brief's topics", async () => {
    const h = await open({}, { extra: { briefData: { topics: [{ tag: "cycling", count: 14 }, { tag: "work", count: 40 }] } } });
    const out = html(h);
    expect(out.indexOf("addProjectAlias('work')")).toBeLessThan(out.indexOf("addProjectAlias('cycling')"));
    expect(out).toMatch(/work[\s\S]*?>40</);
    expect(out).toMatch(/cycling[\s\S]*?>14</);
  });

  it("prefer counts the Worker sends with the vocabulary itself", async () => {
    const h = await open({}, { world: { tags: [{ tag: "cycling", count: 3 }, { tag: "zen", count: 9 }, { tag: "plain" }] }, extra: { briefData: { topics: [{ tag: "cycling", count: 99 }] } } });
    const out = html(h);
    expect(out).toMatch(/cycling[\s\S]*?>3</);
    expect(out.indexOf("addProjectAlias('zen')")).toBeLessThan(out.indexOf("addProjectAlias('cycling')"));
    // No count known: shown, without a number.
    expect(out).toContain("addProjectAlias('plain')");
  });

  it("mark the counts as lower bounds when the Worker says the tally was capped", async () => {
    const tags = [{ tag: "cycling", count: 3 }, { tag: "zen", count: 9 }, { tag: "plain" }];
    const h = await open({ "GET /tags": { body: tags, headers: { "X-Counts-Approximate": "1" } } });
    const out = html(h);
    expect(out).toMatch(/cycling[\s\S]*?>3\+</);
    expect(out).toMatch(/zen[\s\S]*?>9\+</);
    // Still no number where none is known.
    expect(out).toMatch(/plain<\/button>/);
  });

  it("leave the counts exact when the header is absent", async () => {
    const h = await open({ "GET /tags": { body: [{ tag: "cycling", count: 3 }] } });
    expect(html(h)).toMatch(/cycling[\s\S]*?>3</);
    expect(html(h)).not.toContain("3+");
  });

  it("narrow as the alias is typed", async () => {
    const h = await open();
    h.els.get("project-alias-input").value = "cyc";
    h.ctx.onProjectAliasInput();
    expect(html(h)).toContain("addProjectAlias('cycling')");
    expect(html(h)).not.toContain("addProjectAlias('work')");
  });

  it("are capped, so a large vocabulary stays a hint rather than a wall", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${String(i).padStart(2, "0")}`);
    const h = await open({}, { world: { tags: many } });
    expect(html(h).match(/addProjectAlias\(/g)).toHaveLength(12);
  });

  it("stay quiet when the vocabulary cannot be loaded", async () => {
    const h = await open({ "GET /tags": { status: 500, body: {} } });
    expect(html(h)).toBe("");
    expect(h.els.get("project-aliases").innerHTML).toContain("web");
  });
});

describe("rename and description", () => {
  it("prefills from the project and holds Save until something changes", async () => {
    const h = await open();
    expect(h.els.get("project-edit-name").value).toBe("Website relaunch");
    expect(h.els.get("project-edit-desc").value).toContain("Second line.");
    expect(h.els.get("project-save-btn").disabled).toBe(true);
    h.els.get("project-edit-name").value = "Website v2";
    h.ctx.onProjectEditInput();
    expect(h.els.get("project-save-btn").disabled).toBe(false);
    h.els.get("project-edit-name").value = "Website relaunch";
    h.ctx.onProjectEditInput();
    expect(h.els.get("project-save-btn").disabled).toBe(true);
  });

  it("will not save an empty name", async () => {
    const h = await open();
    h.els.get("project-edit-name").value = "   ";
    h.ctx.onProjectEditInput();
    expect(h.els.get("project-save-btn").disabled).toBe(true);
  });

  it("sends only what changed, then updates the header and the list", async () => {
    const h = await open();
    h.els.get("project-edit-name").value = " Website v2 ";
    h.ctx.onProjectEditInput();
    await h.ctx.saveProjectDetails();
    expect(patches(h)[0].body).toEqual({ name: "Website v2" });
    expect(h.els.get("project-head").innerHTML).toContain("Website v2");
    expect(h.toastHtml()).toContain("Project updated");
    expect(h.els.get("project-save-btn").disabled).toBe(true);
    h.ctx.backToProjects();
    expect(h.els.get("projects-list").innerHTML).toContain("Website v2");
  });

  it("can clear the description", async () => {
    const h = await open();
    h.els.get("project-edit-desc").value = "";
    h.ctx.onProjectEditInput();
    await h.ctx.saveProjectDetails();
    expect(patches(h)[0].body).toEqual({ description: "" });
  });

  it("keeps the edit and explains when saving fails", async () => {
    const h = await open({ "PATCH /projects/website": { status: 400, body: { error: "name too long" } } });
    h.els.get("project-edit-name").value = "Nope";
    h.ctx.onProjectEditInput();
    await h.ctx.saveProjectDetails();
    expect(h.els.get("project-edit-error").textContent).toContain("name too long");
    expect(h.els.get("project-edit-name").value).toBe("Nope");
    expect(h.els.get("project-save-btn").disabled).toBe(false);
  });
});

describe("digest", () => {
  it("is never run on opening: it writes a memory", async () => {
    const h = await open();
    expect(h.calls.some((c) => c.path === "/digest")).toBe(false);
    expect(HTML).toContain('onclick="runProjectDigest()"');
  });

  it("asks the Worker for the project's digest and shows the result", async () => {
    const h = await open({ "POST /digest": { body: { project: "website", synthesis: "The site moves to a new host.", entry_id: "d1", source_count: 25 } } });
    await h.ctx.runProjectDigest();
    const call = h.calls.find((c) => c.path === "/digest")!;
    expect(call.body?.project).toBe("website");
    expect(call.body?.tag).toBeUndefined();
    const out = h.els.get("project-digest-result").innerHTML as string;
    expect(out).toContain("The site moves to a new host.");
    expect(out).toContain("25 original memories preserved");
  });

  it("reloads the memories, since the digest lands inside the project", async () => {
    const h = await open({ "POST /digest": { body: { synthesis: "x", source_count: 20 } } });
    const before = lists(h).length;
    await h.ctx.runProjectDigest();
    expect(lists(h).length).toBeGreaterThan(before);
  });

  it("scopes to the workspace on a team brain", async () => {
    const h = await open({ "POST /digest": { body: { synthesis: "x", source_count: 20 } } }, { teamMode: true });
    await h.ctx.runProjectDigest();
    expect(h.calls.find((c) => c.path === "/digest")!.body?.workspace).toBe("personal");
  });

  it("shows the Worker's reason when there is nothing to digest yet", async () => {
    const h = await open({ "POST /digest": { body: { error: "Could not create digest: fewer than 20 entries", source_count: 3 } } });
    await h.ctx.runProjectDigest();
    expect(h.els.get("project-digest-result").innerHTML).toContain("fewer than 20 entries");
    expect(h.els.get("project-digest-btn").disabled).toBe(false);
  });

  it("reports a network failure and lets the user retry", async () => {
    const h = await open({ "POST /digest": () => { throw new Error("offline"); } });
    await h.ctx.runProjectDigest();
    expect(h.els.get("project-digest-result").innerHTML).toContain("Request failed");
    expect(h.els.get("project-digest-btn").disabled).toBe(false);
  });

  it("holds the button down while it works", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = await open({ "POST /digest": () => ({ body: { synthesis: "x", source_count: 20 } }) });
    const real = h.ctx.fetch;
    h.ctx.fetch = async (u: string, i: any) => {
      if (String(u).includes("/digest")) await gate;
      return real(u, i);
    };
    const run = h.ctx.runProjectDigest();
    expect(h.els.get("project-digest-btn").disabled).toBe(true);
    void h.ctx.runProjectDigest();
    release();
    await run;
    expect(h.calls.filter((c) => c.path === "/digest")).toHaveLength(1);
  });
});

describe("capsule status", () => {
  /** The markup of one slot: each starts at its own opening tag. */
  const slot = (out: string, name: string) => out.split(/(?=<(?:button|div) [^>]*class="slot)/).find((s) => s.includes(name)) ?? "";

  it("shows the three project slots, filled from the capsule memories", async () => {
    const h = await open();
    const out = h.els.get("project-capsule").innerHTML as string;
    expect(out).toContain("Current state");
    expect(out).toContain("Decisions");
    expect(out).toContain("Open questions");
    expect(slot(out, "Current state")).toContain("In the capsule");
    // Only canonical memories count: a draft does not fill its slot.
    expect(slot(out, "Decisions")).toContain("Empty");
    expect(slot(out, "Open questions")).toContain("Empty");
  });

  it("opens the memory behind a filled slot", async () => {
    const h = await open();
    expect(h.els.get("project-capsule").innerHTML).toContain("openCapsuleMemory('c1', this)");
  });

  it("also reads capsule memories the project scan already returned", async () => {
    const inScan = { id: "c9", content: "Q?", tags: tagsOf("project:website", "capsule:project:website", "capsule-slot:open-questions", "status:canonical") };
    const h = await open({}, { world: { memories: [...MEMORIES, inScan], capsule: [] } });
    expect(slot(h.els.get("project-capsule").innerHTML, "Open questions")).toContain("In the capsule");
  });

  it("ignores another project's capsule and a slot it does not have", async () => {
    const other = { id: "x1", content: "z", tags: tagsOf("capsule:project:other", "capsule-slot:decisions", "status:canonical") };
    const wrongSlot = { id: "x2", content: "z", tags: tagsOf("capsule:project:website", "capsule-slot:identity", "status:canonical") };
    const h = await open({}, { world: { capsule: [other, wrongSlot] } });
    expect(h.els.get("project-capsule").innerHTML).not.toContain("In the capsule");
  });

  it("says how to fill one when nothing is set", async () => {
    const h = await open({}, { world: { capsule: [] } });
    expect(h.els.get("project-capsule").innerHTML).toContain("capsule:project:website");
  });

  it("does not fail the whole view when the capsule scan fails", async () => {
    const h = await open({ "POST /list": (c: any) => (c.body?.tag ? { status: 500, body: {} } : { body: MEMORIES }) });
    expect(h.els.get("project-memories").children).toHaveLength(2);
    expect(h.els.get("project-capsule").innerHTML).toContain("Empty");
  });
});

describe("archive", () => {
  it("archives with one PATCH, no confirmation, and offers to undo", async () => {
    const h = await open();
    await h.ctx.toggleProjectArchived();
    expect(patches(h)[0].body).toEqual({ status: "archived" });
    expect(h.els.get("confirm-dialog").classList.contains("open")).toBe(false);
    expect(h.toastHtml()).toContain("Project archived");
    expect(h.toastHtml()).toContain("Undo");
    expect(h.els.get("project-head").innerHTML).toContain("Archived");
    expect(h.els.get("project-archive-btn").textContent).toContain("Restore project");
  });

  it("undoes from the toast", async () => {
    const h = await open();
    await h.ctx.toggleProjectArchived();
    await h.appended[h.appended.length - 1].querySelector(".app-toast-action").onclick();
    expect(patches(h)[1].body).toEqual({ status: "active" });
    expect(h.els.get("project-archive-btn").textContent).toContain("Archive project");
  });

  it("restores an archived project", async () => {
    const h = await open();
    await h.ctx.toggleProjectArchived();
    await h.ctx.toggleProjectArchived();
    expect(patches(h)[1].body).toEqual({ status: "active" });
    expect(h.toastHtml()).toContain("Project restored");
  });

  it("puts the project in the archived section of the list", async () => {
    const h = await open();
    await h.ctx.toggleProjectArchived();
    h.ctx.backToProjects();
    expect(h.els.get("projects-archived-list").innerHTML).toContain("Website relaunch");
    expect(h.els.get("projects-list").innerHTML).not.toContain("Website relaunch");
  });

  it("reports a refusal and leaves the project as it was", async () => {
    const h = await open({ "PATCH /projects/website": { status: 500, body: {} } });
    await h.ctx.toggleProjectArchived();
    expect(h.toastHtml()).toContain("Could not update the project");
    expect(h.els.get("project-head").innerHTML).not.toContain("Archived");
  });
});

describe("delete", () => {
  it("asks first, with the exact reassurance that memories are kept", async () => {
    const h = await open();
    h.ctx.confirmDeleteProject();
    expect(h.els.get("confirm-dialog").classList.contains("open")).toBe(true);
    expect(h.els.get("confirm-body").textContent).toBe(DELETE_BODY);
    expect(h.els.get("confirm-title").textContent).toContain("Website relaunch");
    expect(h.els.get("confirm-accept-btn").textContent).toBe("Delete project");
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(HTML).toContain('onclick="confirmDeleteProject()"');
  });

  it("deletes the registry row on confirm, then returns to a list without it", async () => {
    const h = await open();
    h.ctx.confirmDeleteProject();
    await h.ctx.runConfirmAction();
    const del = h.calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/projects/website");
    expect(del.query.has("workspace")).toBe(false);
    expect(h.els.get("confirm-dialog").classList.contains("open")).toBe(false);
    expect(h.toastHtml()).toContain("Project deleted");
    expect(h.els.get("projects-detail-view").hidden).toBe(true);
    expect(h.els.get("projects-list").innerHTML).not.toContain("Website relaunch");
  });

  it("scopes to the workspace on a team brain", async () => {
    const h = await open({}, { teamMode: true });
    h.ctx.confirmDeleteProject();
    await h.ctx.runConfirmAction();
    expect(h.calls.find((c) => c.method === "DELETE")!.query.get("workspace")).toBe("personal");
  });

  it("stays on the project and says so when the Worker refuses", async () => {
    const h = await open({ "DELETE /projects/website": { status: 500, body: {} } });
    h.ctx.confirmDeleteProject();
    await h.ctx.runConfirmAction();
    expect(h.toastHtml()).toContain("Could not delete the project");
    expect(h.els.get("projects-detail-view").hidden).toBe(false);
  });

  it("never reaches for the native dialog", async () => {
    const h = await open();
    expect(() => h.ctx.confirmDeleteProject()).not.toThrow();
  });
});

describe("refreshing while a project is open", () => {
  it("reloads its memories, and does nothing when none is open", async () => {
    const h = await open();
    const before = lists(h).length;
    await h.ctx.refreshProjectDetail();
    expect(lists(h).length).toBeGreaterThan(before);
    h.ctx.backToProjects();
    const after = lists(h).length;
    await h.ctx.refreshProjectDetail();
    expect(lists(h).length).toBe(after);
  });
});
