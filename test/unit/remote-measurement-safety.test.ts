import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { RESET_INDEX_SQL, RESET_IDS_SQL, resetRecallCounters, completeMetrics, readMetrics, trackingContext } from '../../experiments/recall-remote/measurement.mjs';

describe('隔離計測のリセットと完全なメトリクス', () => {
  it('通常1万行を書き換えず変更済みの行だけを所属先内でリセットする', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec('CREATE TABLE entries(id TEXT PRIMARY KEY,workspace_id TEXT,recall_count INTEGER DEFAULT 0,last_recalled_at INTEGER,write_marker TEXT)');
      const insert = sqlite.prepare('INSERT INTO entries(id,workspace_id,recall_count) VALUES(?,?,?)');
      for (let i=0;i<10000;i++) insert.run(String(i),'a',i<5?1:0);
      insert.run('foreign','b',1);
      sqlite.exec(RESET_INDEX_SQL);
      expect(JSON.stringify(sqlite.prepare('EXPLAIN QUERY PLAN '+RESET_IDS_SQL).all('a'))).toContain('idx_sb54_dirty_recall');
      const writes: string[] = [];
      const db = {prepare: (sql: string) => ({bind: (...args: any[]) => ({
        all: async () => ({results:sqlite.prepare(sql).all(...args)}),
        run: async () => { writes.push(sql); return sqlite.prepare(sql).run(...args); },
      })}),batch: async (statements: any[]) => Promise.all(statements.map(s=>s.run()))};
      await resetRecallCounters(db,'a','marker');
      expect(writes).toHaveLength(5);
      expect(sqlite.prepare('SELECT count(*) n FROM entries WHERE write_marker IS NOT NULL').get()).toEqual({n:5});
      expect(sqlite.prepare("SELECT recall_count FROM entries WHERE id='foreign'").get()).toEqual({recall_count:1});
      await resetRecallCounters(db,'a','marker');
      expect(writes).toHaveLength(5);
      sqlite.exec("UPDATE entries SET recall_count=1 WHERE workspace_id='a'");
      await expect(resetRecallCounters(db,'a','marker')).rejects.toThrow('20件');
      expect(writes).toHaveLength(5);
    } finally {sqlite.close();}
  });
  it('ネストしたwaitUntilも完了後にpublic/DO別の値を送る', async () => {
    const s={stage:'do',pending:[] as Promise<unknown>[],statements:0,rowsRead:0,rowsWritten:0};
    const ctx=trackingContext({waitUntil: (_:Promise<unknown>)=>{}},()=>s);
    ctx.waitUntil(Promise.resolve().then(()=>{
      s.statements++;s.rowsRead+=2;
      ctx.waitUntil(Promise.resolve().then(()=>{s.statements++;s.rowsRead+=3;s.rowsWritten++;}));
    }));
    const out=await completeMetrics(new Response('result'),s);
    expect(await out.text()).toBe('result');
    expect(readMetrics(out.headers,'do')).toEqual({statements:2,rowsRead:5,rowsWritten:1});
    expect(()=>readMetrics(out.headers,'public')).toThrow();
  });
  it('欠落・null・不正なメトリクスを0へ変換しない', async () => {
    for(const value of [null,NaN,-1]) await expect(completeMetrics(new Response('x'),{
      stage:'do',pending:[],statements:1,rowsRead:value,rowsWritten:0,
    })).rejects.toThrow();
    const out=await completeMetrics(new Response('x'),{stage:'do',pending:[],statements:1,rowsRead:0,rowsWritten:0});
    for(const value of ['', 'null', 'NaN', '-1','1.5']) {
      out.headers.set('x-sb54-do-rows-read',value);
      expect(()=>readMetrics(out.headers,'do')).toThrow();
    }
  });
  it('バックグラウンドの失敗を成功メトリクスにしない', async () => {
    await expect(completeMetrics(new Response('x'),{stage:'do',pending:[Promise.resolve().then(()=>{throw Error('failure');})]})).rejects.toThrow('failure');
  });
});

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

it('遠隔予算を対象・期限・fixtureで検証し、一度だけ消費する', () => {
  const folder=mkdtempSync(resolve(tmpdir(),'sb54-budget-test-'));
  const root=resolve(import.meta.dirname,'../..');
  const endpoint='https://sb54-candidate-20260907.staging-example.workers.dev';
  const sourceTree=execFileSync('git',['rev-parse','HEAD:src'],{cwd:root,encoding:'utf8'}).trim();
  const fixture='200-ordinary-noise-en';
  writeFileSync(folder+'/private-settings.json',JSON.stringify({secret:'test',fixtures:[{id:fixture,token:'test'}]}));
  writeFileSync(folder+'/fixture-manifest.json','{}');
  // 検証自体のネットワーク接続を禁止する。
  writeFileSync(folder+'/no-network.mjs',"globalThis.fetch=async()=>{throw Error('NETWORK_BLOCKED_BY_TEST')}");
  const budget={endpoint,sourceTree,expiresAt:new Date(Date.now()+60000).toISOString(),maxCalls:2,maxRowsRead:1000,maxRowsWritten:100,fixtureIds:[fixture]};
  const run=(file?:string)=>spawnSync(process.execPath,['--import',folder+'/no-network.mjs',root+'/experiments/recall-remote/run.mjs',folder,endpoint,folder+'/result','smoke',...(file?[file]:[])],{encoding:'utf8'});
  try {
    expect(run().stderr).toContain('承認済み予算');
    for(const invalid of [{...budget,expiresAt:'invalid'},{...budget,endpoint:'https://example.com'},{...budget,fixtureIds:['foreign']},{...budget,maxRowsRead:1000001}]) {
      writeFileSync(folder+'/approval.json',JSON.stringify(invalid));
      const result=run(folder+'/approval.json');
      expect(result.stderr).toContain('承認予算が無効');
      expect(result.stderr).not.toContain('NETWORK_BLOCKED');
      expect(existsSync(folder+'/approval.json.started')).toBe(false);
    }
    for (const modes of [[], ['unknown'], ['healthy', 'healthy'], null]) {
      writeFileSync(folder+'/approval.json', JSON.stringify({ ...budget, modes }));
      const result = run(folder+'/approval.json');
      expect(result.stderr).toContain('予算のmode指定が不正');
      expect(result.stderr).not.toContain('NETWORK_BLOCKED');
      expect(existsSync(folder+'/approval.json.started')).toBe(false);
    }
    writeFileSync(folder+'/approval.json',JSON.stringify(budget));
    expect(run(folder+'/approval.json').stderr).toContain('NETWORK_BLOCKED_BY_TEST');
    expect(existsSync(folder+'/approval.json.started')).toBe(true);
    for(const suffix of ['', '.manifest.json','.usage.jsonl']) rmSync(folder+'/result'+suffix,{force:true});
    expect(run(folder+'/approval.json').stderr).toContain('EEXIST');
  } finally {rmSync(folder,{recursive:true,force:true});}
});
