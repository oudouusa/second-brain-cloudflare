import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { readMetrics } from './measurement.mjs';
import { stagingEndpoint, rpcReply } from './protocol.mjs';
import { selectModes } from './runner-modes.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const folder=process.argv[2];
if(!folder)throw Error('Usage: run.mjs FIXTURE_DIR ENDPOINT OUTPUT [smoke|full]');
const source=()=>execFileSync('git',['rev-parse','HEAD:src'],{cwd:root,encoding:'utf8'}).trim();
execFileSync('git',['diff','--exit-code','HEAD','--','src'],{cwd:root,stdio:'pipe'});
const sourceTree=source();
const settings=JSON.parse(readFileSync(folder+'/private-settings.json','utf8'));
const [endpoint, output, scope='smoke']=process.argv.slice(3);
const url=stagingEndpoint(endpoint);
const remote=!['127.0.0.1','localhost'].includes(url.hostname);
let budget=null;
let approvalPath=null;
if(remote) {
 approvalPath=process.argv[6];
 if(!approvalPath) throw Error('遠隔実行には新しい承認済み予算ファイルが必要');
 budget=JSON.parse(readFileSync(approvalPath,'utf8'));
 if(budget.endpoint!==url.origin || budget.sourceTree!==sourceTree
   || !Number.isFinite(Date.parse(budget.expiresAt)) || Date.parse(budget.expiresAt)<=Date.now()
   || !Array.isArray(budget.fixtureIds) || !budget.fixtureIds.length
   || new Set(budget.fixtureIds).size!==budget.fixtureIds.length
   || budget.fixtureIds.some(id=>!settings.fixtures.some(f=>f.id===id))
   || !Number.isInteger(budget.maxCalls) || budget.maxCalls<2 || budget.maxCalls>800
   || !Number.isInteger(budget.maxRowsRead) || budget.maxRowsRead<1 || budget.maxRowsRead>1000000
   || !Number.isInteger(budget.maxRowsWritten) || budget.maxRowsWritten<1 || budget.maxRowsWritten>20000)
   throw Error('承認予算が無効・期限切れ・対象不一致');
}
const selectedModes=selectModes(budget);
const consumed={calls:0,rowsRead:0,rowsWritten:0};
const journal=()=>appendFileSync(output+'.usage.jsonl',JSON.stringify({...consumed,at:new Date().toISOString()})+'\n');
const beforeCall=()=>{
 if(budget && (consumed.calls>=budget.maxCalls || consumed.rowsRead>=budget.maxRowsRead
   || consumed.rowsWritten>=budget.maxRowsWritten || Date.now()>=Date.parse(budget.expiresAt))) throw Error('予算到達、再試行せず停止');
 consumed.calls++; journal();
};
const accountMetrics=(...metrics)=>{
 for(const m of metrics) {consumed.rowsRead+=m.rowsRead;consumed.rowsWritten+=m.rowsWritten;}
 journal();
 // これは応答で得た実使用量による停止。単一呼出の超過やアカウント他用途の消費は止められない。
 if(budget && (consumed.rowsRead>budget.maxRowsRead || consumed.rowsWritten>budget.maxRowsWritten)) throw Error('D1予算超過、再試行せず停止');
};
if(!output||!['smoke','full'].includes(scope)) throw Error('output and valid scope required');
if([output,output+'.manifest.json',output+'.summary.json',output+'.usage.jsonl'].some(existsSync))throw Error('Output already exists');
if(approvalPath) writeFileSync(approvalPath+'.started',JSON.stringify({output,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
writeFileSync(output+'.usage.jsonl','',{flag:'wx',mode:0o600});
const selectedFixtures=budget?settings.fixtures.filter(f=>budget.fixtureIds.includes(f.id)):settings.fixtures;
const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync(output+'.manifest.json',JSON.stringify({sourceTree,remoteMeasurements:!['127.0.0.1','localhost'].includes(url.hostname),remoteGatePassed:false,realModelQualityMeasured:false,fixtureManifestSha256:hashFile(folder+'/fixture-manifest.json'),adapterSha256:hashFile(root+'/experiments/recall-remote/worker.ts'),metricsSha256:hashFile(root+'/experiments/recall-remote/d1-metrics.mjs'),measurementSha256:hashFile(root+'/experiments/recall-remote/measurement.mjs'),budget,runnerSha256:hashFile(import.meta.filename),runnerModesSha256:hashFile(root+'/experiments/recall-remote/runner-modes.mjs'),modes:selectedModes,endpoint:url.origin,scope,repetitions:scope==='smoke'?1:3},null,2),{flag:'wx',mode:0o600});
writeFileSync(output,'',{flag:'wx',mode:0o600});
let invocations=0; const started=Date.now(); const samples=[];
for(const fixture of scope==='smoke'?selectedFixtures.slice(0,1):selectedFixtures) {
 for(const mode of selectedModes) for(let repetition=-1;repetition<(scope==='smoke'?1:3);repetition++) {
  if(++invocations>1000||Date.now()-started>3600000) throw Error('invocation/time cap');
  const id=`${fixture.id}-${mode}-${repetition<0?'warmup':repetition}`;
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream','x-sb54-sample':id,'x-sb54-fixture':fixture.id,'x-sb54-mode':mode};
  beforeCall();
  const reset=await fetch(new URL('/reset',url),{method:'POST',headers:{...headers,authorization:`Bearer ${settings.secret}`},signal:AbortSignal.timeout(60000)});
  await reset.text();
  if(!reset.ok) throw Error('reset failed: '+reset.status);
  const resetMetrics=readMetrics(reset.headers,'reset');
  accountMetrics(resetMetrics);
  invocations++;
  const start=performance.now(); let status=null,elapsedMs=null,ids=[],error=null,bodySha256=null,publicMetrics=null,doMetrics=null;
  try {
   beforeCall();
   const response=await fetch(new URL('/mcp',url),{method:'POST',headers:{...headers,authorization:`Bearer ${fixture.token}`},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'recall',arguments:{query:fixture.query,topK:5,hops:0,kind:'semantic',workspace:'personal'}}}),signal:AbortSignal.timeout(60000)});
   const raw=await response.text(); status=response.status; elapsedMs=performance.now()-start;
   publicMetrics=readMetrics(response.headers,'public'); doMetrics=readMetrics(response.headers,'do');
   accountMetrics(publicMetrics,doMetrics);
   bodySha256=createHash('sha256').update(raw).digest('hex');
   const payload=rpcReply(raw,id);
   if(!response.ok||payload.error||payload.result?.isError) error='http-or-mcp-error';
   const text=(payload.result?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
   ids=[...text.matchAll(/^ID: (.+)$/gm)].map(m=>m[1]);
   if(!ids.length&&!text.includes('Nothing found matching that query.')) error='unrecognized-result';
   if(ids.some(entry=>!entry.startsWith(fixture.id+'-'))) error='foreign-workspace';
  } catch(e) {error=e.name;elapsedMs=performance.now()-start;}
  const row={id,fixture:fixture.id,fixtureSha256:fixture.sha256,mode,repetition,warmup:repetition<0,status,elapsedMs,ids,rank:ids.indexOf(fixture.id+'-answer')+1,error,bodySha256,publicMetrics,doMetrics,resetMetrics,consumed:{...consumed},at:new Date().toISOString()};
  appendFileSync(output,JSON.stringify(row)+'\n');
  samples.push({...row,workload:fixture.workload});
  console.log(JSON.stringify({id,status,rank:row.rank,error,elapsedMs:Math.round(elapsedMs)}));
  if(error) throw Error('sample error; stopped for diagnosis');
 }
}

if(source()!==sourceTree)throw Error('Source changed during the run; evidence invalid');
execFileSync('git',['diff','--exit-code','HEAD','--','src'],{cwd:root,stdio:'pipe'});
const measured=samples.filter(s=>!s.warmup);
const knownLimits=measured.filter(s=>s.workload==='equal-authority-overflow'&&s.mode!=='healthy');
const required=measured.filter(s=>!knownLimits.includes(s));
const failed=required.filter(s=>s.error||(s.workload==='no-answer'?s.ids.length!==0:s.rank===0));
const summary={samples:measured.length,required:required.length,requiredPassed:required.length-failed.length,
  knownLimits:knownLimits.length,knownLimitHits:knownLimits.filter(s=>s.rank>0).length,
  remoteGatePassed:false,realModelQualityMeasured:false,failed:failed.map(s=>s.id)};
writeFileSync(output+'.summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
console.log(JSON.stringify(summary));
if(failed.length)process.exitCode=1;
