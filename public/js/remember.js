// The receipt shown after a capture.
//
// The Remember tab that used to live here is gone: it was a second, worse door
// into the same room as the home input — no intent detection, no brief, and its
// own bottom-pinned box. This is the one piece of it worth keeping, and home
// renders it in place after saving.

/**
 * What the brain did with what you just wrote.
 *
 * Saving used to answer "Kept. I'll remember that." and, if you had typed
 * hashtags, echo them back — which told you only what you already knew. The
 * capture pipeline does considerably more: it files under the tags it found,
 * notices when a memory contradicts something older, merges near-duplicates,
 * and flags similar entries. All of that came back in the response and none of
 * it was shown. The marketing site's demo card ("● stored to brain") is this
 * moment; this makes the product keep that promise.
 */
function captureReceipt(result, typedTags) {
  const el = document.createElement('div')
  el.className = 'receipt'

  // The Worker reports what actually landed on the row, which includes tags it
  // pulled out of the content itself — not just the ones typed here.
  const filed = humanTags(result.tags && result.tags.length ? result.tags : typedTags || [])
  // The project the memory landed in: hidden as a raw tag everywhere, said here as a chip.
  const projects = projectChipsHtml(result.tags || [])

  let headline = t('home.receiptStored')
  const notes = []
  if (result.action === 'merged') {
    headline = t('home.receiptMerged')
    notes.push(t('home.receiptMergedNote'))
  } else if (result.action === 'replaced') {
    headline = t('home.receiptReplaced')
    notes.push(t('home.receiptReplacedNote'))
  } else if (result.resolved_conflict) {
    headline = t('home.receiptConflict')
    notes.push(t('home.receiptConflictNote'))
  } else if (result.kept_canonical) {
    headline = t('home.receiptDraft')
    notes.push(t('home.receiptDraftNote'))
  } else if (result.warning === 'similar') {
    headline = t('home.receiptSimilar')
    notes.push(t('home.receiptSimilarNote'))
  }

  if (result.semantic_unavailable) notes.push(t('home.receiptIndexPending'))

  el.innerHTML =
    `<div class="receipt-headline"><span class="receipt-dot"></span>${escHtml(headline)}</div>` +
    (filed.length || projects
      ? `<div class="receipt-filed">${escHtml(t('home.receiptFiledUnder'))} ${projects}${filed.map((tag) => `<span class="confirm-tag">${escHtml(tag)}</span>`).join('')}</div>`
      : '') +
    notes.map((n) => `<div class="receipt-note">${escHtml(n)}</div>`).join('')
  return el
}
