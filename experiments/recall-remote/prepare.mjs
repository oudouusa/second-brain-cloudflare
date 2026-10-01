import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const out = process.argv[2];
if (!out) throw Error('Usage: node experiments/recall-remote/prepare.mjs EXISTING_EMPTY_OUTPUT_DIR');
if (readdirSync(out).length) throw Error('Output directory must be empty');
const sha = x => createHash('sha256').update(x).digest('hex');
const secret = randomBytes(32).toString('hex');
const quote = x => typeof x === 'number' ? String(x) : "'" + String(x).replaceAll("'", "''") + "'";
const now = Date.UTC(2026,8,6), old = now-180*86400000;
let sql = readFileSync(root+'/db/schema.sql','utf8')+'\n';
sql += "UPDATE memory_write_epoch SET generation='sb54-seed' WHERE id='current';\n";
sql += "INSERT INTO memory_write_admissions(token,started_at,expires_at,generation) VALUES('sb54-seed',0,9007199254740991,'sb54-seed');\n";
const fixtures=[];
for(const size of [200,1000,10000]) for(const workload of ['ordinary-noise','excluded-window','equal-authority-overflow','no-answer']) for(const language of ['en','ja']) {
 const id=`${size}-${workload}-${language}`, ws=`ws-${id}`, user=`user-${id}`;
 const token=createHmac('sha256',secret).update(id).digest('hex');
 sql+=`INSERT INTO users(id,role,token_hash,created_at,last_used_at) VALUES(${[user,'member',sha(token),now,Date.now()].map(quote)});\n`;
 sql+=`INSERT INTO workspaces(id,kind,name,created_at) VALUES(${[ws,'personal',id,now].map(quote)});\n`;
 sql+=`INSERT INTO memberships(user_id,workspace_id,created_at) VALUES(${[user,ws,now].map(quote)});\n`;
 const word=language==='en'?'cat':'認証';
 const recipe=[{id:`${id}-answer`,content:`${word} decision approved.`,createdAt:old,importance:5,tags:['kind:semantic','status:canonical']}];
 for(let i=0;i<size-1;i++) {
  const excluded=workload==='excluded-window'&&i>=8, authority=workload==='equal-authority-overflow'&&i<40, usable=workload==='excluded-window'&&i<8;
  recipe.push({id:`${id}-noise-${i}`,createdAt:now-i,content:excluded||authority||usable?`${word} decision approved.`:language==='en'?'We concatenate routine fields.':'認証x 定例メモ。',importance:excluded||authority?5:0,tags:['kind:semantic',...(excluded||authority||usable?['status:canonical']:[]),...(excluded?['status:deprecated']:[])]});
 }
 for(let offset=0;offset<recipe.length;offset+=100) {
  const values=recipe.slice(offset,offset+100).map(e=>'('+[e.id,e.content,JSON.stringify(e.tags),'api',e.createdAt,e.importance,ws,user,'sb54-seed:write:'+e.id].map(quote).join(',')+')');
  sql+='INSERT INTO entries(id,content,tags,source,created_at,importance_score,workspace_id,actor_id,write_marker) VALUES'+values.join(',')+';\n';
 }
 fixtures.push({id,size,workload,language,query:workload==='no-answer'?'unobtainium-9f872e':word,token,sha256:sha(JSON.stringify(recipe))});
}
sql+="DELETE FROM memory_write_admissions WHERE token='sb54-seed';\n";
const db=new DatabaseSync(':memory:'); db.exec(sql);
const count=db.prepare('SELECT count(*) n FROM entries').get().n;
if(count!==89600) throw Error('unexpected seed size');
writeFileSync(out+'/seed.sql',sql,{flag:'wx',mode:0o600});
writeFileSync(out+'/private-settings.json',JSON.stringify({secret,fixtures},null,2),{flag:'wx',mode:0o600});
writeFileSync(out+'/fixture-manifest.json',JSON.stringify({totalEntries:count,seedSha256:sha(sql),fixtures:fixtures.map(({token,...f})=>f)},null,2),{flag:'wx'});
console.log(JSON.stringify({fixtures:fixtures.length,totalEntries:count,sqlBytes:Buffer.byteLength(sql),seedSha256:sha(sql)}));
