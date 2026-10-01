import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditArgs, classifyPaths, decodeAudit, exitCode, renderMarkdown, runAudit } from '../../scripts/audit-dependencies.mjs';

const path = 'node_modules/example';
const nested = 'node_modules/dev-tool/node_modules/example';
const lock = { lockfileVersion: 3, packages: { '': {}, [path]: { version: '1.0.0' }, [nested]: { version: '1.0.1', dev: true } } };
function vulnerable(nodes = [path]) {
  return { name: 'example', severity: 'high', isDirect: true, range: '<2', nodes,
    via: [{ source: 12345, severity: 'high', title: 'Synthetic advisory', url: 'https://github.com/advisories/GHSA-example', range: '<2' }],
    fixAvailable: { name: 'example', version: '2.0.0', isSemVerMajor: true } };
}
function result(items = [], mutate = () => {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: items.length };
  for (const item of items) counts[item.severity]++;
  const payload = { auditReportVersion: 2, vulnerabilities: Object.fromEntries(items.map(item => [item.name, item])), metadata: { vulnerabilities: counts } };
  mutate(payload);
  return { status: items.length ? 1 : 0, signal: null, stdout: JSON.stringify(payload) };
}
function workspace(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'dependency-audit-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'package.json'), '{"name":"synthetic","private":true}');
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock));
  return cwd;
}

test('valid clean report is complete, not an error', () => {
  assert.equal(decodeAudit(result(), lock).counts.total, 0);
});
test('exit 1 with complete vulnerability report is findings', () => {
  const item = decodeAudit(result([vulnerable()]), lock).findings[0];
  assert.equal(item.paths[0].version, '1.0.0');
  assert.equal(item.fixAvailable.isSemVerMajor, true);
});
test('classifies individual paths, not every copy of a package as production', () => {
  const all = decodeAudit(result([vulnerable([path, nested])]), lock);
  const production = decodeAudit(result([vulnerable()]), lock);
  const items = classifyPaths(all, production);
  assert.equal(items[0].paths.find(node => node.path === nested).scope, 'full-graph-only');
  assert.equal(items[0].paths.find(node => node.path === path).scope, 'production-graph');
});
test('transitive advisory chains and no-fix metadata are preserved', () => {
  const indirect = { ...vulnerable(), name: 'dev-tool', nodes: ['node_modules/dev-tool'], isDirect: false, via: ['example'], fixAvailable: false };
  const extended = { ...lock, packages: { ...lock.packages, 'node_modules/dev-tool': { version: '3.0.0' } } };
  const report = decodeAudit(result([vulnerable(), indirect]), extended);
  assert.deepEqual(report.findings.find(item => item.name === 'dev-tool').via, [{ dependency: 'example' }]);
});
for (const [name, value] of [
  ['invalid JSON', { status: 1, stdout: 'service unavailable' }],
  ['empty output', { status: 0, stdout: '' }],
  ['process failure', { ...result(), status: 2 }],
  ['timeout despite valid stdout', { ...result(), error: new Error('ETIMEDOUT') }],
  ['signal termination', { ...result(), signal: 'SIGTERM' }],
  ['npm error response', { status: 1, stdout: '{"error":{"code":"ENOAUDIT"}}' }],
  ['unsupported report version', result([], r => { r.auditReportVersion = 3; })],
  ['false success exit status', { ...result([vulnerable()]), status: 0 }],
  ['false findings exit status', { ...result(), status: 1 }],
  ['mismatched totals', result([vulnerable()], r => { r.metadata.vulnerabilities.total = 0; })],
  ['mismatched severity totals', result([vulnerable()], r => { r.metadata.vulnerabilities.high = 0; })],
  ['missing lockfile path', result([vulnerable(['node_modules/missing'])])],
  ['duplicate affected path', result([vulnerable([path, path])])],
  ['unresolved advisory chain', result([{ ...vulnerable(), via: ['missing'] }])],
  ['invalid fix metadata', result([{ ...vulnerable(), fixAvailable: { version: '2' } }])],
  ['missing advisory detail', result([{ ...vulnerable(), via: [{}] }])],
  ['oversized output', { status: 0, stdout: ' '.repeat(2 * 1024 * 1024 + 1) }],
]) test(`${name} cannot be reported as safe`, () => assert.throws(() => decodeAudit(value, lock)));

test('production paths absent in full graph are an incomplete audit, not dev-only', () => {
  assert.throws(() => classifyPaths(decodeAudit(result(), lock), decodeAudit(result([vulnerable()]), lock)), /graphs disagree/);
});
test('runs exactly two bounded read-only commands and preserves dependency bytes', t => {
  const cwd = workspace(t);
  const before = readFileSync(join(cwd, 'package-lock.json'));
  const calls = [];
  const report = runAudit({ cwd, execute: (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'npm');
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 60000);
    assert.equal(options.maxBuffer, 2 * 1024 * 1024);
    assert.equal(options.env.NODE_ENV, 'development');
    assert(!args.some(arg => ['install', 'ci', 'fix', '--force'].includes(arg)));
    return result();
  } });
  assert.deepEqual(calls, [auditArgs(false), auditArgs(true)]);
  assert(calls[0].includes('--include=dev'));
  assert(calls[1].includes('--omit=dev'));
  assert.equal(report.status, 'clean');
  assert.equal(report.filesUnchanged, true);
  assert.deepEqual(readFileSync(join(cwd, 'package-lock.json')), before);
});
test('a failed production scan retains full-scope evidence without a clean verdict', t => {
  let count = 0;
  const report = runAudit({ cwd: workspace(t), execute: () => ++count === 1 ? result([vulnerable()]) : { status: 1, stdout: '' } });
  assert.equal(report.all.counts.high, 1);
  assert.equal(report.production, null);
  assert.equal(report.status, 'incomplete');
  assert.equal(exitCode(report, true), 2);
});
test('dependency file mutation fails audit even when npm reports clean', t => {
  const cwd = workspace(t);
  const report = runAudit({ cwd, execute: () => {
    writeFileSync(join(cwd, 'package.json'), '{"changed":true}');
    return result();
  } });
  assert.equal(report.filesUnchanged, false);
  assert.equal(report.status, 'incomplete');
});
test('missing and unsupported lockfiles are errors before registry calls', t => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":1}');
  let calls = 0;
  assert.equal(runAudit({ cwd, execute: () => { calls++; return result(); } }).status, 'incomplete');
  rmSync(join(cwd, 'package-lock.json'));
  assert.equal(runAudit({ cwd, execute: () => { calls++; return result(); } }).status, 'incomplete');
  assert.equal(calls, 0);
});
test('npm exception/stderr text is not published', t => {
  const secret = 'synthetic-secret-never-publish';
  const report = runAudit({ cwd: workspace(t), execute: () => { throw new Error(secret); } });
  assert.equal(report.status, 'incomplete');
  assert(!JSON.stringify(report).includes(secret));
});
test('report-only suppresses findings exit only, never operational failures', () => {
  assert.equal(exitCode({ status: 'clean' }), 0);
  assert.equal(exitCode({ status: 'findings' }), 1);
  assert.equal(exitCode({ status: 'findings' }, true), 0);
  assert.equal(exitCode({ status: 'incomplete' }, true), 2);
});
test('markdown escapes advisory content instead of interpreting markup', t => {
  const malicious = { ...vulnerable(), via: [{ ...vulnerable().via[0], title: '<script>\n|[x](javascript:x)\\`' }] };
  const report = runAudit({ cwd: workspace(t), execute: () => result([malicious]) });
  const text = renderMarkdown(report);
  assert(!text.includes('<script>'));
  assert(!text.includes('[x]'));
  assert(text.includes('Status: **findings**'));
  assert(text.includes('not proof'));
  assert(text.includes('example@2.0.0 (major)'));
});
test('CLI help/invalid arguments do not invoke npm', () => {
  const script = new URL('../../scripts/audit-dependencies.mjs', import.meta.url);
  assert.equal(spawnSync(process.execPath, [script.pathname, '--help']).status, 0);
  assert.equal(spawnSync(process.execPath, [script.pathname, '--fix']).status, 2);
});

for (const [name, settings] of [
  ['環境変数のproduction=false', { env: { npm_config_production: 'false' } }],
  ['大文字の環境変数と旧dev指定', { env: { NPM_CONFIG_PRODUCTION: 'false', NPM_CONFIG_ALSO: 'dev', NPM_CONFIG_DEV: 'true' } }],
  ['プロジェクトのproduction=false', { project: 'production=false\n' }],
  ['プロジェクトの旧dev指定', { project: 'also=development\ndev=true\ninclude[]=dev\n' }],
  ['利用者の設定', { user: 'production=false\nalso=dev\ndev=true\n' }],
  ['グローバル設定', { global: 'production=false\nalso=development\ndev=true\n' }],
  ['本番用の環境と除外設定', { env: { NODE_ENV: 'production', npm_config_omit: 'optional' }, project: 'only=prod\noptional=false\n' }],
]) test(`${name}でも実npmの全依存・本番依存を分離する`, t => {
  const cwd = workspace(t);
  const manifest = { name: 'audit-scope-fixture', private: true,
    dependencies: { example: '1.0.0' }, devDependencies: { 'dev-tool': '3.0.0' },
    optionalDependencies: { 'optional-example': '1.0.0' }, peerDependencies: { 'peer-example': '1.0.0' } };
  const fixture = { lockfileVersion: 3, packages: {
    '': manifest,
    [path]: { version: '1.0.0' },
    'node_modules/dev-tool': { version: '3.0.0', dev: true, dependencies: { example: '1.0.1' } },
    [nested]: { version: '1.0.1', dev: true },
    'node_modules/optional-example': { version: '1.0.0', optional: true },
    'node_modules/peer-example': { version: '1.0.0', peer: true },
  } };
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(fixture));
  const configs = { '.npmrc': settings.project || '', 'user.npmrc': settings.user || '', 'global.npmrc': settings.global || '' };
  for (const [file, content] of Object.entries(configs)) writeFileSync(join(cwd, file), content);
  const inspected = [];
  const report = runAudit({ cwd, execute: (command, args, options) => {
    // npm lsはlockfileだけを読み、auditと同じ実際の設定解決で対象を選ぶ。外部通信なし。
    const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !/^npm_config_/i.test(key)));
    const inventory = spawnSync(command, ['ls', '--all', '--offline', ...args.slice(1),
      `--userconfig=${join(cwd, 'user.npmrc')}`, `--globalconfig=${join(cwd, 'global.npmrc')}`],
    { ...options, env: { ...env, ...settings.env } });
    assert.equal(inventory.status, 0, inventory.stderr);
    assert(!/invalid config/i.test(inventory.stderr), inventory.stderr);
    const graph = JSON.parse(inventory.stdout).dependencies;
    assert(graph.example && graph['optional-example'] && graph['peer-example']);
    const hasDev = Object.hasOwn(graph, 'dev-tool');
    inspected.push(hasDev);
    return result([vulnerable(hasDev ? [path, nested] : [path])]);
  } });
  assert.deepEqual(inspected, [true, false]);
  assert.equal(report.status, 'findings');
  assert.equal(report.filesUnchanged, true);
  assert.equal(report.findings[0].paths.find(node => node.path === nested).scope, 'full-graph-only');
  assert.equal(report.findings[0].paths.find(node => node.path === path).scope, 'production-graph');
  for (const [file, content] of Object.entries(configs)) assert.equal(readFileSync(join(cwd, file), 'utf8'), content);
});
