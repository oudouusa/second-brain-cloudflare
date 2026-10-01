// SH-1: the history timeline on the memory sheet. renderHistory(entry) reads
// entry.history (contract 4.1 of the v4 UX build spec) and replaces the plain
// event list memory-crud.js used to draw by hand. memory-crud.js's
// renderViewTimeline delegates here when entry.history is present, and keeps
// its own old rendering as the fallback for a Worker that predates it.

const HISTORY_REASON_KEYS = {
  update: 'reasonUpdate',
  append: 'reasonAppend',
  merge: 'reasonMerge',
  replace: 'reasonReplace',
  rollup: 'reasonRollup',
  status: 'reasonStatus',
  due: 'reasonDue',
  mirror: 'reasonMirror',
  revert: 'reasonRevert',
  // T-0101.6.1: a reason:"validity" row is handled separately, by cause
  // (historyValidityLabel below) — reasonValidity is only the fallback for a
  // cause this dashboard does not (yet) recognize.
  validity: 'reasonValidity',
}

/**
 * T-0101.6.1 (spec 14 section 7.6/backend T-0089.2.3): entry.history.items' cause on a
 * reason:"validity" row, matched to src/memory/validity.ts's five real cause values —
 * supersede (capture-time contradiction), retraction/unretraction (a Wrong toggle and its
 * undo) and explicit/propagate (an end date set directly, or moved to match a newer capture
 * that closed the gap it left).
 */
const VALIDITY_CAUSE_KEYS = {
  supersede: 'historyReplaced',
  retraction: 'historyCurrentAgain',
  unretraction: 'historyReplacedAgain',
  explicit: 'historyEndSet',
  propagate: 'historyEndMoved',
}

/** Short date, matching the sheet's own validity labels (memory-crud.js's shortDate). */
function historyValidityDate(ms) {
  return typeof ms === 'number' ? formatDateUI(ms, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
}

/**
 * A validity-caused history row's own sentence. `previewMap` is built once per render by
 * collectValidityPreviews below: `item.by` names another entry only by id, so the preview text
 * it needs is resolved ahead of time rather than inside this (synchronous) formatter.
 * `previewMap.get(id)` is `null` for a `by` id that no longer resolves (the memory that closed
 * this one was itself deleted since) — the one case with its own copy, historyCurrentAgainDeleted.
 */
function historyValidityLabel(item, previewMap) {
  const key = VALIDITY_CAUSE_KEYS[item.cause]
  if (!key) return t('history.reasonValidity')
  const until = historyValidityDate(item.until)
  if (key === 'historyEndSet') return t(`validity.${key}`, { until })
  const preview = item.by ? previewMap.get(item.by) : undefined
  if (item.cause === 'retraction' && item.by && preview === null) return t('validity.historyCurrentAgainDeleted')
  return t(`validity.${key}`, { preview: preview || '', until })
}

/**
 * The status a `reason: "status"` row changed the memory TO. `before_status`
 * on a row is the status before THAT row's change, so the destination is the
 * nearest earlier change row's `before_status` — or, for the newest change,
 * the entry's current status tag.
 */
function historyStatusTarget(items, index, entry) {
  for (let i = index - 1; i >= 0; i--) {
    if (items[i].kind === 'change') return items[i].before_status
  }
  return typeof tagValue === 'function' ? tagValue(entry.tags || [], 'status:') : null
}

/**
 * S5 (deck section 9): the too-long hold has no automatic check to report,
 * so its own change row reads "Held: too long to check automatically"
 * instead of the ordinary "Status changed to Unconfirmed" a ordinary hold's
 * status-change row would otherwise show. The other four hold reasons have
 * no distinct history key (deck section 7.9 gives one only for too_long),
 * so they keep whatever their own `reason` already renders as - the sheet's
 * held banner and the timeline's own "Held" event row already name them.
 */
function historyReasonLabel(item, index, items, entry, previewMap) {
  if (item.hold && item.hold.reason === 'too_long') return t('history.reasonHeldTooLong')
  const key = HISTORY_REASON_KEYS[item.reason]
  if (!key) return item.reason || ''
  if (item.reason === 'validity') return historyValidityLabel(item, previewMap || new Map())
  if (item.reason === 'status') {
    const target = historyStatusTarget(items, index, entry)
    const label = target && typeof viewStatusLabel === 'function' ? viewStatusLabel(target) : target || ''
    return t(`history.${key}`, { status: label })
  }
  return t(`history.${key}`)
}

/** {provider} for a synced-source row: the entry's own source, read the same way everywhere it is shown. */
/** A brand name for a sentence ("synced from Notion"), not the lowercase badge label. */
function historyProvider(entry) {
  return (typeof providerName === 'function' ? providerName(entry.source) : entry.source) || ''
}

/**
 * "you" for the viewer's own change, in team mode only — a solo brain has no
 * one else to distinguish from, so it keeps showing the real name there, the
 * same as the rest of the sheet does. `memoryAuthors` (recent.js) is the
 * app's one existing source for "which member am I"; a page that has not
 * loaded it (or a solo brain, which never does) leaves names untouched.
 */
function historyActorDisplay(name) {
  if (!name) return ''
  // A solo brain has exactly one human, the owner, and the dashboard is
  // always the owner: every human-authored row is the viewer's own, with
  // nobody else it could be. TEAM_MODE is declared once in api.js, which
  // loads before this file, so the bare reference matches the rest of the
  // dashboard (home.js, board.js) rather than guarding it here too.
  if (!TEAM_MODE) return t('history.actorYou')
  if (typeof memoryAuthors !== 'undefined' && memoryAuthors && memoryAuthors.you) {
    const me = (memoryAuthors.members || []).find((m) => m.userId === memoryAuthors.you)
    if (me && me.name === name) return t('history.actorYou')
  }
  return name
}

function historyWhoLabel(item, entry) {
  if (item.channel === 'system:digest') return t('history.byDigest')
  if (item.channel === 'system:insight') return t('history.byInsight')
  if (item.channel === 'system:mirror') return t('history.bySync', { provider: historyProvider(entry) })
  const actor = historyActorDisplay(item.actor_name)
  if (item.client) return t('history.byClient', { actor, client: item.client })
  if (item.channel === 'mcp') return t('history.byAgent', { actor })
  return t('history.byDashboard', { actor })
}

function historyDate(at) {
  return at ? formatDateUI(at, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
}

function renderHistoryChangeRow(item, index, items, entry, previewMap) {
  const meta = [historyReasonLabel(item, index, items, entry, previewMap), historyDate(item.at), historyWhoLabel(item, entry)].filter(Boolean).join(' · ')
  const actions = []
  if (item.can_undo) {
    actions.push(`<button type="button" class="history-action" data-action="undo">${escHtml(t('history.undo'))}</button>`)
  } else if (item.can_restore) {
    actions.push(`<button type="button" class="history-action" data-action="restore-version">${escHtml(t('history.restoreVersion'))}</button>`)
  }
  // UI review: each entry is now its own card (history.css), so the card
  // edge is what says whose button this is, not the button's position
  // relative to the row above it. The action moves back to the bottom, after
  // the quote, which is where it reads best: meta first, then the reference
  // text it acts on, then the action itself.
  return (
    `<li class="history-item history-item--change" data-seq="${escHtml(String(item.seq))}">` +
    `<div class="history-meta">${escHtml(meta)}</div>` +
    `<div class="history-before">` +
    `<div class="history-before-label">${escHtml(t('history.before'))}</div>` +
    `<p class="history-before-text" data-preview="${escAttr(item.before_preview || '')}">${escHtml(item.before_preview || '')}</p>` +
    `<button type="button" class="history-link-btn" data-action="show-before">${escHtml(t('history.showAll'))}</button>` +
    `</div>` +
    (actions.length ? `<div class="history-item-actions">${actions.join('')}</div>` : '') +
    `</li>`
  )
}

// UI review: matches the change rows' "{reason} · {date} · by {actor}"
// order, rather than actor-first with no "by" (history.byPlain, since the
// copy deck has no template for an event row's actor).
function renderHistoryEventRow(item) {
  const who = item.actor_name ? t('history.byPlain', { actor: historyActorDisplay(item.actor_name) }) : ''
  const meta = [typeof timelineEventLabel === 'function' ? timelineEventLabel(item.event) : item.event || '', historyDate(item.at), who]
    .filter(Boolean)
    .join(' · ')
  return `<li class="history-item history-item--event" data-event="${escAttr(item.event || '')}"><div class="history-meta">${escHtml(meta)}</div></li>`
}

function renderHistoryFooters(footer) {
  if (!footer) return ''
  const parts = []
  if (footer.pruned) {
    parts.push(`<div class="history-footer" data-footer="pruned">${escHtml(t('history.footerPruned', { n: footer.kept }))}</div>`)
  }
  if (footer.not_recorded_before) {
    const date = formatDateUI(footer.not_recorded_before, { year: 'numeric', month: 'short', day: 'numeric' })
    parts.push(`<div class="history-footer" data-footer="not-recorded">${escHtml(t('history.footerNotRecorded', { date }))}</div>`)
  }
  if (footer.shared_cut_by) {
    parts.push(`<div class="history-footer" data-footer="shared-cut">${escHtml(t('history.footerSharedCut', { name: footer.shared_cut_by }))}</div>`)
  }
  return parts.join('')
}

/** Refetches /entry and re-renders the sheet, then focuses a live action button. */
async function historyRehydrateAndFocus(id) {
  if (typeof hydrateView === 'function') await hydrateView(id)
  const list = document.querySelector('#view-timeline .history-list')
  const target = list?.querySelector('[data-action="undo"], [data-action="restore-version"]')
  if (target) target.focus()
  else if (list) {
    list.setAttribute('tabindex', '-1')
    list.focus()
  }
}

function wireHistoryRow(li, item, entry) {
  const showBtn = li.querySelector('[data-action="show-before"]')
  if (showBtn) {
    let expanded = false
    let fullText = null
    showBtn.onclick = async () => {
      const p = li.querySelector('.history-before-text')
      if (!expanded) {
        if (fullText === null) {
          showBtn.disabled = true
          try {
            const res = await fetch(`${WORKER_URL}/entry/version`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: entry.id, seq: item.seq }),
            })
            const data = await res.json()
            fullText = data.ok ? data.content : p.dataset.preview
          } catch {
            fullText = p.dataset.preview
          } finally {
            showBtn.disabled = false
          }
        }
        p.textContent = fullText
        showBtn.textContent = t('history.showLess')
        expanded = true
      } else {
        p.textContent = p.dataset.preview
        showBtn.textContent = t('history.showAll')
        expanded = false
      }
    }
  }

  const undoBtn = li.querySelector('[data-action="undo"]')
  if (undoBtn) {
    undoBtn.onclick = async () => {
      undoBtn.disabled = true
      try {
        const result = await apiUndo(entry.id)
        undoResultToast(result, { provider: historyProvider(entry) })
      } finally {
        await historyRehydrateAndFocus(entry.id)
      }
    }
  }

  const restoreBtn = li.querySelector('[data-action="restore-version"]')
  if (restoreBtn) {
    restoreBtn.onclick = () => {
      openDangerConfirm({
        title: t('history.restoreTitle'),
        body: t('history.restoreBody', { date: historyDate(item.at) }),
        confirmLabel: t('history.restoreConfirm'),
        tone: 'primary',
        onConfirm: async (_checked, done) => {
          const result = await apiUndo(entry.id, item.seq)
          undoResultToast(result, { provider: historyProvider(entry) })
          done()
          await historyRehydrateAndFocus(entry.id)
        },
      })
    }
  }
}

/**
 * Replaces #view-timeline's contents with the rich history list (SH-1).
 *
 * The lock note explaining a disabled sheet lives next to the status
 * control (renderViewStatus), not here: it is one fact about the whole
 * sheet, not something History alone should carry, and duplicating it in
 * two sections read as two different explanations for the same thing.
 */
/**
 * UI review: change rows and event rows are one timeline, not a change list
 * with events trailing after it. Contract 4.1 has the Worker deliver them
 * newest-first already merged, but sorting defensively here means a caller
 * that hands over an unsorted or partially-merged array (a hand-built
 * fixture, or a future edge case the contract does not anticipate) still
 * renders correctly rather than silently reading as broken. Array.sort is
 * stable since ES2019, so equal timestamps keep the order they arrived in.
 */
function sortedHistoryItems(items) {
  return [...items].sort((a, b) => (b.at || 0) - (a.at || 0))
}

/**
 * T-0101.6.1 (copywriter flag): a validity write lands two rows — an
 * `entry_events` row (`validity_changed`/`superseded`/`flagged`) and its own
 * change row (`reason: "validity"`) — because src/memory/history-view.ts's
 * EVENTS_SUPERSEDED_BY_VERSIONS (the server's own de-dup list for update/
 * append/status_changed/reverted) does not name any of the three validity
 * event names. The change row is strictly more specific (it names the cause,
 * and with a preview); this drops the event row for any validity change
 * within one second of it, the same window a real single write's own
 * multi-statement batch lands in.
 */
const VALIDITY_EVENT_NAMES = new Set(['validity_changed', 'superseded', 'flagged'])
const VALIDITY_EVENT_DEDUPE_WINDOW_MS = 1000

function dedupeValidityEventRows(items) {
  const changeTimes = items.filter((it) => it.kind === 'change' && it.reason === 'validity').map((it) => it.at)
  return items.filter((item) => {
    if (item.kind !== 'event' || !VALIDITY_EVENT_NAMES.has(item.event)) return true
    return !changeTimes.some((at) => Math.abs(at - item.at) < VALIDITY_EVENT_DEDUPE_WINDOW_MS)
  })
}

/**
 * The preview text a validity-caused row's `by` id needs (T-0101.6.1). `by` names another entry
 * only by id — resolved here, once per render, rather than inside historyValidityLabel, which
 * stays a plain synchronous formatter. `entry.superseded_by` already carries this entry's own
 * live closer's preview (the six-field validity contract), so only a `by` id that names some
 * OTHER entry — an older link in the chain, or the entry a retraction/un-retraction points at —
 * costs its own fetch. A `by` id that no longer resolves (forgotten since) maps to `null`, which
 * historyValidityLabel reads as "the memory that replaced it was forgotten".
 */
async function collectValidityPreviews(items, entry) {
  const ids = new Set()
  for (const item of items) {
    if (item.kind === 'change' && item.reason === 'validity' && item.cause && item.by) ids.add(item.by)
  }
  const map = new Map()
  if (entry.superseded_by && ids.has(entry.superseded_by.id)) {
    map.set(entry.superseded_by.id, entry.superseded_by.preview)
    ids.delete(entry.superseded_by.id)
  }
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        const res = await fetch(`${WORKER_URL}/entry?id=${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        })
        const data = await res.json()
        map.set(id, data.ok && data.entry ? String(data.entry.content || '').slice(0, 60) : null)
      } catch {
        map.set(id, null)
      }
    }),
  )
  return map
}

async function renderHistory(entry) {
  const el = document.getElementById('view-timeline')
  if (!el) return
  const items = dedupeValidityEventRows(sortedHistoryItems(entry.history?.items || []))
  const footer = entry.history?.footer
  if (!items.length) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  const previewMap = await collectValidityPreviews(items, entry)
  // The sheet may have moved on (closed, or re-hydrated onto a different entry) while the
  // preview fetches above were in flight; nothing left to update.
  if (!document.getElementById('view-timeline')) return
  const rowsHtml = items
    .map((item, index) => (item.kind === 'change' ? renderHistoryChangeRow(item, index, items, entry, previewMap) : renderHistoryEventRow(item)))
    .join('')
  el.style.display = ''
  el.innerHTML =
    `<div class="view-timeline-label history-label">${escHtml(t('memories.timelineLabel'))}</div>` +
    `<ol class="history-list">${rowsHtml}</ol>${renderHistoryFooters(footer)}`
  // Joined by data-seq, not position: the same convention loadRelated uses
  // (row.dataset.id), so wiring does not depend on the DOM giving back rows
  // in array order.
  const changeItems = items.filter((it) => it.kind === 'change')
  el.querySelectorAll('.history-item').forEach((li) => {
    if (li.dataset.seq === undefined) return
    const item = changeItems.find((it) => String(it.seq) === li.dataset.seq)
    if (item) wireHistoryRow(li, item, entry)
  })
}
