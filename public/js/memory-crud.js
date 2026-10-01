function resetAppendSaveBtn() {
  const btn = document.getElementById('append-save-btn')
  if (!btn) return
  btn.disabled = false
  btn.textContent = t('memories.appendSave')
}

function showAppendError(message) {
  const el = document.getElementById('append-error')
  if (!el) return
  el.textContent = message
  el.hidden = false
}

function clearAppendError() {
  const el = document.getElementById('append-error')
  if (!el) return
  el.hidden = true
  el.textContent = ''
}

function openAppend(id, preview) {
  pendingAppendId = id
  document.getElementById('append-context-preview').textContent = preview + '...'
  document.getElementById('append-textarea').value = ''
  resetAppendSaveBtn()
  clearAppendError()
  document.getElementById('append-sheet').classList.add('open')
  setTimeout(() => document.getElementById('append-textarea').focus(), 100)
}
// Some memories arrive without an id — recall results from an older Worker, and
// the synthesized rows the digest writes — so there is nothing to append to.
// Writing a fresh memory is the honest fallback, which used to mean the Remember
// tab and now means home, with the mode already set so the field does not guess.
function openAppendFromContent() {
  switchTab('home')
  returnHome()
  const field = document.getElementById('home-field')
  if (!field) return
  lockHomeMode('remember')
  field.focus()
}
function closeAppend() {
  document.getElementById('append-sheet').classList.remove('open')
  pendingAppendId = null
  resetAppendSaveBtn()
  clearAppendError()
}

async function saveAppend() {
  const addition = document.getElementById('append-textarea').value.trim()
  if (!addition || !pendingAppendId) return
  const btn = document.getElementById('append-save-btn')
  clearAppendError()
  btn.disabled = true
  btn.textContent = t('memories.saving')
  try {
    const appendedId = pendingAppendId
    // REST, not the MCP tool: MCP's channel reads as "via an AI tool" on the
    // history timeline, which is false for a person's own dashboard append.
    const res = await fetch(`${WORKER_URL}/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id: appendedId, addition }),
    })
    if (!res.ok) {
      let data = {}
      try {
        data = await res.json()
      } catch {}
      // Shown in place, text left in append-textarea exactly as typed -
      // nothing here ever clears it on failure, so "your text is still
      // here" holds. Same 413/too_large REST contract saveEdit checks
      // (src/lib/content-size.ts), not a message-text match.
      if (res.status === 413 && data.error === 'too_large') {
        showAppendError(t('home.tooLong'))
        return
      }
      throw new Error(t('auth.serverError', { status: res.status }))
    }
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || '')
    closeAppend()
    notifyMemoryResolved(appendedId)
    refreshAll()
    if (typeof undoToast === 'function') {
      undoToast(t('undo.added'), appendedId, { onUndone: () => notifyMemoryRestored(appendedId) })
    }
  } catch (e) {
    showToast(t('memories.appendFailed', { message: e.message }))
  } finally {
    resetAppendSaveBtn()
  }
}

// The tags the sheet is currently offering to save. Held separately from the
// entry so that removing one and then cancelling changes nothing.
let pendingEditTags = []

function resetEditSaveBtn() {
  const btn = document.getElementById('edit-save-btn')
  if (!btn) return
  btn.disabled = false
  btn.textContent = t('memories.editSave')
}

function openEdit(id, content, tags) {
  pendingEditId = id
  // The brain's own bookkeeping — kind:, volatility:, status: — was rendering
  // as chips here long after every other surface learned to hide it. It is also
  // not the user's to delete, so it is neither shown nor sent.
  pendingEditTags = humanTags(tags)
  renderEditTags()
  const sub = document.getElementById('edit-sub')
  if (sub) sub.textContent = titleLine(content, 60)

  const ta = document.getElementById('edit-textarea')
  ta.value = content
  resetEditSaveBtn()
  clearEditError()
  document.getElementById('edit-sheet').classList.add('open')
  setTimeout(() => {
    ta.focus()
    // Focusing a textarea whose value was just set puts the caret at the end and
    // scrolls there, which on a long memory opened the editor somewhere in the
    // middle of the text. Editing should start where reading starts.
    ta.setSelectionRange(0, 0)
    ta.scrollTop = 0
  }, 100)
}

function renderEditTags() {
  const el = document.getElementById('edit-existing-tags')
  if (!el) return
  el.innerHTML = pendingEditTags
    .map(
      (tag, i) =>
        `<button type="button" class="tag-chip tag-chip--removable" onclick="removeEditTag(${i})" aria-label="${escAttr(t('memories.removeTag', { tag }))}">${escHtml(tag)}<i class="ti ti-x"></i></button>`,
    )
    .join('')
}

function removeEditTag(i) {
  pendingEditTags.splice(i, 1)
  renderEditTags()
}

function closeEdit() {
  document.getElementById('edit-sheet').classList.remove('open')
  pendingEditId = null
  pendingEditTags = []
  resetEditSaveBtn()
  clearEditError()
}

function showEditError(message) {
  const el = document.getElementById('edit-error')
  if (!el) return
  el.textContent = message
  el.hidden = false
}

function clearEditError() {
  const el = document.getElementById('edit-error')
  if (!el) return
  el.hidden = true
  el.textContent = ''
}

async function saveEdit() {
  const newContent = document.getElementById('edit-textarea').value.trim()
  if (!newContent || !pendingEditId) return
  const btn = document.getElementById('edit-save-btn')
  clearEditError()
  btn.disabled = true
  btn.textContent = t('memories.saving')
  try {
    const res = await fetch(`${WORKER_URL}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      // Only the user's own tags travel. The Worker keeps its own — see
      // src/tags/system.ts — so an edit cannot delete a conclusion the brain reached.
      body: JSON.stringify({ id: pendingEditId, content: newContent, tags: pendingEditTags }),
    })
    if (!res.ok) {
      let data = {}
      try {
        data = await res.json()
      } catch {}
      // Shown in place, not as a toast, and the textarea is left exactly as
      // typed - the composer's own promise ("your text is still here") holds
      // here too, since nothing here ever clears edit-textarea on failure.
      if (res.status === 413 && data.error === 'too_large') {
        showEditError(t('home.tooLong'))
        return
      }
      throw new Error(t('auth.serverError', { status: res.status }))
    }
    const editedId = pendingEditId
    closeEdit()
    notifyMemoryResolved(editedId)
    refreshAll()
    if (typeof undoToast === 'function') {
      undoToast(t('undo.saved'), editedId, { onUndone: () => notifyMemoryRestored(editedId) })
    }
  } catch (e) {
    showToast(t('memories.editFailed', { message: e.message }))
  } finally {
    resetEditSaveBtn()
  }
}

function openConfirm(id, btnOrCard) {
  const card = btnOrCard ? (btnOrCard.classList?.contains('memory-card') ? btnOrCard : btnOrCard.closest('.memory-card')) : null
  // Opened BEFORE the state is set, not after: opening dismisses whatever sheet
  // it replaces, and for a previous forget that dismissal is exactly what nulls
  // these two. Setting them first would let the outgoing sheet wipe them.
  //
  // The shared sheet, driven like any other caller — the markup's cold copy is
  // this same wording, but it is written in explicitly so whichever action
  // opened the sheet last cannot leave its words behind.
  openDangerConfirm({
    title: t('memories.confirmTitle'),
    body: t('memories.confirmBody'),
    confirmLabel: t('memories.forget'),
    onConfirm: confirmForget,
    onClose: () => {
      pendingForgetId = null
      pendingForgetCard = null
    },
  })
  pendingForgetId = id
  pendingForgetCard = card
  // The default-phrased body renders immediately; if the owner changed the retention
  // period, GET /config's answer (shared with team.js's settings reads) replaces it in place.
  if (typeof readTeamConfig === 'function') {
    readTeamConfig()
      .then((cfg) => {
        const days = cfg?.config?.TRASH_RETENTION_DAYS
        if (typeof days !== 'number' || pendingForgetId !== id) return
        const body = document.getElementById('confirm-body')
        if (body) body.textContent = t('memories.confirmBodyRetention', { n: days })
      })
      .catch(() => {})
  }
}
/**
 * Tell any open list that this memory has been dealt with.
 *
 * The Memories screen is handled inline above — a row animation and a local
 * filter — but a sheet that holds its own copy of a list has no way to know an
 * action happened, and its row stays on screen looking like the action failed.
 * That is what the out-of-date queue did after a successful forget.
 *
 * A call rather than a reach: each list decides what an id means to it, and one
 * it is not showing has to leave it alone. Guarded so a page that never loaded
 * that module is unaffected.
 */
function notifyMemoryResolved(id) {
  if (typeof dropFromStaleQueue === 'function') dropFromStaleQueue(id)
}

/** notifyMemoryResolved's sibling: a row an undo brought back reappears in the lists that dropped it. */
function notifyMemoryRestored(id) {
  if (typeof refreshAll === 'function') refreshAll()
}

/**
 * Delete forever (T-0089.4.7): `{id, permanent: true, confirm: id, nonce}` on one trash row. The
 * nonce is that row's own (from the trash list), so a stale view never deletes a different row
 * under a reused id. Lives in the trash view only (Q11); not offered to agents.
 */
function openDeleteForeverConfirm(id, cardElement, { onDone, onConflict, nonce } = {}) {
  openDangerConfirm({
    title: t('memories.deleteForeverTitle'),
    body: t('memories.deleteForeverConfirm'),
    confirmLabel: t('memories.deleteForever'),
    onConfirm: async (_checked, done) => {
      const btn = document.querySelector('#confirm-dialog .btn-delete')
      if (btn) {
        btn.disabled = true
        btn.textContent = t('memories.deletingForever')
      }
      try {
        const res = await fetch(`${WORKER_URL}/forget`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
          // Required, not optional: the merged /forget route 400s without it
          // (src/routes/entries.ts) -- delete forever only ever acts on a
          // trash row.
          body: JSON.stringify({ id, permanent: true, confirm: id, nonce }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) {
          // A stale nonce (the row moved under the reader, e.g. someone else
          // already restored or deleted it) is the caller's to explain, not
          // a generic failure toast - trash.js's onConflict refreshes its list.
          if ((res.status === 404 || res.status === 409) && typeof onConflict === 'function') {
            done()
            onConflict()
            return
          }
          throw new Error(data.error || t('memories.deleteForeverFailed'))
        }
        done()
        if (cardElement) {
          cardElement.style.transition = 'none'
          cardElement.classList.add('explode-out')
          setTimeout(() => cardElement?.remove(), 400)
        }
        allEntries = allEntries.filter((e) => e.id !== id)
        notifyMemoryResolved(id)
        refreshAll({ list: false })
        if (typeof onDone === 'function') onDone(id)
      } catch (e) {
        showToast(t('memories.deleteForeverFailed', { message: e.message }))
        done()
      } finally {
        if (btn) {
          btn.disabled = false
          btn.textContent = t('memories.deleteForever')
        }
      }
    },
  })
}

async function confirmForget(_checked, done) {
  if (!pendingForgetId) return
  // Snapshot BEFORE closing: closing fires this sheet's onClose, which is what
  // nulls these two. Anything read after the close reads null.
  const idToForget = pendingForgetId
  const cardElement = pendingForgetCard
  // `done` closes this question and no other. It is absent only when something
  // calls confirmForget() directly rather than through the sheet, and then
  // "close whatever is open" is the honest reading.
  const closeThis = done || closeConfirm
  const btn = document.querySelector('#confirm-dialog .btn-delete')
  if (btn) {
    btn.disabled = true
    btn.textContent = t('memories.forgetting')
  }

  try {
    // REST, not the MCP tool: the confirm sheet promised "it moves to the trash", and only REST's
    // structured `trash` field (round 2 adversary) lets this correct that when a memory is too
    // large for the trash and forget hard-deleted it instead (memory/trash.ts's tier 3).
    const res = await fetch(`${WORKER_URL}/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id: idToForget }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || t('memories.forgetFailed', { message: '' }))
    closeThis()
    if (cardElement) {
      cardElement.style.transition = 'none'
      cardElement.classList.add('explode-out')
      setTimeout(() => cardElement?.remove(), 400)
    }
    allEntries = allEntries.filter((e) => e.id !== idToForget)
    notifyMemoryResolved(idToForget)
    // Everything except the list, which the row animation and the local filter
    // above have already handled — reloading it here would swap the element out
    // from under its own exit animation.
    refreshAll({ list: false })
    if (data.trash === false) {
      // Tier 3: too large for the trash, hard-deleted. There is no version to
      // undo to, the same reason Delete forever never gets a toast either.
      showToast(t('memories.forgetHardDeleted'))
    } else if (typeof undoToast === 'function') {
      undoToast(t('undo.trashed'), idToForget, { onUndone: () => notifyMemoryRestored(idToForget) })
    }
  } catch (e) {
    showToast(t('memories.forgetFailed', { message: e.message }))
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = t('memories.forget')
    }
  }
}

// ── What the brain thinks about one memory ────────────────────────────────
//
// The pipeline decides a great deal per entry — how important it is, whether
// it is a fact or an event, whether it has been superseded, how long it stays
// true, how often it has been recalled — and until v2.3 none of it was
// reachable from the UI. This is the one place that shows it, in plain
// language rather than the tag syntax it is stored as.

/** `kind:semantic` → localized label. Unknown values render as themselves. */
function viewKindLabel(kind) {
  if (kind === 'semantic') return t('memories.kindFact')
  if (kind === 'episodic') return t('memories.kindEvent')
  return kind
}

function viewStatusLabel(status) {
  if (status === 'canonical') return t('memories.statusTrusted')
  if (status === 'draft') return t('memories.statusUnconfirmed')
  // SH-3: "Wrong" everywhere the sheet shows status, replacing "Superseded".
  if (status === 'deprecated') return t('status.wrong')
  return status
}

/**
 * SH-5/T-0101.6.1 (spec 13 section SH-5, spec 14 section 7.6): the sheet's
 * status line — `#view-status-caption`, ALWAYS shown (renderViewStatus
 * defaults an untagged entry to "canonical"), not view-brain's optional
 * Status row, which only appears when an explicit `status:` tag exists. A
 * memory with no status tag is the common case, and it is exactly there
 * that a validity story must still replace the generic "Confirmed. Search
 * often prefers it…" caption — otherwise most replaced memories would keep
 * reading as a bare "Trusted" regardless of this feature. `wrong` keeps its
 * own caption (STATUS_HELP_KEYS.deprecated): being marked wrong is a
 * stronger statement than a validity window closing on its own.
 */
function validityStatusCaptionHtml(entry) {
  const state = entry.validity_state
  const shortDate = (ms) => formatDateUI(ms, { year: 'numeric', month: 'short', day: 'numeric' })
  let html = null
  if (state === 'replaced' && entry.superseded_by) {
    const label = t('validity.trueFromUntil', { from: shortDate(entry.valid_from), until: shortDate(entry.valid_until) })
    const link = `<a href="#" onclick="openValidityLink('${escAttr(entry.superseded_by.id)}'); return false;">${escHtml(t('validity.replacedBy', { preview: entry.superseded_by.preview }))}</a>`
    html = `${escHtml(label)}<br>${link}`
  } else if (state === 'ended') {
    html = escHtml(t('validity.ended', { until: shortDate(entry.valid_until) }))
  } else if (state === 'current' && entry.valid_from_stated) {
    html = escHtml(t('validity.trueSince', { from: shortDate(entry.valid_from) }))
  }
  if (entry.retracted_source) {
    const note = escHtml(t('validity.retractedSource'))
    html = html ? `${html}<br>${note}` : note
  }
  return html
}

/**
 * The link on a Replaced-by row: opens the replacement's own sheet.
 * `hydrateView` cannot do this — it re-renders the sheet ALREADY open on
 * `viewOpenId`, and a click here means jumping to a DIFFERENT memory — so
 * this fetches the replacement fresh and opens it, the same convention as
 * graph-canvas.js's openNodeView (down to the empty-content offline fallback:
 * the preview text is not passed through the inline onclick attribute, since
 * escAttr breaks that handler the moment a memory's content has a quote in
 * it — see the escAttr/onclick warning atop stale.js's onStaleListClick).
 */
async function openValidityLink(id) {
  try {
    const res = await fetch(`${WORKER_URL}/entry?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const data = await res.json()
    if (data.ok && data.entry) {
      openView(data.entry, null)
      return
    }
    throw new Error('entry fetch failed')
  } catch {
    openView({ id, content: '', tags: [] }, null)
  }
}

/**
 * The Wrong toast (spec 14 section 7.6): names the one memory a retraction
 * restored, counts several, and separately notes anything flagged for a
 * check. `null` for an ordinary status change with no validity side effects.
 */
function validityRestoredToastMessage(validity) {
  if (!validity) return null
  const restored = validity.restored || []
  const flagged = Number(validity.flagged) || 0
  if (!restored.length && !flagged) return null
  let message = null
  if (restored.length === 1) {
    message = t('validity.restoredToast', { preview: restored[0].preview })
  } else if (restored.length > 1) {
    message = t('validity.restoredToastMany', { n: restored.length })
  }
  if (flagged > 0) {
    const flaggedMsg = tPlural('validity.flaggedToast', flagged)
    message = message ? `${message} ${flaggedMsg}` : flaggedMsg
  }
  return message
}

/** Volatility is a promise about the future, so it is worth spelling out. */
function viewVolatility(volatility) {
  if (volatility === 'durable') return [t('memories.volDurable'), t('memories.volDurableGloss')]
  if (volatility === 'state') return [t('memories.volCurrent'), t('memories.volCurrentGloss')]
  if (volatility === 'volatile') return [t('memories.volShortLived'), t('memories.volShortLivedGloss')]
  return null
}

function tagValue(tags, prefix) {
  const hit = (tags || []).find((t) => String(t).toLowerCase().startsWith(prefix))
  return hit ? String(hit).slice(prefix.length).toLowerCase() : null
}

/** Importance as five dots — a number out of five means nothing on its own. */
function importanceDots(score) {
  const n = Math.max(0, Math.min(5, Math.round(Number(score) || 0)))
  return `<span class="dots" title="${escAttr(t('memories.importanceTitle', { n }))}">${'●'.repeat(n)}${'○'.repeat(5 - n)}</span>`
}

function renderViewMeta(entry) {
  const el = document.getElementById('view-meta')
  const badge = sourceBadge(entry.source)
  const created = Number(entry.created_at) || 0
  const updated = Number(entry.updated_at) || 0
  const parts = [`<span class="view-meta-item"><i class="ti ${badge.icon}"></i>${escHtml(badge.label)}</span>`]
  if (created) {
    parts.push(`<span class="view-meta-item" title="${escAttr(new Date(created).toLocaleString(localeTag()))}">${escHtml(t('memories.metaCaptured', { relative: relativeTime(created) }))}</span>`)
  }
  // Only worth saying when it actually differs — every row has an updated_at.
  if (updated && created && Math.abs(updated - created) > 60000) {
    parts.push(`<span class="view-meta-item" title="${escAttr(new Date(updated).toLocaleString(localeTag()))}">${escHtml(t('memories.metaEdited', { relative: relativeTime(updated) }))}</span>`)
  }
  el.innerHTML = parts.join('')
}

/** claude-code, codex-session, cursor-session: an AI coding session's own capture, not the user typing. */
const AUTO_SAVE_SESSION_SOURCES = {
  'claude-code': 'Claude Code',
  'codex-session': 'Codex',
  'cursor-session': 'Cursor',
}

/**
 * A quiet note, sheet only (never the list card): a memory an AI coding
 * session saved on its own reads differently from one the user wrote, and the
 * tool name is not translated — only the sentence around it is.
 */
function renderViewAutoSaveNote(entry) {
  const el = document.getElementById('view-auto-save-note')
  if (!el) return
  const tool = AUTO_SAVE_SESSION_SOURCES[String(entry.source || '').toLowerCase()]
  if (!tool) {
    el.style.display = 'none'
    el.textContent = ''
    return
  }
  el.textContent = t('memories.sessionSaved', { tool })
  el.style.display = ''
}

function renderViewBrain(entry) {
  const el = document.getElementById('view-brain')
  // Rendered from the tags when /entry has not been consulted (recall cards
  // pass what they already have), so the section degrades rather than vanishing.
  const tags = entry.tags || []
  const kind = tagValue(tags, 'kind:')
  const status = tagValue(tags, 'status:')
  const volatility = tagValue(tags, 'volatility:')
  const rows = []
  const notes = []

  if (typeof entry.importance_score === 'number') {
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.importance'))}</span>${importanceDots(entry.importance_score)}</div>`)
  }
  if (kind) {
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.kind'))}</span><strong>${escHtml(viewKindLabel(kind))}</strong></div>`)
  }
  // T-0101.6.1: skipped whenever the status caption already tells the validity story
  // (renderViewStatus/validityStatusCaptionHtml) - otherwise this plain row said "Trusted"
  // right above a caption reading "No longer true since...", the same bare-Trusted spec 13
  // was fixed to remove flagged again on a real screenshot (sheet-ended, sheet-retracted-source).
  if (status && !(status !== 'deprecated' && validityStatusCaptionHtml(entry))) {
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.status'))}</span><strong>${escHtml(viewStatusLabel(status))}</strong></div>`)
  }
  const volPair = volatility ? viewVolatility(volatility) : null
  if (volPair) {
    const [label, gloss] = volPair
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.lifespan'))}</span><strong>${escHtml(label)}</strong></div>`)
    // Held back to the end: a sentence between two rows breaks the list it is
    // explaining, and the panel reads as facts first, then the caveats.
    notes.push(gloss)
  }
  if (typeof entry.recall_count === 'number' && entry.recall_count > 0) {
    rows.push(`<div class="view-brain-row"><span>${escHtml(t('memories.recalled'))}</span><strong>${escHtml(tPlural('memories.recalledTimes', entry.recall_count))}</strong></div>`)
  }
  // Losing a contradiction means something newer disagreed with this. Silence
  // when it has never happened; it is not a scoreboard.
  const losses = Number(entry.contradiction_losses) || 0
  if (losses > 0) {
    notes.push(tPlural('memories.disagreed', losses))
  }
  for (const note of notes) {
    rows.push(`<div class="view-brain-note">${escHtml(note)}</div>`)
  }
  // Copywriter decision (deck section 15): a held memory is out of search by policy, not because
  // it is still indexing - the held banner already says so, and "not indexed yet" beside it would
  // read as a second, conflicting reason. Same heldReason(entry.tags) check as the held banner.
  const heldForIndexNote = typeof heldReason === 'function' ? heldReason(entry.tags || []) : null
  if (entry.indexed === false && !heldForIndexNote) {
    rows.push(`<div class="view-brain-note view-brain-note--warn">${escHtml(t('memories.notIndexedYet'))}</div>`)
  }

  if (!rows.length) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  el.style.display = ''
  el.innerHTML = `<div class="view-brain-label">${escHtml(t('memories.brainLabel'))}</div>${rows.join('')}`
}

const STATUS_HELP_KEYS = {
  canonical: 'status.trustedHelp',
  draft: 'status.unconfirmedHelp',
  deprecated: 'status.wrongHelp',
}

/**
 * SH-3: POST /status immediately (no confirm), toast with Undo, re-hydrate.
 * `wasStatus` is read fresh rather than trusted from closure, since a slow
 * click racing a re-render should not fire on a status the sheet no longer
 * shows.
 */
async function selectViewStatus(status, entry) {
  const group = document.getElementById('view-status')
  const buttons = Array.from(group.querySelectorAll('.status-option'))
  const wasStatus = tagValue(entry.tags || [], 'status:') || 'canonical'
  if (status === wasStatus) return
  buttons.forEach((b) => (b.disabled = true))
  try {
    const res = await fetch(`${WORKER_URL}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id: entry.id, status }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '')
    let message = t('undo.marked', { status: viewStatusLabel(status).toLowerCase() })
    // undo.marked is a plain "toast after an action" (no period, per the copy
    // guide), but appending a full sentence after it makes this one a "toast
    // with a consequence", which does take one.
    if (data.indexed === false) message += '. ' + t('status.keywordOnly')
    const validityMessage = validityRestoredToastMessage(data.validity)
    if (validityMessage) message = validityMessage
    undoToast(message, entry.id, {
      onUndone: () => {
        if (typeof hydrateView === 'function') hydrateView(entry.id)
      },
    })
    if (typeof hydrateView === 'function') hydrateView(entry.id)
  } catch (e) {
    showToast(t('status.failed', { message: e.message || '' }))
    buttons.forEach((b) => (b.disabled = false))
  }
}

/** Roving arrow keys over the three options, per the WAI-ARIA radiogroup pattern: moving also selects. */
function wireViewStatusButton(btn, entry) {
  btn.onclick = () => {
    if (!btn.disabled) return selectViewStatus(btn.dataset.status, entry)
  }
  btn.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const opts = Array.from(document.querySelectorAll('#view-status .status-option'))
    const idx = opts.indexOf(btn)
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
    const next = opts[(idx + dir + opts.length) % opts.length]
    if (next && !next.disabled) {
      next.focus()
      selectViewStatus(next.dataset.status, entry)
    }
  }
}

/**
 * UI review: the lock note explaining why Append, Edit, Forget and Status
 * are disabled lives here, next to the control it explains, and only here —
 * it used to also render at the end of History, which read as two different
 * explanations for the same thing. `locked` is strictly `=== false` plus a
 * resolved actor_name: an entry that has not answered can_edit yet, or has
 * answered it without a name, must not print a note attributed to nobody.
 */
function renderViewStatusLockNote(entry) {
  const el = document.getElementById('view-status-lock-note')
  if (!el) return
  const locked = entry.can_edit === false && !!entry.actor_name
  if (!locked) {
    el.style.display = 'none'
    el.textContent = ''
    return
  }
  el.style.display = ''
  el.textContent = t('memories.authorLocked', { name: entry.actor_name })
}

/**
 * T7-E Task 14 (15-t7-wow-spec.md 7.3): the standing line and its Stop
 * button, hidden entirely on a memory that is not currently standing. Shares
 * this row with the status control below it (T-0101.8, `renderViewStatus`).
 */
/**
 * The one memory a Stop click just turned ordinary, for the CURRENT sheet
 * session only - not a permanent "not standing" label on every ordinary
 * memory (that would be a badge on every row, i.e. no badge at all). Cleared
 * whenever a sheet opens fresh, and by Undo's own restore.
 */
let justStoppedStandingId = null

function renderViewStanding(entry) {
  const block = document.getElementById('view-standing')
  const line = document.getElementById('view-standing-line')
  const btn = document.getElementById('view-standing-stop')
  if (!block || !line || !btn) return
  const tags = entry.tags || []
  const isStanding = tags.some((tag) => String(tag).toLowerCase() === 'standing:active')
  if (isStanding) {
    block.style.display = ''
    line.textContent = t('standing.sheetLine')
    btn.style.display = ''
    btn.onclick = () => stopStanding(entry, btn)
    return
  }
  // UI reviewer: Stop must read as done the moment it succeeds, not only once
  // the toast says so - this is the in-place confirmation, kept up until the
  // sheet moves on to something else. No way to set it again here: spec 2.2
  // says turning an ordinary memory into a standing one is not offered in
  // 4.0, so Undo (from the toast) is the only way back.
  if (entry.id != null && entry.id === justStoppedStandingId) {
    block.style.display = ''
    line.textContent = t('standing.notStanding')
    btn.style.display = 'none'
    return
  }
  block.style.display = 'none'
}

/** Stop is a resolve action (POST /standing/stop): removes standing:active only, versioned and undoable. */
async function stopStanding(entry, btn) {
  if (btn) btn.disabled = true
  try {
    const res = await fetch(`${WORKER_URL}/standing/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id: entry.id }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '')
    // Updates the sheet immediately, before the round trip below: the toast
    // already says it happened, and the sheet should agree at once rather
    // than a moment later.
    justStoppedStandingId = entry.id
    renderViewStanding({ ...entry, tags: (entry.tags || []).filter((tag) => String(tag).toLowerCase() !== 'standing:active') })
    undoToast(t('standing.stopped'), entry.id, {
      onUndone: () => {
        if (justStoppedStandingId === entry.id) justStoppedStandingId = null
        if (typeof hydrateView === 'function') hydrateView(entry.id)
      },
    })
    if (typeof hydrateView === 'function') hydrateView(entry.id)
  } catch (e) {
    showToast(t('standing.stopFailed', { message: e.message || '' }))
  } finally {
    if (btn) btn.disabled = false
  }
}

/**
 * S5 (5.7, UX-E.3): no job ever expires the tag itself - every renderer
 * decides freshness at render time by comparing today to the tagged date.
 * 7, not a config value: the spec fixes it as a constant, unlike
 * STANDING_MAX or similar per-brain settings.
 */
const EDITED_CANONICAL_LABEL_DAYS = 7

/**
 * "Trusted · edited via Cursor on Sep 26" for 7 days after an MCP edit kept a
 * canonical memory canonical (5.7) - null once the tag is stale, absent, or
 * the memory isn't canonical (the label only ever qualifies "Trusted").
 * The client name comes from the newest matching history row's own `client`
 * (BE-6); a channel of `mcp` with no client name reads as "an AI tool".
 */
function canonicalEditLabel(entry) {
  if ((tagValue(entry.tags || [], 'status:') || 'canonical') !== 'canonical') return null
  const editedAt = typeof editedCanonicalAt === 'function' ? editedCanonicalAt(entry.tags || []) : null
  if (!editedAt) return null
  const ageDays = (Date.now() - Date.parse(`${editedAt}T00:00:00Z`)) / 86400000
  if (!(ageDays >= 0 && ageDays < EDITED_CANONICAL_LABEL_DAYS)) return null
  const rows = (entry.history && entry.history.items) || []
  const editRow = rows.find((row) => row.kind === 'change' && (row.reason === 'update' || row.reason === 'append') && row.channel === 'mcp')
  const tool = (editRow && editRow.client) || t('status.anAiTool')
  const date = formatDateUI(Date.parse(`${editedAt}T00:00:00Z`), { month: 'short', day: 'numeric' })
  return { tool, date }
}

function renderViewStatus(entry) {
  const group = document.getElementById('view-status')
  const caption = document.getElementById('view-status-caption')
  if (!group || !caption) return
  const status = tagValue(entry.tags || [], 'status:') || 'canonical'
  const options = Array.from(group.querySelectorAll('.status-option'))
  options.forEach((btn) => {
    const checked = btn.dataset.status === status
    btn.setAttribute('aria-checked', String(checked))
    btn.tabIndex = checked ? 0 : -1
    wireViewStatusButton(btn, entry)
  })
  // UI review, S5: every status help line (Trusted/Unconfirmed/Wrong) claims
  // search visibility ("shows up in search", "search leaves it out"), which
  // is false while the memory is held - the banner above already says it is
  // out of search. No held-aware copy exists yet, so this hides the line
  // rather than risk shipping a second, possibly-conflicting claim.
  const held = typeof heldReason === 'function' ? heldReason(entry.tags || []) : null
  if (held) {
    caption.style.display = 'none'
    caption.textContent = ''
    renderViewStatusLockNote(entry)
    return
  }
  caption.style.display = ''
  // T-0101.6.1: a validity story (or a retracted-source note) outranks both the canonical-edit
  // note and the plain status help line - it is the more specific, more current fact.
  const validityCaption = status !== 'deprecated' ? validityStatusCaptionHtml(entry) : null
  if (validityCaption) {
    caption.innerHTML = validityCaption
  } else {
    const editedLabel = canonicalEditLabel(entry)
    caption.textContent = editedLabel ? t('status.editedBy', editedLabel) : t(STATUS_HELP_KEYS[status] || '')
  }
  renderViewStatusLockNote(entry)
}

/**
 * S5 (7.2, UX-E.2): the held banner and Release, hidden entirely on a memory
 * that is not currently held. Covers every hold reason (`quarantine:<reason>`,
 * src/quarantine/tags.ts): `too_long` gets its own complete sentence (deck
 * section 9); every other reason fills held.banner's {reason} from the
 * matching held.reason* key.
 *
 * Release is hidden, not just disabled, when `can_edit === false` (deck 18
 * section 11's truth check: only the author or an admin can actually release
 * a shared company hold - see assertCanMutateEntry). held.bannerOther takes
 * over the sentence in that case, naming who can act instead of saying "you".
 */
function renderViewHeld(entry) {
  const block = document.getElementById('view-held')
  const line = document.getElementById('view-held-line')
  const btn = document.getElementById('view-held-release')
  if (!block || !line || !btn) return
  const reason = typeof heldReason === 'function' ? heldReason(entry.tags || []) : null
  if (!reason) {
    block.style.display = 'none'
    return
  }
  block.style.display = ''
  const locked = entry.can_edit === false
  btn.style.display = locked ? 'none' : ''
  if (reason === 'too_long') {
    line.textContent = t('held.tooLongLine')
  } else if (locked) {
    line.textContent = t('held.bannerOther', { reason: heldReasonPhrase(reason) })
  } else {
    line.textContent = t('held.banner', { reason: heldReasonPhrase(reason) })
  }
  btn.onclick = () => releaseHeld(entry, btn)
}

/** Explicit if-else, not a keyed lookup passed to the translate helper - the i18n test's static scanner flags a variable argument there as a new dynamic call site. */
function heldReasonPhrase(reason) {
  if (reason === 'instruction') return t('held.reasonInstruction')
  if (reason === 'hidden') return t('held.reasonHidden')
  if (reason === 'burst') return t('held.reasonBurst')
  if (reason === 'capsule') return t('held.reasonCapsule')
  return ''
}

/** Release is Undo on a currently-held row (5.6): the same POST /undo every other write-site Undo calls. */
async function releaseHeld(entry, btn) {
  if (btn) btn.disabled = true
  try {
    const res = await fetch(`${WORKER_URL}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify({ id: entry.id }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '')
    undoToast(t('held.released'), entry.id, {
      onUndone: () => {
        if (typeof hydrateView === 'function') hydrateView(entry.id)
      },
    })
    if (typeof hydrateView === 'function') hydrateView(entry.id)
  } catch (e) {
    showToast(t('held.releaseFailed', { message: e.message || '' }))
  } finally {
    if (btn) btn.disabled = false
  }
}

/**
 * Fill in what the caller could not know.
 *
 * Recall cards and graph nodes hand over the fields they happen to hold, so
 * the sheet renders immediately from those and then upgrades in place once
 * /entry answers. One request, only when there is an id to ask about.
 */
async function hydrateView(id) {
  try {
    const res = await fetch(`${WORKER_URL}/entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await res.json()
    if (!data.ok || !data.entry) return
    if (viewOpenId !== id) return // the sheet moved on while this was in flight
    renderViewMeta(data.entry)
    renderViewAutoSaveNote(data.entry)
    renderViewBrain(data.entry)
    renderViewStanding(data.entry)
    renderViewHeld(data.entry)
    renderViewStatus(data.entry)
    renderViewTimeline(data.entry)
    // openView rendered from whatever the caller happened to hold; /entry is
    // the only source that knows whether this is the reader's to change.
    applyAuthorLock(data.entry)
    syncViewScrollBottomPadding()
  } catch {}
}

/**
 * UI review: .view-scroll's bottom padding used to be a flat 4px, nowhere
 * near the fixed action row's real height, so scrolling to the very end of a
 * long history still left its last row (and "Show all") flush against the
 * footer rather than clear of it. Measuring the action row directly keeps
 * this correct at any width, button wrap, or safe-area inset, rather than a
 * guessed constant that drifts the next time the row's own height changes.
 */
function syncViewScrollBottomPadding() {
  const scroll = document.querySelector('#view-sheet .view-scroll')
  const actions = document.querySelector('#view-sheet .view-actions')
  if (!scroll || !actions || typeof actions.getBoundingClientRect !== 'function') return
  scroll.style.paddingBottom = `${Math.ceil(actions.getBoundingClientRect().height)}px`
}

/**
 * The Worker's event name as a sentence.
 *
 * `src/lib/audit.ts` writes seven names and the timeline printed them raw, so
 * the history of a shared memory read `Bob · status_changed · 3 Mar 2026`.
 * An eighth name from a newer Worker returns unchanged rather than blank —
 * degrading to today's behaviour beats rendering nothing.
 */
function timelineEventLabel(event) {
  const keys = {
    created: 'memories.evCreated',
    updated: 'memories.evUpdated',
    appended: 'memories.evAppended',
    deleted: 'memories.evDeleted',
    status_changed: 'memories.evStatusChanged',
    shared: 'memories.evShared',
    unshared: 'memories.evUnshared',
    reverted: 'memories.evReverted',
    restored: 'memories.evRestored',
    purged: 'memories.evPurged',
    // T3/T4 lane S5 (16-t3-t4-trust-spec.md 7.9).
    held: 'history.evHeld',
    released: 'history.evReleased',
    // T-0101.6.1: src/lib/audit.ts's three validity event names.
    superseded: 'validity.evSuperseded',
    validity_changed: 'validity.evChanged',
    flagged: 'validity.evFlagged',
  }
  return keys[event] ? t(keys[event]) : event || ''
}

function renderViewTimeline(entry) {
  // SH-1: a Worker that sends `history` (contract 4.1) gets the rich list
  // with Undo and Restore this version. A Worker that predates it falls back
  // to the plain event list below, unchanged.
  if (entry.history) {
    renderHistory(entry)
    return
  }
  const el = document.getElementById('view-timeline')
  if (!el) return
  const items = entry.timeline || []
  if (!items.length) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  const lines = []
  if (entry.workspace === 'company' && entry.actor_name) {
    lines.push(`<div class="view-timeline-item">${escHtml(t('memories.authorLabel', { name: entry.actor_name }))}</div>`)
  }
  for (const item of items) {
    const when = item.created_at
      ? formatDateUI(item.created_at, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : ''
    lines.push(`<div class="view-timeline-item">${escHtml(item.actor_name || '')} · ${escHtml(timelineEventLabel(item.event))}${when ? ` · ${escHtml(when)}` : ''}</div>`)
  }
  el.style.display = ''
  el.innerHTML = `<div class="view-timeline-label">${escHtml(t('memories.timelineLabel'))}</div>${lines.join('')}`
}

/**
 * Show whether this memory is the caller's to change.
 *
 * A member used to tap Edit on a colleague's shared memory, type, save, and
 * only then be told the Worker refuses. Strictly `=== false`: a recall card
 * that carries no flag, and any Worker from before the flag existed, are not
 * locked — which is what keeps a solo brain identical to what it is today.
 *
 * Append is in this set because POST /append gates on `assertCanEditContent`,
 * the same predicate POST /update uses (src/routes/capture.ts) — leaving it
 * enabled reproduced the same 403-after-typing on a different button. The
 * related-memory unlink control is deliberately NOT here: POST /unlink gates
 * only on readability (src/routes/graph.ts), so a reader may remove a link.
 */
function applyAuthorLock(entry) {
  lockAuthoredControls(entry, ['view-btn-append', 'view-btn-edit', 'view-btn-forget'].map((id) => document.getElementById(id)), 'view-btn--locked')
  lockAuthoredControls(entry, Array.from(document.querySelectorAll('#view-status .status-option')), 'status-option--locked')
  lockAuthoredControls(entry, [document.getElementById('view-standing-stop')], 'card-action-btn--locked')
  lockAuthoredControls(entry, [document.getElementById('view-held-release')], 'card-action-btn--locked')
}

/**
 * One reading of `can_edit`, for every surface that offers those controls.
 *
 * The detail sheet and the list card are two renderings of the same three
 * buttons over the same row, and the moment they answer "may I edit this?"
 * separately they can disagree - which is exactly the defect this phase has
 * already shipped twice. So the predicate, the disabled state, the dimming,
 * the `aria-disabled` and the explanatory title all live here once, and each
 * surface supplies only its own buttons and its own dimming class.
 *
 * `locked` is strictly `=== false`. Absent means "this Worker does not report
 * it", not "you may not", so an older Worker and a solo brain are untouched.
 */
function lockAuthoredControls(entry, buttons, lockedClass) {
  const locked = entry.can_edit === false
  for (const btn of buttons) {
    if (!btn) continue
    btn.disabled = locked
    btn.classList.toggle(lockedClass, locked)
    btn.title = locked ? t('memories.authorLockedTitle') : ''
    btn.setAttribute('aria-disabled', String(locked))
  }
  return locked
}

/**
 * The same lock on a list card.
 *
 * The card shows "Shared - Bob" already, so the user can see whose memory it
 * is; what they could not see was that Append, Edit and Forget would 403. The
 * set is deliberately the SAME three the detail sheet locks, for the same
 * reason: those three routes gate on `assertCanMutateEntry`, the predicate
 * `can_edit` reports. The share control is left alone here as unlink is left
 * alone there - a different route with its own answer.
 */
function applyCardAuthorLock(entry, card) {
  return lockAuthoredControls(
    entry,
    ['.append-btn', '.edit-btn', '.forget-btn'].map((sel) => card.querySelector(sel)),
    'card-action-btn--locked',
  )
}

/** Which memory the sheet is currently showing, so a late response can tell. */
let viewOpenId = null

function openView(entry, cardElement) {
  viewOpenId = entry.id || null
  // A fresh sheet, even on the same memory reopened: the "just stopped"
  // acknowledgment belongs to the session that clicked Stop, not to every
  // later visit.
  justStoppedStandingId = null
  document.getElementById('view-content-text').textContent = normalizeForDisplay(entry.content)
  renderViewMeta(entry)
  renderViewAutoSaveNote(entry)
  renderViewBrain(entry)
  renderViewStanding(entry)
  renderViewHeld(entry)
  renderViewStatus(entry)
  if (entry.id) hydrateView(entry.id)
  const tagsContainer = document.getElementById('view-tags-container')
  tagsContainer.innerHTML = ''
  // Only the user's own vocabulary here. The brain's namespaces used to be
  // shown as raw chips for want of anywhere better; "What your brain knows"
  // below now states each one in words, and printing `volatility:state` beside
  // "Lifespan · Current" says the same thing twice, once unreadably.
  const viewTags = humanTags(entry.tags || [])
  const viewProjects = projectChipsHtml(entry.tags || [])
  if (viewProjects || viewTags.length > 0) {
    tagsContainer.innerHTML = viewProjects + viewTags.map((t) => `<span class="tag-chip">${escHtml(t)}</span>`).join('')
  }
  const relatedEl = document.getElementById('view-related')
  relatedEl.style.display = 'none'
  relatedEl.innerHTML = ''
  if (entry.id) loadRelated(entry.id, relatedEl)
  const appendBtn = document.getElementById('view-btn-append')
  if (entry.id) {
    appendBtn.onclick = () => {
      closeView()
      openAppend(entry.id, entry.content.slice(0, 80))
    }
  } else {
    appendBtn.onclick = () => {
      closeView()
      openAppendFromContent(entry.content)
    }
  }
  const forgetBtn = document.getElementById('view-btn-forget')
  if (entry.id) {
    forgetBtn.onclick = () => {
      closeView()
      openConfirm(entry.id, cardElement || null)
    }
    forgetBtn.style.display = 'flex'
  } else {
    forgetBtn.style.display = 'none'
  }
  const editBtn = document.getElementById('view-btn-edit')
  if (entry.id) {
    editBtn.onclick = () => {
      closeView()
      openEdit(entry.id, entry.content, entry.tags || [])
    }
    editBtn.style.display = 'flex'
  } else {
    editBtn.style.display = 'none'
  }
  applyAuthorLock(entry)
  document.getElementById('view-sheet').classList.add('open')
  syncViewScrollBottomPadding()
}
function closeView() {
  document.getElementById('view-sheet').classList.remove('open')
}

// ── Related memories (issue #16) ──────────────────────────────────────────
async function loadRelated(id, el) {
  try {
    const res = await fetch(`${WORKER_URL}/connections`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await res.json()
    if (!data.ok || !data.connections || !data.connections.length) {
      // also handles the refresh after the last link is removed
      el.style.display = 'none'
      el.innerHTML = ''
      return
    }
    el.innerHTML =
      `<div class="view-related-label">${escHtml(t('memories.related'))}</div>` +
      data.connections
        .map(
          (c) => {
            const who =
              c.provenance === 'explicit'
                ? t('memories.youLinked')
                : c.provenance === 'system'
                  ? t('memories.systemLinked')
                  : t('memories.autoLinked')
            const when = c.linkedAt
              ? ' · ' + formatDateUI(c.linkedAt, { year: 'numeric', month: 'short', day: 'numeric' })
              : ''
            return `<div class="related-item" data-id="${escHtml(c.id)}" data-type="${escHtml(c.type)}"><button class="related-open"><span class="related-type">${escHtml(c.label)} · ${escHtml(who)}${escHtml(when)}</span>${escHtml((c.content || '').slice(0, 80))}</button><button class="related-unlink" aria-label="${escAttr(t('memories.removeLink'))}" title="${escAttr(t('memories.removeLink'))}"><i class="ti ti-unlink"></i></button></div>`
          },
        )
        .join('')
    el.style.display = 'block'
    el.querySelectorAll('.related-item').forEach((row) => {
      row.querySelector('.related-open').onclick = () => {
        const c = data.connections.find((x) => x.id === row.dataset.id)
        if (c) openView({ id: c.id, content: c.content, tags: c.tags }, null)
      }
      row.querySelector('.related-unlink').onclick = () => {
        // The app's own sheet, not the browser's: this dialog is the only one
        // on the page that could not be translated or styled.
        openDangerConfirm({
          title: t('danger.removeLinkTitle'),
          body: t('memories.removeLinkConfirm'),
          confirmLabel: t('danger.removeLinkAction'),
          onConfirm: async (_checked, done) => {
            try {
              await fetch(`${WORKER_URL}/unlink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
                body: JSON.stringify({ source_id: id, target_id: row.dataset.id, type: row.dataset.type }),
              })
            } catch {}
            await loadRelated(id, el)
            done()
          },
        })
      }
    })
  } catch {}
}
