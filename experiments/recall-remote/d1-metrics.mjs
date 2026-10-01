// Experimental instrumentation only. Values come from D1 metadata, never row counts.
export function measureD1(db, current) {
  const originals = new WeakMap();
  const record = result => {
    const metrics = current();
    if (!metrics) return result;
    metrics.statements++;
    for (const [field, key] of [["rowsRead", "rows_read"], ["rowsWritten", "rows_written"]]) {
      const value = result?.meta?.[key];
      if (!Number.isFinite(value) || value < 0) metrics[field] = null;
      else if (metrics[field] !== null) metrics[field] += value;
    }
    metrics.onResult?.({ sequence: metrics.statements,
      rowsRead: Number.isFinite(result?.meta?.rows_read) && result.meta.rows_read >= 0 ? result.meta.rows_read : null,
      rowsWritten: Number.isFinite(result?.meta?.rows_written) && result.meta.rows_written >= 0 ? result.meta.rows_written : null });
    return result;
  };
  const wrap = statement => {
    const proxy = {
      bind: (...values) => wrap(statement.bind(...values)),
      all: async () => record(await statement.all()),
      run: async () => record(await statement.run()),
      first: async column => {
        const result = record(await statement.all());
        const row = result.results[0];
        if (!row) return null;
        if (column === undefined) return row;
        if (!(column in row)) throw new Error("D1_COLUMN_NOTFOUND");
        return row[column];
      },
      // Do not silently claim complete metrics for an unsupported API.
      raw: () => { throw new Error("Uninstrumented D1 raw call"); },
    };
    originals.set(proxy, statement);
    return proxy;
  };
  return {
    prepare: sql => wrap(db.prepare(sql)),
    batch: async statements => {
      const raw = statements.map(statement => {
        if (!originals.has(statement)) throw new Error("Foreign D1 statement");
        return originals.get(statement);
      });
      return (await db.batch(raw)).map(record);
    },
    exec: () => { throw new Error("Initialize staging schema before measuring"); },
  };
}
