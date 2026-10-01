import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";

describe("SQLite D1 の changes", () => {
  it("直接変更行と AFTER trigger/FTS の書込みを区別する", async () => {
    const sqlite = makeSqliteD1();
    try {
      const inserted = await sqlite.db.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at) VALUES ('entry', 'one', '[]', 'test', 1)`,
      ).run();
      expect(inserted.meta.rows_written).toBe(1);
      expect(inserted.meta.changes).toBeGreaterThan(1);

      const content = await sqlite.db.prepare(`UPDATE entries SET content = 'two' WHERE id = 'entry'`).run();
      expect(content.meta.rows_written).toBe(1);
      expect(content.meta.changes).toBeGreaterThan(1);

      const tags = await sqlite.db.prepare(`UPDATE entries SET tags = '["work"]' WHERE id = 'entry'`).run();
      expect(tags.meta.changes).toBe(1);

      const capsule = await sqlite.db.prepare(`UPDATE entries SET tags = '["capsule:core"]' WHERE id = 'entry'`).run();
      expect(capsule.meta.changes).toBeGreaterThan(1);

      await sqlite.db.prepare(`UPDATE entries SET write_marker = ? WHERE id = 'entry'`)
        .bind(sqlite.fixtureMarker("delete")).run();
      const removed = await sqlite.db.prepare(`DELETE FROM entries WHERE id = 'entry'`).run();
      expect(removed.meta.rows_written).toBe(1);
      expect(removed.meta.changes).toBeGreaterThan(1);
      expect((await sqlite.db.prepare(`DELETE FROM entries WHERE id = 'entry'`).run()).meta.changes).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
