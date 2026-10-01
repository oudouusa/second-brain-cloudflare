import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { throw new Error('計測JSONが不正'); }
}

// Wrangler tailの連続JSONオブジェクトを読む。文字列内の括弧・エスケープは区切りにしない。
export function parseTail(raw) {
  const events = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (start < 0) {
      if (/\s/.test(char)) continue;
      if (char !== '{') throw new Error('tailにJSON以外の出力がある');
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      if (--depth === 0) {
        events.push(parseJson(raw.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  if (start >= 0) throw new Error('tailが途中で切れている');
  return events;
}

const modes = ['healthy', 'quota', 'embedding-failure', 'vector-failure'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => createHash('sha256').update(value).digest('hex');

export function auditSmoke(samples, events, version) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(version)) throw new Error('配備versionが不正');
  if (samples.length !== 8 || new Set(samples.map(s => s.fixture)).size !== 1) throw new Error('smokeの8試行が揃っていない');
  const fixture = samples[0].fixture;
  if (!/^(200|1000|10000)-(ordinary-noise|excluded-window|equal-authority-overflow|no-answer)-(en|ja)$/.test(fixture)) throw new Error('fixtureが不正');
  const expected = new Set(modes.flatMap(mode => [-1, 0].map(rep => `${fixture}-${mode}-${rep < 0 ? 'warmup' : rep}`)));
  const selected = events.filter(e => e.scriptVersion?.id === version);
  const joined = [];
  for (const sample of samples) {
    const id = `${fixture}-${sample.mode}-${sample.repetition < 0 ? 'warmup' : sample.repetition}`;
    if (sample.id !== id || !expected.delete(id) || ![-1, 0].includes(sample.repetition)
      || sample.warmup !== (sample.repetition < 0)) throw new Error('試行IDが不正・重複');
    if (sample.status !== 200 || sample.error !== null) throw new Error('HTTP/MCP試行が失敗');
    for (const stage of ['public', 'do', 'reset']) {
      const metrics = sample[stage + 'Metrics'];
      if (!metrics || !['statements', 'rowsRead', 'rowsWritten'].every(key => integer(metrics[key]))) throw new Error('D1計測値が欠落・不正');
      const operation = `sb54-${stage}:${digest(id).slice(0, 32)}`;
      const matches = [];
      for (const event of selected) for (const log of event.logs ?? []) for (const message of log.message ?? []) {
        if (typeof message !== 'string') continue;
        let parsed;
        try { parsed = JSON.parse(message); } catch { continue; }
        if (parsed?.event === 'http_request' && parsed.operation === operation) matches.push({ event, parsed });
      }
      if (matches.length !== 1) throw new Error('試行ログが欠落・重複');
      const { event, parsed } = matches[0];
      if (event.executionModel !== (stage === 'public' ? 'stateless' : 'durableObject')
        || (stage !== 'public' && event.event?.rpcMethod !== (stage === 'do' ? 'handleMcp' : 'reset'))
        || parsed.method !== 'POST' || parsed.status !== 200) throw new Error('試行ログの経路が不一致');
      if (event.outcome !== 'ok' || event.truncated !== false
        || !Array.isArray(event.exceptions) || event.exceptions.length) throw new Error('試行が正常終了していない');
      if (!integer(event.cpuTime) || !Number.isFinite(event.wallTime) || event.wallTime < 0) throw new Error('CPU/時間が欠落・不正');
      // 生ログのrequest/header/例外本文は出力しない。
      joined.push({ id, stage, cpuMs: event.cpuTime, wallMs: event.wallTime, ...metrics });
    }
  }
  if (expected.size) throw new Error('試行が欠落');
  return { schema: 'sb54-smoke-audit.v1', version, fixture, samples: samples.length,
    telemetryPassed: true, remoteGatePassed: false, joined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [samplesFile, tailFile, version, output] = process.argv.slice(2);
  if (!output) throw new Error('使用法: audit-smoke.mjs SAMPLES_JSONL TAIL_JSON VERSION OUTPUT_JSON');
  const samplesRaw = readFileSync(samplesFile, 'utf8');
  const tailRaw = readFileSync(tailFile, 'utf8');
  const result = auditSmoke(samplesRaw.trim().split('\n').filter(Boolean).map(line => parseJson(line)), parseTail(tailRaw), version);
  writeFileSync(output, JSON.stringify({ ...result, samplesSha256: digest(samplesRaw), tailSha256: digest(tailRaw) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ telemetryPassed: true, remoteGatePassed: false, samples: result.samples }));
}
