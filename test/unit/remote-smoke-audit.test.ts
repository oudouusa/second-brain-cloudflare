import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditSmoke, parseTail } from '../../experiments/recall-remote/audit-smoke.mjs';

const version = 'b191fba9-8026-460c-a786-6674834747ec';
function fixture() {
  const name = '200-ordinary-noise-en';
  const samples = ['healthy', 'quota', 'embedding-failure', 'vector-failure'].flatMap(mode => [-1, 0].map(repetition => {
    const metrics = { statements: 3, rowsRead: 600, rowsWritten: 8 };
    return { fixture: name, mode, repetition, warmup: repetition === -1,
      id: `${name}-${mode}-${repetition < 0 ? 'warmup' : repetition}`, status: 200, error: null,
      publicMetrics: { ...metrics }, doMetrics: { ...metrics }, resetMetrics: { ...metrics } };
  }));
  const events: any[] = samples.flatMap(sample => ['public', 'do', 'reset'].map(stage => ({
    scriptVersion: { id: version }, executionModel: stage === 'public' ? 'stateless' : 'durableObject',
    event: { rpcMethod: stage === 'do' ? 'handleMcp' : 'reset', request: { headers: { authorization: '秘密' } } },
    outcome: 'ok', truncated: false, exceptions: [], cpuTime: 4, wallTime: 30,
    logs: [{ message: [JSON.stringify({ event: 'http_request', operation: `sb54-${stage}:` + createHash('sha256').update(sample.id).digest('hex').slice(0, 32), method: 'POST', status: 200 })] }],
  })));
  return { samples, events };
}

describe('実環境smokeの計測監査', () => {
  it('順不同のログを照合し、生の認証情報を結果へ含めない', () => {
    const { samples, events } = fixture();
    const result = auditSmoke(samples, events.reverse(), version);
    expect(result.telemetryPassed).toBe(true);
    expect(result.remoteGatePassed).toBe(false);
    expect(result.joined).toHaveLength(24);
    expect(JSON.stringify(result)).not.toContain('秘密');
  });
  it('HTTP200でもresetのcanceledを失敗にする', () => {
    const { samples, events } = fixture(); events[2].outcome = 'canceled';
    expect(() => auditSmoke(samples, events, version)).toThrow('正常終了');
  });
  it.each(['欠落', '重複', '旧version', 'CPU欠測', '打切り', '例外', '別経路'])('%sを正常な計測として扱わない', kind => {
    const { samples, events } = fixture();
    if (kind === '欠落') events.pop();
    if (kind === '重複') events.push(events[0]);
    if (kind === '旧version') events[0].scriptVersion.id = '00000000-0000-0000-0000-000000000000';
    if (kind === 'CPU欠測') events[0].cpuTime = null;
    if (kind === '打切り') events[0].truncated = true;
    if (kind === '例外') events[0].exceptions = [{ message: '秘密' }];
    if (kind === '別経路') events[2].event.rpcMethod = 'handleMcp';
    expect(() => auditSmoke(samples, events, version)).toThrow();
  });
  it('不足した試行・不正なD1値を拒否する', () => {
    const { samples, events } = fixture();
    expect(() => auditSmoke(samples.slice(1), events, version)).toThrow();
    samples[0].resetMetrics.rowsRead = -1;
    expect(() => auditSmoke(samples, events, version)).toThrow('D1');
  });
  it('連続したpretty JSONを読み、文字列内の括弧を区切りと誤認しない', () => {
    const values = [{ text: '文字列 { [ \\" } ]', nested: [{ v: 1 }] }, { logs: [] }];
    expect(parseTail(values.map(x => JSON.stringify(x, null, 2)).join('\n'))).toEqual(values);
    expect(() => parseTail('{"logs":[')).toThrow('途中');
    expect(() => parseTail('注意\n{}')).toThrow('JSON以外');
    expect(() => parseTail('{秘密}')).toThrow('計測JSONが不正');
  });
});
