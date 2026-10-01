/**
 * T-0089.5.1 second fix round: when Vectorize's workspace filter is rejected and the
 * unfiltered retry hands back another member's private vector, that vector must never
 * become a graph root — not as a display value (dense_rank, fixed already) and not as
 * a real traversal anchor whose id then rides out on a readable neighbour's `viaFrom`
 * (why.graph.from, MCP "linked from", REST related_to).
 */
import { it, expect, vi } from 'vitest';
import { embeddingMetadata } from '../../src/embedding/profile';
import worker from '../../src/index';
import { makeExplainFixture, NOW } from '../helpers/explain-fixture';
import { createMember } from '../../src/lib/team-admin';
import { ensureTenantBootstrap } from '../../src/lib/tenancy';
import { resetVectorizeFilterState } from '../../src/vectorize/scope';
import { recallEntries } from '../../src/recall/search';
import { resolveIdentityFromToken } from '../../src/lib/identity';
import { renderRecallText } from '../../src/recall/render';

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
const TEAM_B = 'ws-adv-team-b';
const vec = (id: string, score: number) => ({ id, score, metadata: { ...embeddingMetadata(), parentId: id, created_at: NOW - 86_400_000, tags: [] } });

type Mode = 'personal' | 'company' | 'team' | 'graph' | 'graphForeign' | 'keyword';
async function run(mode: Mode, foreign: boolean) {
  resetVectorizeFilterState();
  const f = await makeExplainFixture();
  try {
    const roots = await ensureTenantBootstrap(f.env);
    const bob = await createMember(f.env, { name: 'Bob Chen' });
    await f.sqlite.db.prepare("INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Other team', ?)").bind(TEAM_B, NOW + 1000).run();
    if (mode === 'team') await f.sqlite.db.prepare('INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)').bind(bob.member.userId, TEAM_B, NOW).run();
    const seed = (id: string, ws: string, actor: string, content = 'Atlas ledger reconciliation decision') => f.sqlite.db.prepare("INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', ?, ?, '[]', ?, ?)").bind(id, content, NOW - 86_400_000, NOW - 86_400_000, ws, actor).run();
    for (let i = 1; i <= 5; i++) await seed(`bob${i}`, bob.member.personalWorkspaceId, bob.member.userId);
    await seed('bob-related', bob.member.personalWorkspaceId, bob.member.userId, 'Atlas ledger reconciliation linked evidence');
    await seed('shared-owner', roots.companyWorkspaceId, roots.ownerUserId);
    await seed('shared-bob', roots.companyWorkspaceId, bob.member.userId);
    await seed('team-b-hidden', TEAM_B, bob.member.userId);
    if (mode !== 'graphForeign') await f.sqlite.db.prepare("INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('edge-good', 'bob1', 'bob-related', 'relates_to', 1, 'explicit', '{}', ?, ?, ?)").bind(NOW, NOW, bob.member.personalWorkspaceId).run();
    await f.sqlite.db.prepare("INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('edge-bad', 'bob1', 'e1', 'relates_to', 1, 'explicit', '{}', ?, ?, ?)").bind(NOW, NOW, bob.member.personalWorkspaceId).run();
    if (mode === 'graphForeign') await f.sqlite.db.prepare("INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('edge-private-root', 'bob-related', 'e1', 'relates_to', 1, 'explicit', '{}', ?, ?, ?)").bind(NOW, NOW, bob.member.personalWorkspaceId).run();
    let sawFiltered = false, sawRetry = false;
    (f.env.VECTORIZE.query as ReturnType<typeof vi.fn>).mockImplementation(async (_values: unknown, opts: any) => {
      if (opts.filter) { sawFiltered = true; throw new Error('metadata filter unsupported'); }
      sawRetry = true;
      if (mode === 'keyword') return { matches: [] };
      const allowed = mode === 'company' || mode === 'team' ? [vec('shared-owner', .92), vec('shared-bob', .91)] : (mode === 'graph' || mode === 'graphForeign' ? [1] : [1,2,3,4,5]).map(i => vec(`bob${i}`, .95 - i * .03));
      return { matches: foreign ? [vec('e1', .99), vec('team-b-hidden', .98), ...allowed] : allowed };
    });
    const qs = mode === 'company' ? 'workspace=company' : mode === 'team' ? `workspace=company&team=${roots.companyWorkspaceId}` : 'workspace=personal';
    if (mode === 'graph' || mode === 'graphForeign') {
      const identity = (await resolveIdentityFromToken(bob.token, f.env))!;
      const result = await recallEntries({query:'atlas ledger',topK:5,hops:1,synthesize:false,explain:true},f.env,ctx,undefined,{identity,workspaceFilter:'personal',variant:{arms:'dense-only'}});
      return {status:200,rows:result.matches.map(r=>({id:r.id,why:r.why,hop:r.hop})),mcpText:renderRecallText(result.matches,''),offText:renderRecallText(result.matches.map(r=>({...r,why:undefined})),''),sawFiltered,sawRetry};
    }
    const response = await worker.fetch(new Request("http://localhost/recall", { method: "POST", body: JSON.stringify({ query: "atlas ledger", topK: 5, explain: true, ...Object.fromEntries(new URLSearchParams(qs)) }), headers: { "Content-Type": "application/json", Authorization: `Bearer ${bob.token}` } }), f.env, ctx);
    const body = await response.json() as any;
    return {status: response.status, rows: body.results?.map((r: any) => ({id:r.id, why:r.why, hop:r.hop})), sawFiltered, sawRetry};
  } finally { f.close(); }
}

it.each(['personal','company','team','graph','graphForeign','keyword'] as Mode[])('%s: hidden rows do not alter why', async mode => {
  const base = await run(mode, false);
  const hidden = await run(mode, true);
  expect(base.status).toBe(200);
  expect(hidden.status).toBe(200);
  if (mode !== 'keyword') expect(hidden.sawFiltered && hidden.sawRetry).toBe(true);
  if (mode === 'graphForeign') {
    expect(hidden.offText).not.toContain('e1');
    expect(hidden.mcpText).not.toContain('e1');
  }
  expect(hidden.rows).toEqual(base.rows);
  expect(JSON.stringify(hidden.rows)).not.toMatch(/team-b-hidden|\be1\b/);
  if (mode === 'keyword') expect(hidden.rows.every((r: any) => r.why.dense_rank === null)).toBe(true);
  if (mode === 'graph') expect(hidden.rows.some((r: any) => r.hop > 0 || r.why.slot === 'evidence')).toBe(true);
});
