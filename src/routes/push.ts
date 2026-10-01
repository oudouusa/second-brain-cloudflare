/**
 * Web Push subscription management and admin trigger routes.
 *
 * Encryption and VAPID live in src/push/crypto.ts and src/push/vapid.ts; the
 * sender lives in src/push/send.ts and is wired into the hourly
 * integration-sync cron (src/index.ts). This file is the HTTP surface: a
 * device registers/unregisters here, and an admin can fire the sender
 * on demand for live testing.
 */
import type { Env } from "../env";
import { json } from "../lib/http";
import { requireAdmin, requireIdentity } from "../lib/identity";
import { readableWorkspaces, scopeWhere } from "../lib/scope";
import { getOrCreateVapidKeys, recordPushOrigin } from "../push/vapid";
import { toBase64Url } from "../push/base64url";
import { newPushBudget, pushDueItems, sendTestNotification } from "../push/send";

/** POST /push/run's results array cap — a diagnostic sample, not a full audit log. */
const MAX_REPORTED_PUSH_RUN_RESULTS = 10;

interface SubscriptionBody {
  subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  content_free?: boolean;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function validSubscription(body: SubscriptionBody): body is Required<SubscriptionBody> & { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } } {
  const sub = body.subscription;
  return !!sub && typeof sub.endpoint === "string" && !!sub.endpoint.trim()
    && !!sub.keys && typeof sub.keys.p256dh === "string" && !!sub.keys.p256dh.trim()
    && typeof sub.keys.auth === "string" && !!sub.keys.auth.trim();
}

export async function handlePushRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /push/vapid-public-key — what applicationServerKey the client passes to pushManager.subscribe.
  if (url.pathname === "/push/vapid-public-key" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const keys = await getOrCreateVapidKeys(env);
    return json({ ok: true, publicKey: toBase64Url(keys.publicKeyRaw) });
  }

  // POST /push/subscribe — one row per device, scoped to the caller's personal
  // workspace (a browser's notification permission belongs to the person using
  // it, not to whatever workspace their captures default to). Re-subscribing
  // the same endpoint replaces the stored keys and clears any failure streak.
  if (url.pathname === "/push/subscribe" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: SubscriptionBody;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!validSubscription(body)) {
      return json({ ok: false, error: "subscription.endpoint and subscription.keys.{p256dh,auth} are required" }, 400);
    }

    const endpointHash = await sha256Hex(body.subscription.endpoint);
    const workspaceId = auth.personalWorkspaceId;

    // The one place a real Request proves this deployment's own origin — a
    // cron-driven send has none to ask. See src/push/vapid.ts.
    await recordPushOrigin(env, new URL(request.url).origin);

    await env.DB.prepare(
      `INSERT INTO push_subscriptions (id, workspace_id, endpoint_hash, subscription_json, content_free, created_at, fail_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(endpoint_hash) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         subscription_json = excluded.subscription_json,
         content_free = excluded.content_free,
         fail_count = 0`,
    ).bind(
      crypto.randomUUID(), workspaceId, endpointHash,
      JSON.stringify(body.subscription), body.content_free ? 1 : 0, Date.now(),
    ).run();

    return json({ ok: true });
  }

  // POST /push/unsubscribe — scoped to every workspace the caller can read, so
  // unsubscribing works regardless of which workspace the subscription landed
  // in (subscribe always uses personalWorkspaceId today, but a subscription
  // from before a share-target change must still be removable).
  if (url.pathname === "/push/unsubscribe" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { endpoint?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.endpoint?.trim()) return json({ ok: false, error: "endpoint is required" }, 400);

    const endpointHash = await sha256Hex(body.endpoint.trim());
    const scope = scopeWhere(auth);
    await env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND ${scope.clause}`,
    ).bind(endpointHash, ...scope.bindings).run();

    return json({ ok: true });
  }

  // POST /push/run (admin) — fires the same sender the hourly cron does,
  // against every workspace the caller can read. The live-test hook: a
  // browser test subscribes, calls this, and expects a notification.
  if (url.pathname === "/push/run" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const workspaces = [...new Set(readableWorkspaces(auth))];
    const budget = newPushBudget();
    const perWorkspace = [];
    for (const workspace of workspaces.slice(0, 4)) {
      perWorkspace.push(await pushDueItems(env, workspace, undefined, budget));
      if (!budget.fetchesLeft) break;
    }
    const sent = perWorkspace.reduce((n, r) => n + r.sent, 0);
    const candidates = perWorkspace.reduce((n, r) => n + r.candidates, 0);
    const subscriptions = perWorkspace.reduce((n, r) => n + r.subscriptions, 0);
    // Capped again here: each workspace's own results are already capped, but
    // several small workspaces together could still exceed the cap.
    const results = perWorkspace.flatMap(r => r.results).slice(0, MAX_REPORTED_PUSH_RUN_RESULTS);
    // "busy": another run held the lease; "kv_write_failed": nothing was sent, so nothing repeats.
    const skipped = perWorkspace.find(r => r.skipped)?.skipped;

    return json({ ok: true, sent, candidates, subscriptions, results, ...(skipped ? { skipped } : {}) });
  }

  // POST /push/test (admin) — a fixed notification to the caller's own
  // subscriptions, bypassing the due query entirely: proves the
  // subscribe -> encrypt -> deliver path works even with no due items.
  // results[] mirrors POST /push/run's, sharing sendTestNotification's own
  // aggregation rather than reporting only counts — a sent:0 with no way to
  // see WHY (wrong VAPID subject, a stale endpoint, a network error) is
  // exactly what hid the Apple/Safari VAPID-subject rejection this exists
  // to make visible.
  if (url.pathname === "/push/test" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const workspaces = [...new Set(readableWorkspaces(auth))];
    const budget = newPushBudget();
    const perWorkspace = [];
    for (const workspace of workspaces.slice(0, 4)) {
      perWorkspace.push(await sendTestNotification(env, workspace, budget));
      if (!budget.fetchesLeft) break;
    }
    const sent = perWorkspace.reduce((n, r) => n + r.sent, 0);
    const subscriptions = perWorkspace.reduce((n, r) => n + r.subscriptions, 0);
    const results = perWorkspace.flatMap(r => r.results).slice(0, MAX_REPORTED_PUSH_RUN_RESULTS);

    return json({ ok: true, sent, subscriptions, results });
  }

  return null;
}
