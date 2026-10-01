import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const FILES = ['package.json', 'package-lock.json'];
const MAX_OUTPUT = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Decode npm audit v2 only. Exit 1 can be findings, never assume an error is clean. */
export function decodeAudit(result, lock) {
  check(!result.error && !result.signal && [0, 1].includes(result.status), 'npm audit did not complete');
  check(typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) <= MAX_OUTPUT, 'invalid audit output');
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('invalid audit JSON'); }
  check(object(report) && !report.error && report.auditReportVersion === 2
    && object(report.vulnerabilities) && object(report.metadata?.vulnerabilities), 'unsupported or incomplete audit report');
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]));
  const findings = Object.entries(report.vulnerabilities).map(([name, item]) => {
    check(object(item) && item.name === name && SEVERITIES.includes(item.severity)
      && typeof item.isDirect === 'boolean' && typeof item.range === 'string'
      && Array.isArray(item.nodes) && item.nodes.length > 0
      && new Set(item.nodes).size === item.nodes.length
      && Array.isArray(item.via) && item.via.length > 0, 'invalid vulnerability record');
    const paths = item.nodes.map(path => {
      check(typeof path === 'string' && path.startsWith('node_modules/')
        && Object.hasOwn(lock.packages, path) && typeof lock.packages[path].version === 'string', 'audit path missing from lockfile');
      return { path, version: lock.packages[path].version };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const via = item.via.map(value => {
      if (typeof value === 'string') {
        check(Object.hasOwn(report.vulnerabilities, value), 'unresolved advisory dependency');
        return { dependency: value };
      }
      check(object(value) && Number.isSafeInteger(value.source) && value.source > 0
        && typeof value.title === 'string' && typeof value.url === 'string'
        && typeof value.range === 'string' && SEVERITIES.includes(value.severity), 'invalid advisory record');
      return { source: value.source, title: value.title, url: value.url, range: value.range, severity: value.severity };
    });
    const fix = item.fixAvailable;
    check(typeof fix === 'boolean' || object(fix) && typeof fix.name === 'string'
      && typeof fix.version === 'string' && typeof fix.isSemVerMajor === 'boolean', 'invalid fix metadata');
    counts[item.severity]++;
    return { name, severity: item.severity, direct: item.isDirect, range: item.range, paths, via, fixAvailable: fix };
  }).sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.name.localeCompare(b.name));
  const total = report.metadata.vulnerabilities;
  check(SEVERITIES.every(key => Number.isSafeInteger(total[key]) && total[key] === counts[key])
    && total.total === findings.length, 'audit totals do not match records');
  check(result.status === (findings.length ? 1 : 0), 'audit exit status does not match findings');
  return { counts: { ...counts, total: findings.length }, findings };
}

/** Scope is per lockfile path: one package name can occur in both graphs. */
export function classifyPaths(all, production) {
  const fullPaths = new Map(all.findings.map(item => [item.name, new Set(item.paths.map(node => node.path))]));
  const prodPaths = new Map(production.findings.map(item => [item.name, new Set(item.paths.map(node => node.path))]));
  for (const item of production.findings) {
    check(item.paths.every(node => fullPaths.get(item.name)?.has(node.path)), 'audit graphs disagree; rerun both scopes');
  }
  return all.findings.map(item => ({ ...item, paths: item.paths.map(node => ({ ...node,
    scope: prodPaths.get(item.name)?.has(node.path) ? 'production-graph' : 'full-graph-only',
  })) }));
}

export function auditArgs(production) {
  // npmの旧設定もCLIで固定する。production=false / also=dev / dev=trueはomitより優先される。
  return ['audit', '--json', '--package-lock-only', '--ignore-scripts', '--audit-level=info',
    '--registry=https://registry.npmjs.org', '--fetch-retries=0', '--fetch-timeout=20000',
    `--production=${production}`, '--also=null', '--no-dev',
    '--include=prod', '--include=optional', '--include=peer', production ? '--omit=dev' : '--include=dev'];
}

/** Read-only, bounded registry calls; no install, fix, secrets, or deployment. */
export function runAudit({ cwd = process.cwd(), execute = spawnSync } = {}) {
  const report = { schema: 'dependency-audit.v1', status: 'incomplete',
    generatedAt: new Date().toISOString(), registry: 'https://registry.npmjs.org',
    files: {}, filesUnchanged: false, all: null, production: null, findings: [], errors: [] };
  let before;
  try {
    before = FILES.map(file => readFileSync(resolve(cwd, file)));
    report.files = Object.fromEntries(FILES.map((file, i) => [file, hash(before[i])]));
    let lock;
    try { lock = JSON.parse(before[1].toString('utf8')); } catch { throw new Error('invalid lockfile JSON'); }
    check([2, 3].includes(lock.lockfileVersion) && object(lock.packages), 'unsupported lockfile');
    for (const [scope, production] of [['all', false], ['production', true]]) {
      const result = execute('npm', auditArgs(production), { cwd, encoding: 'utf8', timeout: 60000,
        maxBuffer: MAX_OUTPUT, shell: false, env: { ...process.env, NODE_ENV: 'development' } });
      report[scope] = decodeAudit(result, lock);
    }
    report.findings = classifyPaths(report.all, report.production);
    report.status = report.findings.length ? 'findings' : 'clean';
  } catch (error) {
    // Only our fixed diagnostics are public. npm stderr/exception text may contain credentials.
    const safe = new Set(['npm audit did not complete', 'invalid audit output', 'invalid audit JSON',
      'unsupported or incomplete audit report', 'invalid vulnerability record', 'audit path missing from lockfile',
      'unresolved advisory dependency', 'invalid advisory record', 'invalid fix metadata',
      'audit totals do not match records', 'audit exit status does not match findings',
      'audit graphs disagree; rerun both scopes', 'invalid lockfile JSON', 'unsupported lockfile']);
    report.errors.push(safe.has(error?.message) ? error.message : 'could not run read-only dependency audit');
  } finally {
    if (before) {
      try {
        report.filesUnchanged = FILES.every((file, i) => hash(readFileSync(resolve(cwd, file))) === hash(before[i]));
      } catch { /* missing file is also a mutation */ }
      if (!report.filesUnchanged) report.errors.push('dependency files changed during audit');
    }
    if (report.errors.length) report.status = 'incomplete';
  }
  return report;
}

const cell = value => String(value).replace(/[&<>|`\[\]\\\r\n\u0000-\u001f\u007f]/g, char => `&#${char.codePointAt(0)};`);
const fixText = value => value === false ? 'No fix reported' : value === true ? 'Fix reported; review required'
  : `${value.name}@${value.version}${value.isSemVerMajor ? ' (major)' : ''}`;

export function renderMarkdown(report) {
  const lines = ['# Dependency audit', '', `Status: **${report.status}**`, '',
    'This is dependency-graph exposure, not proof that a vulnerability is reachable in the Worker.',
    'Counts are affected package groups, not distinct advisories. Full-graph-only is not a safety exemption.', '',
    `Dependency files unchanged: **${report.filesUnchanged}**`, ''];
  for (const scope of ['all', 'production']) {
    const counts = report[scope]?.counts;
    lines.push(`${scope}: ${counts ? SEVERITIES.map(key => `${key}=${counts[key]}`).join(', ') + `; total=${counts.total}` : 'NOT COMPLETED'}`);
  }
  if (report.errors.length) lines.push('', ...report.errors.map(error => `Audit error: ${cell(error)}`));
  lines.push('', '| Package | Severity | Direct | Affected installed versions / paths | Fix metadata |',
    '| --- | --- | --- | --- | --- |');
  for (const item of report.findings) {
    lines.push(`| ${cell(item.name)} | ${item.severity} | ${item.direct} | ${item.paths.map(node =>
      cell(`${node.version}: ${node.path} (${node.scope})`)).join('<br>')} | ${cell(fixText(item.fixAvailable))} |`);
    for (const via of item.via) lines.push(`| Advisory for ${cell(item.name)} | | | ${cell(via.dependency
      ? `Via dependency: ${via.dependency}` : `${via.title} — ${via.url} — ${via.range}`)} | |`);
  }
  lines.push('', 'No dependencies were installed or upgraded. Remediation requires upstream-compatible review.', '');
  return lines.join('\n');
}

export function exitCode(report, reportOnly = false) {
  if (report.status === 'incomplete') return 2;
  return report.status === 'findings' && !reportOnly ? 1 : 0;
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/audit-dependencies.mjs [--report-only] [--output DIRECTORY]');
    return 0;
  }
  let output;
  let reportOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report-only' && !reportOnly) reportOnly = true;
    else if (args[i] === '--output' && !output && args[i + 1] && !args[i + 1].startsWith('--')) output = resolve(args[++i]);
    else { console.error('Invalid arguments; see --help'); return 2; }
  }
  const report = runAudit();
  if (output) {
    try {
      mkdirSync(output, { recursive: true });
      writeFileSync(resolve(output, 'audit.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      writeFileSync(resolve(output, 'audit.md'), renderMarkdown(report), { mode: 0o600 });
    } catch { console.error('Could not write audit evidence'); return 2; }
  }
  // One JSON line cannot inject GitHub workflow commands through advisory text.
  console.log(JSON.stringify(report));
  return exitCode(report, reportOnly);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
