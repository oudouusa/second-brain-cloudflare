import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const out = process.argv[2];
if (!out || readdirSync(out).length) throw new Error("新しい空の出力ディレクトリを指定してください");
const root = resolve(import.meta.dirname, "../..");
const quote = value => typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now(), old = now - 180 * 86400000;
let sql = readFileSync(resolve(root, "db/schema.sql"), "utf8") + "\n";
sql += "UPDATE memory_write_epoch SET generation='sb80-seed' WHERE id='current';\n";
sql += "INSERT INTO memory_write_admissions VALUES('sb80-seed',0,9007199254740991,'sb80-seed');\n";
sql += "CREATE TABLE sb80_fixture(id TEXT PRIMARY KEY,content TEXT NOT NULL,tags TEXT NOT NULL,created_at INTEGER NOT NULL);\n";
const rows = Array.from({ length: 200 }, (_, i) => ({
  id: `solo-e${i}`, content: `Synthetic person ${i} works on project ${Math.floor(i / 11) % 7}.`,
  tags: JSON.stringify(i < 77 ? [`topic-${Math.floor(i / 11)}`] : ["noise", "synthesized", "status:deprecated"]),
  created: old + i,
}));
for (let offset = 0; offset < rows.length; offset += 25) {
  const part = rows.slice(offset, offset + 25);
  sql += "INSERT INTO entries(id,content,tags,source,created_at,write_marker) VALUES "
    + part.map(row => `(${[row.id,row.content,row.tags,"api",row.created,`sb80-seed:write:${row.id}`].map(quote).join(",")})`).join(",") + ";\n";
  sql += "INSERT INTO sb80_fixture VALUES "
    + part.map(row => `(${[row.id,row.content,row.tags,row.created].map(quote).join(",")})`).join(",") + ";\n";
}
sql += "DELETE FROM memory_write_admissions WHERE token='sb80-seed';\n";
const db = new DatabaseSync(":memory:");
db.exec(sql);
if (db.prepare("SELECT COUNT(*) n FROM entries").get().n !== 200) throw new Error("fixture不一致");
db.close();
const secret = randomBytes(32).toString("hex");
writeFileSync(resolve(out,"seed.sql"),sql,{flag:"wx",mode:0o600});
writeFileSync(resolve(out,"private-settings.json"),JSON.stringify({secret}),{flag:"wx",mode:0o600});
writeFileSync(resolve(out,"manifest.json"),JSON.stringify({sourceRows:200,activeRows:77,now,
  seedSha256:createHash("sha256").update(sql).digest("hex")},null,2)+"\n",{flag:"wx",mode:0o600});
console.log("200件の合成fixtureをローカルSQLiteで検証・保存しました。");
