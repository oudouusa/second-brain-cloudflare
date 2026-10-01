// 計測環境専用。検索や本番のスキーマには組み込まない。
export const RESET_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_sb54_dirty_recall
ON entries(workspace_id, id) WHERE recall_count <> 0 OR last_recalled_at IS NOT NULL`;
export const RESET_IDS_SQL = `SELECT id FROM entries INDEXED BY idx_sb54_dirty_recall
WHERE workspace_id = ? AND (recall_count <> 0 OR last_recalled_at IS NOT NULL) LIMIT 21`;

export async function resetRecallCounters(db, workspace, marker) {
  const { results } = await db.prepare(RESET_IDS_SQL).bind(workspace).all();
  if (results.length > 20) throw new Error('リセット対象が20件を超過。計測を停止する');
  if (results.length) await db.batch(results.map(({ id }) => db.prepare(
    'UPDATE entries SET recall_count = 0, last_recalled_at = NULL, write_marker = ? WHERE id = ? AND workspace_id = ?',
  ).bind(marker, id, workspace)));
}

export function trackingContext(ctx, current) {
  return new Proxy(ctx, { get(target, key) {
    if (key === 'waitUntil') return promise => {
      const pending = current()?.pending;
      if (!pending) throw new Error('計測範囲外のバックグラウンド処理');
      pending.push(Promise.resolve(promise));
      target.waitUntil(promise);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export async function completeMetrics(response, metrics) {
  // MCPのストリームとwaitUntilを完了させてから集計。応答時間はこの待ち時間も含む。
  const body = await response.arrayBuffer();
  for (let offset = 0; offset < metrics.pending.length;) {
    const batch = metrics.pending.slice(offset); offset += batch.length;
    await Promise.all(batch);
  }
  const out = new Response(body, response);
  for (const [name, key] of [['statements','statements'], ['rows-read','rowsRead'], ['rows-written','rowsWritten']]) {
    if (!Number.isSafeInteger(metrics[key]) || metrics[key] < 0) throw new Error('D1メトリクスが不明');
    out.headers.set('x-sb54-' + metrics.stage + '-' + name, String(metrics[key]));
  }
  out.headers.set('x-sb54-' + metrics.stage + '-complete', '1');
  if (metrics.id) {
    // 既存の安全なログ形式を使い、DOのRPC invocationとsampleを正確に結び付ける。
    // 本番sanitizerの許可項目を増やさず、合成sampleのハッシュだけを出す。
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(metrics.id));
    const key = Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
    console.log(JSON.stringify({event:'http_request',operation:'sb54-'+metrics.stage+':'+key,method:'POST',status:response.status}));
  }
  return out;
}

export function readMetrics(headers, stage) {
  if (headers.get('x-sb54-' + stage + '-complete') !== '1') throw new Error('D1メトリクスが未完了');
  const result = {};
  for (const [name, key] of [['statements','statements'], ['rows-read','rowsRead'], ['rows-written','rowsWritten']]) {
    const raw = headers.get('x-sb54-' + stage + '-' + name);
    if (raw === null || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('D1メトリクスが不正');
    result[key] = Number(raw);
  }
  return result;
}
