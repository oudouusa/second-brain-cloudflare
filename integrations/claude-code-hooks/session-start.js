#!/usr/bin/env node
'use strict';
const core = require('../agent-hooks-core/core.js');

// resume/fork transcripts already hold the earlier injection, and Claude Code
// de-duplicates identical hook output on those paths. compact is the opposite:
// compaction discards what the hook injected, so it must run again.
const SKIP_SOURCES = new Set(['resume', 'fork']);
const CACHEABLE_SOURCES = new Set(['startup', 'clear']);
const NAMESPACE = 'claude';
// Unchanged from before this hook moved onto the shared core: 15s for recall,
// then up to 3s more grace for a brief still in flight once recall answers.
// Claude Code's SessionStart is not on the tight, synchronous clock some other
// hosts are, so there is no reason to trade recall away on a slow or cold
// Worker for it. A NEW adapter must not copy these numbers without thinking —
// see the comment on DEFAULT_RECALL_TIMEOUT_MS in agent-hooks-core/core.js.
const RECALL_TIMEOUT_MS = core.DEFAULT_RECALL_TIMEOUT_MS;
const BRIEF_GRACE_MS = core.DEFAULT_BRIEF_GRACE_MS;
const SESSION_CACHE_TTL_MS = core.SESSION_CACHE_TTL_MS;

// Thin, signature-preserving wrappers around the shared, namespaced core so
// existing callers and tests of this file never see the namespace argument.
function sessionCacheFile(sessionId, dir) { return core.sessionCacheFile(NAMESPACE, sessionId, dir); }
function writeSessionCache(sessionId, text, dir) { return core.writeSessionCache(NAMESPACE, sessionId, text, dir); }
function readSessionCache(sessionId, now, dir) { return core.readSessionCache(NAMESPACE, sessionId, now, dir); }

async function main() {
  const payload = await core.readStdinJson();
  const source = typeof payload?.source === 'string' ? payload.source : 'startup';
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : '';
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  const out = await core.performRecall({
    cwd,
    sessionId,
    source,
    skipSources: SKIP_SOURCES,
    namespace: NAMESPACE,
    cacheableSources: CACHEABLE_SOURCES,
    recallTimeoutMs: RECALL_TIMEOUT_MS,
    briefGraceMs: BRIEF_GRACE_MS,
  });
  if (out) process.stdout.write(out);
}

module.exports = {
  SKIP_SOURCES, SESSION_CACHE_TTL_MS,
  buildRecallPlan: core.buildRecallPlan,
  buildRecallUrl: core.buildRecallUrl,
  buildRecallBody: core.buildRecallBody,
  buildBriefUrl: core.buildBriefUrl,
  cleanSnippet: core.cleanSnippet,
  frameOutput: core.frameOutput,
  sessionCacheFile, writeSessionCache, readSessionCache,
  main,
};

if (require.main === module) {
  main().catch((e) => core.fail(`recall failed: ${e?.message ?? e}`));
}
