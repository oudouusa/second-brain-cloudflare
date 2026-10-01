/**
 * Track 2 Task D3 (T-0101.6.1, spec 14 section 7.6, SH-5): validity labels
 * on the sheet, cards, recall results, the Wrong toast and the graph.
 *
 * Fixture shapes are not invented: they were captured by seeding a real
 * contradiction, retraction and explicit end date through the real write
 * path (captureEntry, POST /status, POST /update against a real SQLite-backed
 * D1, per test/integration/supersede.test.ts and recall-validity.test.ts's
 * own harness) and reading GET /entry, GET /list and POST /status's real
 * response JSON. See the six-field contract in src/recall/validity-view.ts.
 *
 * Two backend gaps were found and reported here as failing tests, then fixed on v4/t2-d1
 * (T-0089.2.3, merged 48d628f8): GET /stale's `reason` (not_confirmed | date_passed |
 * retracted_source) and `valid_until`, and history.items' `cause`/`by`/`until` on a
 * reason:"validity" row. The tests below now assert the real, landed shapes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl(tag = "div") {
  const kids: any[] = [];
  const children = new Map<string, any>();
  const el: any = {
    tag,
    id: "",
    className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {} as Record<string, string>,
    disabled: false,
    hidden: false,
    title: "",
    value: "",
    textContent: "",
    onclick: null,
    attrs: {} as Record<string, string>,
    kids,
    dataset: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      el.attrs[k] = String(v);
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    removeAttribute(k: string) {
      delete el.attrs[k];
    },
    addEventListener() {},
    appendChild(c: any) {
      kids.push(c);
      return c;
    },
    remove() {},
    focus() {},
    closest: () => null,
    querySelector(sel: string) {
      if (!children.has(sel)) children.set(sel, makeEl("button"));
      return children.get(sel);
    },
    querySelectorAll: () => [],
  };
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set(v: string) {
      html = String(v);
      kids.length = 0;
    },
  });
  return el;
}

function baseCtx() {
  const els = new Map<string, any>();
  const toasts: Array<{ message: string; opts?: any }> = [];
  const requests: Array<{ url: string; init: any }> = [];
  const opened: any[] = [];
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    TEAM_MODE: false,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: "en-US" },
    URLSearchParams,
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
    document: {
      documentElement: { lang: "en" },
      getElementById(id: string) {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: (tag: string) => makeEl(tag),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { appendChild() {} },
    },
    showToast: (message: string, opts?: any) => {
      toasts.push({ message, opts });
    },
    openView: (...args: any[]) => opened.push(args),
    fetch: async (url: string, init: any) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, entry: { id: "x", content: "", tags: [] } }) };
    },
  };
  ctx.__stubShowToast = ctx.showToast;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  ctx.__els = els;
  ctx.__toasts = toasts;
  ctx.__requests = requests;
  ctx.__opened = opened;
  return ctx;
}

function run(ctx: any, files: string[]) {
  for (const f of files) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  vm.runInContext('WORKER_URL = "https://example.test"; AUTH_TOKEN = "t";', ctx);
  if (typeof ctx.applyCardAuthorLock !== "function") ctx.applyCardAuthorLock = () => false;
  ctx.showToast = ctx.__stubShowToast;
}

const el = (ctx: any, id: string) => ctx.__els.get(id);

// ---- Real-write-path fixtures (captured JSON, field order kept as returned) ----

/** GET /entry?id=denver after Austin (valid_from June) supersedes it. */
const REPLACED_ENTRY = {
  id: "denver",
  content: "Lives in Denver",
  tags: [],
  valid_from: 1000,
  valid_from_stated: false,
  valid_until: 1790000000000,
  validity_state: "replaced",
  superseded_by: { id: "austin-id", preview: "Lives in Austin" },
  retracted_source: false,
};

/** A currently-valid memory with a stated start (captureEntry's validFrom option). */
const CURRENT_STATED_ENTRY = {
  id: "austin-id",
  content: "Lives in Austin",
  tags: [],
  valid_from: 1790000000000,
  valid_from_stated: true,
  valid_until: null,
  validity_state: "current",
  superseded_by: null,
  retracted_source: false,
};

/** POST /update {valid_until} with no replacement: GET /entry after. */
const ENDED_ENTRY = {
  id: "ended-id",
  content: "Working on the Q3 report",
  tags: [],
  valid_from: 1790632092984,
  valid_from_stated: false,
  valid_until: 1790812800000,
  validity_state: "ended",
  superseded_by: null,
  retracted_source: false,
};

/** A memory whose source insight was later retracted. */
const RETRACTED_SOURCE_ENTRY = {
  id: "flagged-id",
  content: "Built on the Austin decision",
  tags: ["retracted-source"],
  valid_from: 500,
  valid_from_stated: false,
  valid_until: null,
  validity_state: "current",
  superseded_by: null,
  retracted_source: true,
};

/** POST /status {status:"deprecated"} response, real shape (validity.ts's applyStatus). */
const STATUS_RESTORED_ONE = {
  ok: true,
  id: "austin-id",
  status: "deprecated",
  indexed: false,
  validity: { restored: [{ id: "denver", preview: "Lives in Denver" }], reclosed: [], flagged: 0, unflagged: 0 },
};
const STATUS_RESTORED_MANY = {
  ok: true,
  id: "x",
  status: "deprecated",
  indexed: true,
  validity: {
    restored: [
      { id: "a", preview: "one" },
      { id: "b", preview: "two" },
    ],
    reclosed: [],
    flagged: 2,
    unflagged: 0,
  },
};

const MEMORY_CRUD_FILES = ["public/utils.js", "public/js/state.js", "public/js/toast.js", "public/js/undo.js", "public/js/memory-crud.js"];

// SH-5 (spec 13): the validity story lives in #view-status-caption, the ALWAYS-shown status
// line (renderViewStatus defaults an untagged entry to "canonical") — not view-brain's optional
// Status row, which only appears when an explicit status: tag exists. Most real memories carry
// no status tag at all, so the caption is what "never a bare Trusted" actually depends on; a
// real screenshot of a status:-tagless replaced memory (T-0101.6.1_sheet-replaced_after) is what
// caught this the first time (view-brain rendered nothing, and the caption still read the plain
// "Confirmed. Search often prefers it…" text).
describe("a replaced memory shows True from … until …, Replaced by with a link, and never a bare Trusted", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    return ctx;
  }

  it("status caption reads True from … until …, plus a Replaced by link naming the replacement — even with no status: tag at all", () => {
    const ctx = load();
    ctx.renderViewStatus({ ...REPLACED_ENTRY, tags: [] });
    const html = el(ctx, "view-status-caption").innerHTML as string;
    expect(html).toContain("True from");
    expect(html).toContain("until");
    expect(html).not.toContain("Confirmed. Search");
    expect(html).toContain("Replaced by");
    expect(html).toContain("Lives in Austin");
    expect(html).toMatch(/<a[^>]*>[^<]*Replaced by[^<]*Lives in Austin[^<]*<\/a>/);
  });

  it("the same holds with an explicit status:canonical tag", () => {
    const ctx = load();
    ctx.renderViewStatus({ ...REPLACED_ENTRY, tags: ["status:canonical"] });
    const html = el(ctx, "view-status-caption").innerHTML as string;
    expect(html).toContain("True from");
    expect(html).toContain("Replaced by");
  });

  it("the link opens the replacement's own sheet", () => {
    const ctx = load();
    ctx.renderViewStatus({ ...REPLACED_ENTRY, tags: [] });
    const html = el(ctx, "view-status-caption").innerHTML as string;
    expect(html).toMatch(/onclick="openValidityLink\('austin-id'\)/);
    ctx.openValidityLink("austin-id");
    return new Promise((r) => setTimeout(r, 0)).then(() => {
      expect(ctx.__requests.some((req: any) => req.url.includes("austin-id"))).toBe(true);
    });
  });

  it("a current memory with a stated start shows True since, not a bare Trusted", () => {
    const ctx = load();
    ctx.renderViewStatus({ ...CURRENT_STATED_ENTRY, tags: [] });
    const html = el(ctx, "view-status-caption").innerHTML as string;
    expect(html).toContain("True since");
    expect(html).not.toContain("Confirmed. Search");
  });

  it("a plain current memory with no stated start still shows the ordinary status help line", () => {
    const ctx = load();
    ctx.renderViewStatus({ id: "m1", content: "x", tags: [], valid_from: 1000, valid_from_stated: false, valid_until: null, validity_state: "current", superseded_by: null, retracted_source: false });
    expect(el(ctx, "view-status-caption").textContent).toContain("Confirmed");
  });

  it("Wrong keeps its own caption, not a validity line", () => {
    const ctx = load();
    ctx.renderViewStatus({ id: "m1", content: "x", tags: ["status:deprecated"], valid_from: 1000, valid_from_stated: false, valid_until: null, validity_state: "wrong", superseded_by: null, retracted_source: false });
    expect(el(ctx, "view-status-caption").textContent).not.toContain("True");
  });
});

describe("an ended memory shows No longer true since", () => {
  it("status caption reads No longer true since {date}, with no status: tag", () => {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    ctx.renderViewStatus({ ...ENDED_ENTRY, tags: [] });
    const html = el(ctx, "view-status-caption").innerHTML as string;
    expect(html).toContain("No longer true since");
    expect(html).not.toContain("Confirmed. Search");
  });
});

describe("a retracted-source memory shows its label", () => {
  it("renders the retracted-source note regardless of validity state", () => {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    ctx.renderViewStatus({ ...RETRACTED_SOURCE_ENTRY, tags: [] });
    const html = el(ctx, "view-status-caption").innerHTML as string;
    expect(html).toContain("Based on a memory later marked Wrong");
  });
});

describe("cards show Replaced, Ended and Check chips", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js"]);
    return ctx;
  }
  const asCard = (entry: any) => ({ ...entry, tags: JSON.stringify(entry.tags), created_at: Date.now(), source: "web" });

  it("a replaced row shows the Replaced chip", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(REPLACED_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--replaced");
    expect(card.innerHTML).toContain("Replaced");
  });

  it("an ended row shows the Ended chip", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(ENDED_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--ended");
    expect(card.innerHTML).toContain("No longer true");
  });

  it("a retracted-source row shows the Check chip, taking priority over its own state", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(RETRACTED_SOURCE_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--check");
    expect(card.innerHTML).toContain("Needs a check");
  });

  it("a plain current row shows no validity chip", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(CURRENT_STATED_ENTRY));
    expect(card.innerHTML).not.toContain("validity-chip");
  });

  // Copywriter flag: card-chips_after.mobile.en showed a raw retracted-source tag chip
  // next to Check - the same fact said twice, once unreadably.
  it("hides the raw retracted-source tag as a system tag, since the Check chip already says it", () => {
    const ctx = load();
    const card = ctx.makeRecentCard(asCard(RETRACTED_SOURCE_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--check");
    expect(card.innerHTML).not.toContain(">retracted-source<");
  });

  // UI review round 4: a card-chips screenshot showed a lone clock icon with no visible
  // text (vec-chip--pending, a pre-existing not-yet-indexed indicator, unrelated to
  // T-0101.6.1's own chips but flagged on the same shot) - it already had a title tooltip
  // from an existing deck string, but no accessible name for a screen reader.
  it("the pre-existing vectorize-pending chip has an accessible name, not just a title tooltip", () => {
    const ctx = load();
    // Pending is computed at render time from recency and an empty vector_ids - a card this
    // fresh with nothing indexed yet, the same state a just-seeded entry is in.
    const card = ctx.makeRecentCard(asCard({ ...CURRENT_STATED_ENTRY, vector_ids: undefined }));
    expect(card.innerHTML).toMatch(/vec-chip--pending[^>]*aria-label="Getting it ready for search/);
  });
});

describe("Wrong's toast names the restored memory, or counts several, and says how many were flagged", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    return ctx;
  }

  it("names the single restored memory", () => {
    const ctx = load();
    const msg = ctx.validityRestoredToastMessage(STATUS_RESTORED_ONE.validity);
    expect(msg).toBe('Marked as wrong. "Lives in Denver" is current again.');
  });

  it("counts several restored memories and appends the flagged count", () => {
    const ctx = load();
    const msg = ctx.validityRestoredToastMessage(STATUS_RESTORED_MANY.validity);
    expect(msg).toContain("2 older memories are current again");
    expect(msg).toContain("2 memories based on it now need a check");
  });

  it("returns null when nothing was restored or flagged (an ordinary status change)", () => {
    const ctx = load();
    expect(ctx.validityRestoredToastMessage({ restored: [], reclosed: [], flagged: 0, unflagged: 0 })).toBe(null);
    expect(ctx.validityRestoredToastMessage(undefined)).toBe(null);
  });
});

describe("both locales, no em dash", () => {
  it("Italian: replaced, ended and the toast", () => {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    ctx.initI18n("it");
    ctx.renderViewStatus({ ...REPLACED_ENTRY, tags: [] });
    const html = el(ctx, "view-status-caption").innerHTML as string;
    expect(html).toContain("Valido dal");
    expect(html).toContain("Sostituito da");
    expect(ctx.validityRestoredToastMessage(STATUS_RESTORED_ONE.validity)).toBe(
      'Segnato come errato. «Lives in Denver» è di nuovo valido.',
    );
    expect(html).not.toContain("—");
  });
});

describe("history rows for a validity cause read as a sentence, not a raw reason string", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/history-view.js"]);
    return ctx;
  }

  it("a reason:'validity' row with no recognized cause falls back to the generic label", () => {
    const ctx = load();
    const label = ctx.historyReasonLabel({ reason: "validity", kind: "change" }, 0, [], { tags: [] }, new Map());
    expect(label).toBe("Validity changed");
    expect(label).not.toBe("validity");
  });

  // T-0089.2.3 (merged 48d628f8): history.items now carries cause/by/until on a
  // reason:"validity" row, matching src/memory/validity.ts's five real cause values.
  it("cause supersede: Replaced by {preview} (true until {until})", () => {
    const ctx = load();
    const item = { reason: "validity", kind: "change", cause: "supersede", by: "austin-id", until: 1790000000000 };
    const label = ctx.historyReasonLabel(item, 0, [item], { tags: [] }, new Map([["austin-id", "Lives in Austin"]]));
    expect(label).toContain("Replaced by Lives in Austin");
    expect(label).toContain("true until");
  });

  it("cause retraction, by resolves: Current again: {preview} was marked wrong", () => {
    const ctx = load();
    const item = { reason: "validity", kind: "change", cause: "retraction", by: "wrong-id", until: null };
    const label = ctx.historyReasonLabel(item, 0, [item], { tags: [] }, new Map([["wrong-id", "Lives in Austin"]]));
    expect(label).toBe("Current again: Lives in Austin was marked wrong");
  });

  it("cause retraction, by no longer resolves: the forgotten variant", () => {
    const ctx = load();
    const item = { reason: "validity", kind: "change", cause: "retraction", by: "gone-id", until: null };
    const label = ctx.historyReasonLabel(item, 0, [item], { tags: [] }, new Map([["gone-id", null]]));
    expect(label).toBe("Current again: the memory that replaced it was forgotten");
  });

  it("cause unretraction: Replaced again by {preview}", () => {
    const ctx = load();
    const item = { reason: "validity", kind: "change", cause: "unretraction", by: "priya-id", until: 1790000000000 };
    const label = ctx.historyReasonLabel(item, 0, [item], { tags: [] }, new Map([["priya-id", "Priya is running it now"]]));
    expect(label).toBe("Replaced again by Priya is running it now");
  });

  it("cause explicit: End date set to {until}, no preview needed", () => {
    const ctx = load();
    const item = { reason: "validity", kind: "change", cause: "explicit", by: null, until: 1790000000000 };
    const label = ctx.historyReasonLabel(item, 0, [item], { tags: [] }, new Map());
    expect(label).toContain("End date set to");
  });

  it("cause propagate: End date moved to {until} to match {preview}", () => {
    const ctx = load();
    const item = { reason: "validity", kind: "change", cause: "propagate", by: "other-id", until: 1790000000000 };
    const label = ctx.historyReasonLabel(item, 0, [item], { tags: [] }, new Map([["other-id", "Some other memory"]]));
    expect(label).toContain("End date moved to");
    expect(label).toContain("Some other memory");
  });

  it("collectValidityPreviews resolves a by id matching entry.superseded_by without a fetch", () => {
    const ctx = load();
    return ctx
      .collectValidityPreviews(
        [{ kind: "change", reason: "validity", cause: "supersede", by: "austin-id", until: 1 }],
        { superseded_by: { id: "austin-id", preview: "Lives in Austin" } },
      )
      .then((map: Map<string, string | null>) => {
        expect(map.get("austin-id")).toBe("Lives in Austin");
        expect(ctx.__requests).toHaveLength(0);
      });
  });

  it("collectValidityPreviews fetches a by id that isn't the entry's own superseded_by", () => {
    const ctx = load();
    return ctx
      .collectValidityPreviews(
        [{ kind: "change", reason: "validity", cause: "retraction", by: "some-other-id", until: null }],
        { superseded_by: null },
      )
      .then((map: Map<string, string | null>) => {
        expect(ctx.__requests.some((r: any) => r.url.includes("some-other-id"))).toBe(true);
        expect(map.has("some-other-id")).toBe(true);
      });
  });

  // Copywriter flag: one validity write lands both an entry_events row (validity_changed,
  // "Dates updated") and its own change row ("End date set to ..."), since the server's own
  // EVENTS_SUPERSEDED_BY_VERSIONS list does not name the three validity event names.
  describe("dedupeValidityEventRows: one row per validity write", () => {
    it("drops a validity_changed/superseded/flagged event within a second of its own change row", () => {
      const ctx = load();
      const items = [
        { kind: "event", event: "validity_changed", at: 1000 },
        { kind: "change", reason: "validity", cause: "explicit", at: 1000, until: 2000 },
        { kind: "event", event: "superseded", at: 5000 },
        { kind: "change", reason: "validity", cause: "supersede", at: 5040, until: 2000, by: "x" },
        { kind: "event", event: "updated", at: 9000 },
      ];
      const deduped = ctx.dedupeValidityEventRows(items);
      expect(deduped.filter((i: any) => i.kind === "event" && i.event === "validity_changed")).toHaveLength(0);
      expect(deduped.filter((i: any) => i.kind === "event" && i.event === "superseded")).toHaveLength(0);
      // An ordinary event with no nearby validity change row is untouched.
      expect(deduped.some((i: any) => i.event === "updated")).toBe(true);
      expect(deduped.filter((i: any) => i.kind === "change")).toHaveLength(2);
    });

    it("keeps a validity event when no change row sits near it (a Worker sending only entry.timeline)", () => {
      const ctx = load();
      const items = [{ kind: "event", event: "flagged", at: 1000 }];
      expect(ctx.dedupeValidityEventRows(items)).toHaveLength(1);
    });
  });
});

describe("the graph dims superseded and ended nodes, not just wrong ones", () => {
  function load() {
    const ctx = baseCtx();
    // graph-canvas.js touches window/document at load time for its own setup;
    // isDimmedGraphNode is a pure function defined at module scope, so loading
    // just for the function is enough here.
    run(ctx, ["public/js/graph-canvas.js"]);
    return ctx;
  }

  it("dims a wrong node (existing behavior, unchanged)", () => {
    const ctx = load();
    expect(ctx.isDimmedGraphNode({ status: 'deprecated', validUntil: null })).toBe(true);
  });

  it("dims a node with a closed validity window, replaced or merely ended", () => {
    const ctx = load();
    expect(ctx.isDimmedGraphNode({ status: 'canonical', validUntil: 1790000000000 })).toBe(true);
  });

  it("leaves a current node undimmed", () => {
    const ctx = load();
    expect(ctx.isDimmedGraphNode({ status: 'canonical', validUntil: null })).toBe(false);
  });
});

describe("recall cards carry validity chips and a stated-start label", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js", "public/js/recall.js"]);
    return ctx;
  }
  const asRecallEntry = (entry: any) => ({ ...entry, tags: entry.tags, score: 80, hop: 0, created_at: Date.now() });

  it("a replaced recall result shows the Replaced chip", () => {
    const ctx = load();
    const card = ctx.makeRecallCard(asRecallEntry(REPLACED_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--replaced");
  });

  it("a currently-true result with a stated start shows True since", () => {
    const ctx = load();
    const card = ctx.makeRecallCard(asRecallEntry(CURRENT_STATED_ENTRY));
    expect(card.innerHTML).toContain("True since");
  });

  it("a retracted-source result shows the Check chip and names what the check is about", () => {
    const ctx = load();
    const card = ctx.makeRecallCard(asRecallEntry(RETRACTED_SOURCE_ENTRY));
    expect(card.innerHTML).toContain("validity-chip--check");
    // UI review round 3: the chip alone never says WHAT the check is about; the same
    // sentence the sheet's caption uses reads the same way here.
    expect(card.innerHTML).toContain("Based on a memory later marked Wrong");
  });
});

// End-to-end regression: makeRecallCard reading the right fields is not enough on its own -
// sendRecall builds its OWN `entries` array from GET /recall's raw response before ever
// calling makeRecallCard, and a real screenshot caught that re-map silently dropping all six
// validity fields (valid_from_stated, validity_state, retracted_source, ...), so every real
// recall card rendered with none of them even though makeRecallCard itself was correct and
// every unit test above (which calls makeRecallCard directly) kept passing regardless.
describe("sendRecall's own entry map carries the six validity fields through to the card", () => {
  function sse(chunks: string[]): ReadableStream {
    return new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: chunk })}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
  }

  function load(recallBody: unknown) {
    const ctx = baseCtx();
    // Not provided by baseCtx's vm context (only fetch mocks needed it before now): the real
    // stream-reading loop in sendRecall calls `new TextDecoder()` directly.
    ctx.TextDecoder = TextDecoder;
    ctx.TextEncoder = TextEncoder;
    ctx.fetch = async (url: string, init: any) => {
      ctx.__requests.push({ url, init });
      if (url.endsWith("/recall") && init.method === "POST") return { ok: true, json: async () => recallBody };
      if (url.includes("/chat")) return new Response(sse(["Found it."]));
      throw new Error("unexpected fetch " + url);
    };
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/recent.js", "public/js/ui-chat.js", "public/js/recall.js"]);
    return ctx;
  }

  it("a real GET /recall response (six-field shape) reaches the card as a stated-start label and a Check chip", async () => {
    const ctx = load({
      ok: true,
      results: [
        { ...CURRENT_STATED_ENTRY, score: 92, hop: 0 },
        { ...RETRACTED_SOURCE_ENTRY, score: 40, hop: 0 },
      ],
    });
    await ctx.sendRecall("Austin");
    // sourcesToggle is a plain makeEl whose innerHTML was set once (a static string, the
    // button plus the empty wrapper markup) and never re-synced from its real children;
    // the actual .memory-card elements sendRecall appends live only in the querySelector
    // stub's own .kids array (this harness's querySelector always returns the SAME cached
    // stub for a given selector on a given element), so that is what needs inspecting, not
    // the (unmoving) innerHTML string.
    const toggle = ctx.__els.get("recall-messages").kids.find((k: any) => k.className === "sources-toggle");
    const wrapper = toggle.querySelector(".brain-cards-wrapper");
    const html = wrapper.kids.map((card: any) => card.innerHTML).join("");
    expect(html).toContain("True since");
    expect(html).toContain("validity-chip--check");
  });
});

describe("stale sheet reason lines", () => {
  function load() {
    const ctx = baseCtx();
    run(ctx, ["public/utils.js", "public/js/state.js", "public/js/stale.js"]);
    return ctx;
  }

  // T-0089.2.3 (merged 48d628f8): GET /stale now sends `reason` (src/memory/stale.ts's
  // staleReasonFor) directly, so the row reads it rather than re-deriving it.
  it("reason: retracted_source explains itself, ahead of the confirmed date", () => {
    const ctx = load();
    const html = ctx.staleRow({ id: "s1", content: "x", tags: ["retracted-source"], source: "web", created_at: Date.now(), last_updated: Date.now(), reason: "retracted_source", valid_until: null });
    expect(html).toContain("Based on a memory later marked Wrong");
  });

  it("reason: date_passed explains itself, before the client-computed age fallback", () => {
    const ctx = load();
    const html = ctx.staleRow({ id: "s2", content: "x", tags: [], source: "web", created_at: Date.now(), last_updated: Date.now(), reason: "date_passed", valid_until: Date.now() - 86400000 });
    expect(html).toContain("Its date has passed");
  });

  it("reason: not_confirmed explains itself by days since confirmed", () => {
    const ctx = load();
    const tenDaysAgo = Date.now() - 10 * 86400000;
    const html = ctx.staleRow({ id: "s3", content: "x", tags: [], source: "web", created_at: tenDaysAgo, last_updated: tenDaysAgo, reason: "not_confirmed", valid_until: null });
    expect(html).toContain("Not confirmed in 10 days");
  });
});

describe("keyboard: the Replaced by link is reachable and named", () => {
  it("is a real <a href>, not a div with an onclick", () => {
    const ctx = baseCtx();
    run(ctx, MEMORY_CRUD_FILES);
    ctx.renderViewStatus({ ...REPLACED_ENTRY, tags: [] });
    const html = el(ctx, "view-status-caption").innerHTML as string;
    expect(html).toMatch(/<a\s[^>]*href=/);
  });
});
