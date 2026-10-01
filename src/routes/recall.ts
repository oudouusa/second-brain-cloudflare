import { readProjectParam } from "./project-param";
import { chatGptEnvForWorkspaces, isChatGptOperationEnabled, runChatGptGenerationAnswerStream } from "../lib/chatgpt";
import type { Env } from "../env";
import { resolveConfig } from "../config";
import { RECALL_MAX_TOP_K, LLM_MODEL, SEMANTIC_UNAVAILABLE_DETAIL } from "../constants";
import { CORS_HEADERS, intParam, json, readJsonBody, readTeamQueryParam, readWorkspaceParam } from "../lib/http";
import { buildEntryFilterQuery } from "../capture/entry";
import { compressTag } from "../compression/digest";
import { requireIdentity, type Identity } from "../lib/identity";
import { assertCanMutateEntry } from "../lib/entry-access";
import { layerOf, readScopeWorkspaces, readTeamParam, scopeWhereForRead } from "../lib/scope";
import { lookupActorLabels, resolveActorFilter, resolveActorLabel } from "../lib/actors";
import { KIND_VALUES, type MemoryKind } from "../memory/kind";
import { recallEntries } from "../recall/search";
import type { StandingFire } from "../recall/types";
import { allowanceFor, snippetOf } from "../recall/snippet";
import { editedCanonicalAt } from "../quarantine/tags";
import { parseSupersededBy, validitySummary } from "../recall/validity-view";
import { parseValidityDate } from "../memory/validity";
import { recallSnippet } from "../recall/render";
import { workersAiQuotaRetryMessage } from "../lib/ai";
import type { RecallSearchResult } from "../recall/types";

type RecallRequestBody = {
  project?: unknown;
  explain?: unknown;
  as_of?: unknown;
  query?: unknown;
  topK?: unknown;
  tag?: unknown;
  after?: unknown;
  before?: unknown;
  kind?: unknown;
  hops?: unknown;
  full?: unknown;
  synthesize?: unknown;
  workspace?: unknown;
  team?: unknown;
};

function semanticUnavailableMessage(
  reason: RecallSearchResult["semanticUnavailableReason"],
  retryAt?: number,
): string {
  if (reason === "workers_ai_quota_exhausted" && retryAt) {
    return `Semantic search is temporarily unavailable; keyword matches are still returned. ${workersAiQuotaRetryMessage(retryAt)}`;
  }
  if (reason === "embedding_unavailable") {
    return "Semantic search is temporarily unavailable because query embedding failed; keyword matches are still returned. Please retry later.";
  }
  return `Semantic search was unavailable or incomplete for this query, so only keyword and tag matches were considered. ${SEMANTIC_UNAVAILABLE_DETAIL}`;
}

function bodyInteger(
  body: RecallRequestBody,
  name: keyof RecallRequestBody,
  opts: { fallback?: number; min?: number; max?: number } = {},
): number | undefined | Response {
  const raw = body[name];
  if (raw === undefined) return opts.fallback;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    return json({ ok: false, error: `${name} must be an integer` }, 400);
  }
  const floored = opts.min === undefined ? raw : Math.max(opts.min, raw);
  return opts.max === undefined ? floored : Math.min(opts.max, floored);
}

/**
 * Add the caller's workspace predicate before ORDER BY and LIMIT.
 *
 * Finds the OUTER query's own WHERE/ORDER BY, not the first occurrence in the
 * string: buildEntryFilterQuery's superseded_by subquery (T-0089.2.1) carries
 * its own WHERE and ORDER BY, textually earlier, which a first-match
 * `.replace()` would splice the scope clause into instead — landing on a bare
 * `workspace_id` inside a subquery that joins `edges` and `entries`, where it
 * is ambiguous between the two. The outer " ORDER BY" is always the LAST one;
 * the subquery's own FROM clause is "FROM edges g JOIN entries s", never the
 * literal "FROM entries", so the last occurrence of that is always the outer one too.
 */
function scopeEntryFilterQuery(
  identity: Identity,
  q: { sql: string; bindings: unknown[] },
  layer?: "personal" | "company",
  teamId?: string,
): { sql: string; bindings: unknown[] } {
  const scope = scopeWhereForRead(identity, { layer, teamId });
  const orderByAt = q.sql.lastIndexOf(" ORDER BY");
  // scope-exempt: string search over q.sql, which buildEntryFilterQuery already produced and this function is about to scope; not a query of its own
  const fromEntriesAt = q.sql.lastIndexOf("FROM entries");
  const hasOuterWhere = q.sql.slice(fromEntriesAt, orderByAt).includes("WHERE");
  const sql = `${q.sql.slice(0, orderByAt)} ${hasOuterWhere ? "AND" : "WHERE"} ${scope.clause}${q.sql.slice(orderByAt)}`;
  return { sql, bindings: [...q.bindings.slice(0, -1), ...scope.bindings, ...q.bindings.slice(-1)] };
}

const standingJson = (f: StandingFire) => ({
  id: f.id,
  content: f.content,
  created_at: f.createdAt,
  workspace: f.workspace,
  actor_name: f.actorName ?? null,
  project: f.project,
  score: parseFloat((f.score * 100).toFixed(1)),
  ...(f.why ? { why: f.why } : {}),
});

export async function handleRecallRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /list permits only numeric pagination. A private tag belongs in POST JSON.
  if (url.pathname === "/list" && (request.method === "GET" || request.method === "POST")) {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;
    let n: number;
    let tag: string | undefined;
    let after: number | undefined;
    let before: number | undefined;
    let workspace: "personal" | "company" | undefined;
    let team: string | undefined;
    let projectValue: unknown = url.searchParams.get("project");
    let actorParam: string | undefined;
    if (request.method === "POST") {
      const parsed = await readJsonBody<{
        n?: unknown;
        tag?: unknown;
        after?: unknown;
        before?: unknown;
        workspace?: unknown;
        team?: unknown;
        actor?: unknown;
        project?: unknown;
      }>(request, 8 * 1024);
      if (!parsed.ok) return parsed.response;
      const values = parsed.value;
      projectValue = values.project;
      for (const name of ["n", "after", "before"] as const) {
        if (values[name] !== undefined
          && (typeof values[name] !== "number" || !Number.isSafeInteger(values[name]))) {
          return json({ ok: false, error: `${name} must be an integer` }, 400);
        }
      }
      n = Math.min(100, Math.max(0, typeof values.n === "number" ? values.n : 20));
      tag = typeof values.tag === "string" ? values.tag.trim() || undefined : undefined;
      after = typeof values.after === "number" ? values.after : undefined;
      before = typeof values.before === "number" ? values.before : undefined;
      if (values.workspace !== undefined
        && values.workspace !== "personal"
        && values.workspace !== "company") {
        return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
      }
      workspace = values.workspace as "personal" | "company" | undefined;
      const teamRead = readTeamParam(values.team, identity, workspace);
      if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);
      team = teamRead.teamId;
      if (values.actor !== undefined && typeof values.actor !== "string") {
        return json({ ok: false, error: "actor must be a string" }, 400);
      }
      actorParam = typeof values.actor === "string" ? values.actor.trim() || undefined : undefined;
    } else {
      if (url.searchParams.has("tag")) {
        return json({ ok: false, error: "Use POST /list for a private tag" }, 405);
      }
      // Floor of 0 as well as the cap: SQLite reads a negative LIMIT as no limit.
      const parsedN = intParam(url, "n", { fallback: 20, min: 0, max: 100 });
      if (parsedN instanceof Response) return parsedN;
      n = parsedN;
      const parsedAfter = intParam(url, "after");
      if (parsedAfter instanceof Response) return parsedAfter;
      after = parsedAfter;
      const parsedBefore = intParam(url, "before");
      if (parsedBefore instanceof Response) return parsedBefore;
      before = parsedBefore;
      const parsedWorkspace = readWorkspaceParam(url);
      if (parsedWorkspace instanceof Response) return parsedWorkspace;
      workspace = parsedWorkspace;
      const parsedTeam = readTeamQueryParam(url, identity, workspace);
      if (parsedTeam instanceof Response) return parsedTeam;
      team = parsedTeam;
      actorParam = url.searchParams.get("actor")?.trim() || undefined;
    }

    let actor: string | undefined;
    if (actorParam) {
      const resolved = await resolveActorFilter(env, identity, actorParam);
      if (!resolved.ok) return json({ ok: false, error: resolved.error }, 400);
      actor = resolved.actorId;
    }
    const project = await readProjectParam(env, identity, url, { layer: workspace, teamId: team }, projectValue);
    if (project instanceof Response) return project;
    const { sql, bindings } = scopeEntryFilterQuery(
      identity,
      buildEntryFilterQuery({ n, tag, after, before, actor, project }),
      workspace,
      team,
    );
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    const rows = results as Record<string, unknown>[];
    // Each row reports its layer so the dashboard can badge cards and offer
    // share/unshare without knowing the caller's workspace ids itself.
    const companyRows = rows.filter((r) => layerOf(identity, r.workspace_id) === "company");
    const labelMap = await lookupActorLabels(
      env,
      companyRows.map((r) => String(r.actor_id ?? "")),
    );
    return json(rows.map((r) => {
      const layer = layerOf(identity, r.workspace_id);
      const { superseded_by_json, ...rest } = r as Record<string, unknown> & { superseded_by_json?: string | null };
      const validity = validitySummary({
        createdAt: Number(r.created_at),
        validFrom: r.valid_from as number | null | undefined,
        validUntil: r.valid_until as number | null | undefined,
        tags: JSON.parse((r.tags as string) ?? "[]"),
        supersededBy: parseSupersededBy(superseded_by_json),
      });
      // actor_name is always present, null where there is no author to name —
      // the same contract GET /recall's results carry. It used to be added only
      // on company rows, which made the KEY's existence depend on whether the
      // page happened to contain a shared memory: on a personal brain it never
      // appeared at all, so a client could not tell "nobody wrote this" from
      // "this deployment does not report authors".
      return {
        ...rest,
        workspace: layer,
        valid_from: validity.validFrom,
        valid_from_stated: validity.validFromStated,
        valid_until: validity.validUntil,
        validity_state: validity.validityState,
        superseded_by: validity.supersededBy,
        retracted_source: validity.retractedSource,
        // The same answer GET /entry gives, from the same predicate the mutation
        // routes enforce with: a card the caller cannot edit says so before they
        // try. Computed for every row, not only company ones, so a client can
        // read a missing field as "old Worker" and a present `true` as a real
        // answer. workspace_id and actor_id are already in the projection —
        // layerOf reads the first and lookupActorLabels the second — so this
        // costs no query.
        can_edit: assertCanMutateEntry(identity, {
          workspace_id: String(r.workspace_id ?? ""),
          actor_id: String(r.actor_id ?? ""),
        }) === null,
        actor_name: layer === "company"
          ? resolveActorLabel(String(r.actor_id ?? ""), labelMap, {
              viewerId: identity.userId,
              source: String(r.source ?? ""),
            })
          : null,
      };
    }));
  }

  // Recall text is private memory. It belongs in a JSON request body, never a URL that
  // can be copied into browser history, proxies, analytics, or real-time tail output.
  if (url.pathname === "/recall" && request.method === "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Use POST /recall with a JSON body" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST", "Cache-Control": "no-store", ...CORS_HEADERS },
    });
  }

  // POST /recall — semantic search, mirrors the MCP `recall` tool
  if (url.pathname === "/recall" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    const parsedBody = await readJsonBody<RecallRequestBody>(request, 32 * 1024);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.value;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return json({ ok: false, error: "query is required" }, 400);

    const topK = bodyInteger(body, "topK", { fallback: 5, min: 1, max: RECALL_MAX_TOP_K });
    if (topK instanceof Response) return topK;
    const tag = typeof body.tag === "string" ? body.tag.trim() || undefined : undefined;
    const after = bodyInteger(body, "after");
    if (after instanceof Response) return after;
    const before = bodyInteger(body, "before");
    if (before instanceof Response) return before;
    const kindParam = typeof body.kind === "string" ? body.kind.trim() : undefined;
    const kind = kindParam && (KIND_VALUES as readonly string[]).includes(kindParam) ? kindParam as MemoryKind : undefined;
    const hops = bodyInteger(body, "hops", { fallback: 0, min: 0, max: 3 });
    if (hops instanceof Response) return hops;
    if (body.synthesize !== undefined && typeof body.synthesize !== "boolean") {
      return json({ ok: false, error: "synthesize must be a boolean" }, 400);
    }
    const synthesize = typeof body.synthesize === "boolean" ? body.synthesize : undefined;
    if (body.workspace !== undefined
      && body.workspace !== "personal"
      && body.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }
    const workspace = body.workspace as "personal" | "company" | undefined;
    const teamRead = readTeamParam(body.team, identity, workspace);
    if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);
    // Long memories are shortened by default so API/CLI consumers get a bounded
    // payload. Renderers that show the whole memory (the dashboard) pass full=1.
    const full = body.full === true;

    const project = await readProjectParam(env, identity, url, { layer: workspace, teamId: teamRead.teamId }, body.project);
    if (project instanceof Response) return project;

    const cfg = await resolveConfig(env);
    const explain = body.explain === true;
    const asOfParam = typeof body.as_of === "string" ? body.as_of.trim() : undefined;
    let asOf: number | undefined;
    if (body.as_of !== undefined && typeof body.as_of !== "string") return json({ ok: false, error: "as_of must be a string" }, 400);
    if (asOfParam) {
      if (after !== undefined || before !== undefined) return json({ ok: false, error: "Pass as_of, or after/before, not both." }, 400);
      const parsed = parseValidityDate(asOfParam, Date.now(), cfg.TIMEZONE, "end");
      if (typeof parsed !== "number") return json({ ok: false, error: parsed.error }, 400);
      asOf = parsed;
    }
    const {
      matches, asOf: asOfHeader, standing, receipt,
      insight,
      semanticUnavailable,
      semanticUnavailableReason,
      semanticRetryAt,
      querySignalCacheHit,
      queryUsed,
      queryTokens,
      currentQueryTokens,
      compoundStale,
      graphContribution,
    } = await recallEntries({
      query,
      topK: topK ?? 5,
      tag,
      after,
      before,
      kind,
      hops: hops ?? 0,
      synthesize, explain, channel: "rest",
      project,
    }, env, ctx, cfg, {
      identity,
      workspaceFilter: workspace,
      teamId: teamRead.teamId, asOf,
    });

    if (!matches.length) {
      return json({
        ok: true,
        results: [],
        query_used: queryUsed,
        graph_contribution: graphContribution,
        semantic_unavailable: semanticUnavailable,
        semantic_unavailable_reason: semanticUnavailableReason ?? null,
        semantic_retry_at: semanticRetryAt ?? null,
        query_signal_cache_hit: querySignalCacheHit,
        receipt,
        ...(asOfHeader ? { as_of: { at: asOfHeader.at, not_recorded_before: asOfHeader.notRecordedBefore } } : {}),
        // A standing instruction can fire above zero results (spec 15 2.8 step 5).
        ...(standing?.length ? { standing: standing.map(standingJson) } : {}),
        message: semanticUnavailable
          ? semanticUnavailableMessage(semanticUnavailableReason, semanticRetryAt)
          : "Nothing found matching that query.",
      });
    }

    return json({
      ok: true,
      query_used: queryUsed,
      compound_stale: compoundStale ?? null,
      receipt,
      ...(asOfHeader ? { as_of: { at: asOfHeader.at, not_recorded_before: asOfHeader.notRecordedBefore } } : {}),
      ...(standing?.length ? { standing: standing.map(standingJson) } : {}),
      results: matches.map((m, i) => {
        const s = full
          ? { text: m.content, truncated: false, fullLength: (m.content ?? "").length }
          : recallSnippet(m, i, { queryTokens, currentQueryTokens, config: cfg });
        return {
          id: m.id,
          content: s.text,
          truncated: s.truncated,
          full_length: s.fullLength,
          score: parseFloat((m.score * 100).toFixed(1)),
          tags: m.tags,
          source: m.source,
          created_at: m.createdAt,
          updated_at: m.updatedAt,
          stale_as_of: m.staleAsOf,
          updated: m.isUpdate,
          hop: m.hop,
          workspace: m.workspace ?? null,
          actor_name: m.workspace === "company" ? (m.actorName ?? null) : null,
          via_provenance: m.viaProvenance ?? null,
          via_type: m.viaType ?? null,
          linked_at: m.viaLinkedAt ?? null,
          related_to: m.viaFrom ?? null,
          via_source_id: m.viaSourceId ?? null,
          via_target_id: m.viaTargetId ?? null,
          via_direction: m.viaDirection ?? null,
          similar: m.similar?.map(s => ({ id: s.id, created_at: s.createdAt })) ?? [],
          edited_canonical_at: editedCanonicalAt(m.tags),
          valid_from: m.validFrom,
          valid_from_stated: m.validFromStated,
          valid_until: m.validUntil,
          validity_state: m.validityState,
          superseded_by: m.supersededBy,
          retracted_source: m.retractedSource,
          ...(asOfHeader ? {
            as_of_text_changed_at: m.asOfTextChangedAt ?? null,
            status_at: m.statusAt ?? null,
            recorded_after_as_of: m.recordedAfterAsOf ?? false,
            retracted_belief: m.retractedBelief ? { retracted_at: m.retractedBelief.retractedAt, attached_to: m.retractedBelief.attachedTo } : null,
          } : {}),
          ...(explain ? { why: m.why ?? null } : {}),
        };
      }),
      insight: insight || null,
      graph_contribution: graphContribution,
      semantic_unavailable: semanticUnavailable,
      semantic_unavailable_reason: semanticUnavailableReason ?? null,
      semantic_retry_at: semanticRetryAt ?? null,
      query_signal_cache_hit: querySignalCacheHit,
    });
  }

  // POST /chat
  if (url.pathname === "/chat" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const parsedBody = await readJsonBody<{ query?: unknown; memories?: unknown; workspace?: unknown }>(request, 256 * 1024);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.value;
    if (typeof body.query !== "string" || !body.query.trim()) return json({ ok: false, error: "query is required" }, 400);
    if (body.memories !== undefined && typeof body.memories !== "string") return json({ ok: false, error: "memories must be a string" }, 400);
    if (body.workspace !== undefined && body.workspace !== "personal" && body.workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }
    // 本文はclient作成なので、範囲未指定は個人領域と推測しない。
    // memberのpersonalWorkspaceIdは所有者の設定・資格情報束縛と一致しない。
    env = chatGptEnvForWorkspaces(env, body.workspace === "personal" ? [auth.personalWorkspaceId] : []);

    // The memories arrive numbered, dated and attributed (see the client's
    // serializer in public/js/recall.js and the MCP tool's mirror of it), so
    // the model has everything it needs to be specific — it just has to be
    // asked. The previous prompt ended "Be concise", and on a brain holding
    // three days of dense decisions "What did I decide recently?" came back as
    // one sentence about an unrelated email: the top match, summarised, with
    // the other four sources ignored.
    const systemPrompt = `You are a personal memory assistant. Answer the user's question using ONLY the memories provided.

Draw on every memory that bears on the question, not only the closest match — a question about decisions or plans usually has several answers, and reporting one of them is a wrong answer.

Anchor claims in time. The memories are dated; say "On 12 March you decided…" rather than "you decided…". If two memories disagree, say so and lead with the more recent one.

When the answer has several parts, give them as short bullets rather than one crowded sentence.

Cite as you go with the memory's number in square brackets, like [2], matching the numbered list you were given. Cite every claim.

Even if the match scores are low, extract any relevant facts and answer directly. Never say you don't have enough information if the answer exists anywhere in the memories.

Be specific and complete. Concision means leaving out filler, never leaving out facts.`;

    const userMessage = `Question: ${body.query}\n\nRelevant memories:\n${body.memories}`;
    const cfg = await resolveConfig(env);

    if (isChatGptOperationEnabled(env, "answer")) {
      try {
        const stream = await runChatGptGenerationAnswerStream(env, [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ]);
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", ...CORS_HEADERS,
            "X-Second-Brain-AI-Provider": "chatgpt", "Access-Control-Expose-Headers": "X-Second-Brain-AI-Provider" },
        });
      } catch {
        return json({ ok: false, error: "Answer generation is temporarily unavailable" }, 503);
      }
    }

    // Workers AI requires `as any` here — the SDK types don't cover all models
    const stream = await env.AI.run(cfg.LLM_MODEL as any, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      stream: true,
    });

    return new Response(stream as ReadableStream, {
      headers: { "Content-Type": "text/event-stream", ...CORS_HEADERS },
    });
  }

  if (url.pathname === "/digest" && request.method === "GET") {
    return new Response(JSON.stringify({ ok: false, error: "Use POST /digest with a JSON body" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST", ...CORS_HEADERS },
    });
  }

  // POST /digest
  if (url.pathname === "/digest" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const parsed = await readJsonBody<{ tag?: unknown; project?: unknown; workspace?: unknown; team?: unknown }>(request, 8 * 1024);
    if (!parsed.ok) return parsed.response;
    const tag = typeof parsed.value.tag === "string" ? parsed.value.tag.trim() : "";
    const projectParam = parsed.value.project;
    if (!tag && !projectParam) return json({ ok: false, error: "tag or project parameter is required" }, 400);
    if (tag && projectParam) return json({ ok: false, error: "pass either tag or project, not both" }, 400);
    const workspace = parsed.value.workspace;
    if (workspace !== undefined && workspace !== "personal" && workspace !== "company") {
      return json({ ok: false, error: 'workspace must be "personal" or "company"' }, 400);
    }
    const layer = workspace as "personal" | "company" | undefined;
    const teamRead = readTeamParam(parsed.value.team, auth, layer);
    if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);

    const project = await readProjectParam(env, auth, url, { layer, teamId: teamRead.teamId }, projectParam);
    if (project instanceof Response) return project;
    const result = await compressTag(project ? `project:${project[0].id}` : tag, env, ctx, {
      workspaceIds: project ? [...new Set(project.map(r => r.workspace_id))] : readScopeWorkspaces(auth, { layer, teamId: teamRead.teamId }),
      project,
    });

    if (!result.synthesizedId) {
      return json({ ...(project ? { project: project[0].id } : { tag }), error: `Could not create digest: the ${project ? "project" : "tag"} may have fewer than 10 eligible entries or was recently compressed`, source_count: result.entriesUsed });
    }

    return json({ ...(project ? { project: project[0].id } : { tag }), synthesis: result.text, entry_id: result.synthesizedId, source_count: result.entriesUsed });
  }

  return null;
}
