// Projects: a named home for related memories.
//
// Membership is a reserved `project:<slug>` tag on ordinary entries, so this
// screen manages the registry only. Everything else in the dashboard already
// filters by tag and just gains a `project` parameter.

/** Rows from the last GET /projects, active and archived together. */
let projectsList = []
/** True when the Worker hit its scan cap: every count is then a lower bound. */
let projectsCountsApprox = false
let projectsLoadFailed = false
let projectsArchivedOpen = false
let projectCreateOpen = false
/** Whether the last render showed the empty state, so leaving it can close the form. */
let projectsEmptyShown = false
let projectCreating = false

/**
 * The slug a name will be saved under: lowercase, spaces to hyphens, accents
 * folded, everything else dropped. Null when nothing usable is left.
 *
 * The create form posts this as the id, so what the preview shows is exactly
 * what gets saved rather than a second derivation on the Worker.
 */
function deriveProjectSlug(name) {
  const slug = String(name == null ? '' : name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+/, '')
    .slice(0, 64)
    .replace(/[-_]+$/, '')
  return PROJECT_SLUG_RE.test(slug) ? slug : null
}

async function loadProjects() {
  const list = document.getElementById('projects-list')
  // A cold screen says so; a refresh leaves the rows alone rather than blanking them.
  if (!projectsList.length && list) {
    list.innerHTML = `<div class="empty-state"><i class="ti ti-clock"></i><span>${escHtml(t('projects.loading'))}</span></div>`
  }
  try {
    const res = await apiProjects()
    if (!res.ok) throw new Error(String(res.status))
    projectsList = Array.isArray(res.data.projects) ? res.data.projects : []
    projectsCountsApprox = !!res.data.counts_approximate
    projectsLoadFailed = false
  } catch {
    // Rows already on screen stay; only a cold screen becomes the error state.
    projectsLoadFailed = !projectsList.length
    if (projectsList.length) showToast(t('projects.loadFailed'))
  }
  renderProjectsList()
}

function projectCountLabel(p) {
  if (typeof p.count !== 'number') return ''
  // A lower bound cannot claim a project is empty.
  if (projectsCountsApprox) return p.count > 0 ? t('projects.countApprox', { n: formatNumberUI(p.count) }) : ''
  if (p.count === 0) return t('projects.countNone')
  return tPlural('projects.count', p.count, { n: formatNumberUI(p.count) })
}

/** Workspace badge, team brains only: a solo brain has no other layer to tell apart. */
function projectLayerBadge(p) {
  if (!TEAM_MODE) return ''
  const shared = p.layer === 'company'
  const icon = shared ? '<i class="ti ti-users-group"></i> ' : ''
  return `<span class="tag-chip${shared ? ' tag-chip--shared' : ''}">${icon}${escHtml(shared ? t('home.layerShared') : t('home.layerPersonal'))}</span>`
}

function renderProjectRow(p) {
  const archived = p.status === 'archived'
  const desc = String(p.description || '').split('\n')[0].trim()
  const count = projectCountLabel(p)
  return (
    `<button type="button" class="project-row${archived ? ' project-row--archived' : ''}" onclick="openProject('${escAttr(p.id)}', '${escAttr(p.layer || '')}')">` +
    `<span class="project-row-main">` +
    `<span class="project-row-name">${escHtml(p.name || p.id)}</span>` +
    (desc ? `<span class="project-row-desc">${escHtml(desc)}</span>` : '') +
    `</span>` +
    `<span class="project-row-meta">` +
    `<code class="project-row-slug">${escHtml(p.id)}</code>` +
    projectLayerBadge(p) +
    (count ? `<span class="project-row-count num">${escHtml(count)}</span>` : '') +
    `</span>` +
    `<i class="ti ti-chevron-right project-row-go" aria-hidden="true"></i>` +
    `</button>`
  )
}

function renderProjectsList() {
  const list = document.getElementById('projects-list')
  const empty = document.getElementById('projects-empty')
  const archivedWrap = document.getElementById('projects-archived')
  const archivedList = document.getElementById('projects-archived-list')
  const archivedToggle = document.getElementById('projects-archived-toggle')
  const newBtn = document.getElementById('project-new-btn')
  const layerWrap = document.getElementById('project-layer-wrap')
  // Both branches, every render: the flag is only settled once /health answers.
  if (layerWrap) layerWrap.style.display = TEAM_MODE ? '' : 'none'

  if (projectsLoadFailed) {
    list.innerHTML =
      `<div class="empty-state"><i class="ti ti-wifi-off"></i><span>${escHtml(t('projects.loadFailed'))}</span>` +
      `<button type="button" class="btn btn-secondary btn-sm" onclick="loadProjects()">${escHtml(t('projects.retry'))}</button></div>`
    empty.hidden = true
    archivedWrap.hidden = true
    return
  }

  const active = projectsList.filter((p) => p.status !== 'archived')
  const archived = projectsList.filter((p) => p.status === 'archived')
  list.innerHTML = active.map(renderProjectRow).join('')

  archivedWrap.hidden = archived.length === 0
  archivedToggle.textContent = t('projects.archivedToggle', { n: archived.length })
  archivedToggle.setAttribute('aria-expanded', String(projectsArchivedOpen))
  archivedList.hidden = !projectsArchivedOpen
  archivedList.innerHTML = archived.map(renderProjectRow).join('')

  // Nothing to browse yet: explain, and put the form under the cursor. The
  // header button would only duplicate the open form.
  const isEmpty = active.length === 0
  empty.hidden = !isEmpty
  newBtn.hidden = isEmpty
  if (isEmpty) setProjectCreateOpen(true, { focus: true })
  else if (projectsEmptyShown) setProjectCreateOpen(false)
  else setProjectCreateOpen(projectCreateOpen)
  projectsEmptyShown = isEmpty
  onProjectNameInput()
  // The pickers read the same registry, so they follow it without another request.
  setComposerProjects(active)
}

function toggleProjectsArchived() {
  projectsArchivedOpen = !projectsArchivedOpen
  document.getElementById('projects-archived-toggle').setAttribute('aria-expanded', String(projectsArchivedOpen))
  document.getElementById('projects-archived-list').hidden = !projectsArchivedOpen
}

// ── Create form ───────────────────────────────────────────────────────────

function setProjectCreateOpen(open, opts) {
  projectCreateOpen = open
  document.getElementById('project-create').hidden = !open
  document.getElementById('project-new-btn').setAttribute('aria-expanded', String(open))
  if (open && opts && opts.focus) document.getElementById('project-name').focus()
}

function toggleProjectCreate() {
  setProjectCreateOpen(!projectCreateOpen, { focus: true })
}

/** Is this slug already used in the workspace the project would land in? */
function projectSlugTaken(slug) {
  const layer = TEAM_MODE ? document.getElementById('project-layer').value : ''
  // Auto could land in either layer, so any match counts; the Worker's 409 is
  // the backstop for the rest.
  return projectsList.some((p) => p.id === slug && (!layer || p.layer === layer))
}

/** Live slug preview and the Create button's readiness, on every keystroke. */
function onProjectNameInput() {
  const name = document.getElementById('project-name').value
  const slug = deriveProjectSlug(name)
  const taken = !!slug && projectSlugTaken(slug)
  const preview = document.getElementById('project-slug-preview')
  let text
  let tone = ''
  if (!name.trim()) text = t('projects.slugEmpty')
  else if (!slug) {
    text = t('projects.slugInvalid')
    tone = 'project-slug--error'
  } else if (taken) {
    text = t('projects.slugTaken')
    tone = 'project-slug--error'
  } else {
    text = t('projects.slugPreview', { slug })
    tone = 'project-slug--ready'
  }
  preview.textContent = text
  preview.className = `project-slug ${tone}`.trim()
  document.getElementById('project-create-btn').disabled = !slug || taken || projectCreating
  const err = document.getElementById('project-create-error')
  err.hidden = true
  err.textContent = ''
}

function showProjectCreateError(message) {
  const err = document.getElementById('project-create-error')
  err.textContent = message
  err.hidden = false
}

async function submitProject() {
  if (projectCreating) return
  const name = document.getElementById('project-name').value.trim()
  const slug = deriveProjectSlug(name)
  if (!slug || projectSlugTaken(slug)) return
  const body = { id: slug, name }
  const description = document.getElementById('project-desc').value.trim()
  if (description) body.description = description
  const layer = TEAM_MODE ? document.getElementById('project-layer').value : ''
  if (layer) body.workspace = layer

  projectCreating = true
  const btn = document.getElementById('project-create-btn')
  btn.disabled = true
  btn.textContent = t('projects.creating')
  let res = null
  try {
    res = await apiProjectCreate(body)
  } catch {}
  projectCreating = false
  btn.textContent = t('projects.create')

  if (!res || !res.ok) {
    // Recomputed first: it resets the error line, which is then set.
    onProjectNameInput()
    showProjectCreateError(
      !res ? t('projects.createFailed') : res.status === 409 ? t('projects.slugTaken') : res.data.error || t('projects.createFailed'),
    )
    return
  }

  document.getElementById('project-name').value = ''
  document.getElementById('project-desc').value = ''
  showToast(t('projects.createdToast', { name }))
  setProjectCreateOpen(false)
  await loadProjects()
}

// ── Detail view ───────────────────────────────────────────────────────────

/** { slug, layer } of the open project; null while the list is showing. */
let projectDetail = null
/** Tags a person already uses, as [{ tag, count }] — count null when unknown. */
let projectVocab = []
let projectVocabApprox = false
/** Digest in flight: the button is held down and a second press is ignored. */
let projectDigesting = false

/** Same limit the Worker enforces, so the editor can say no before a round trip. */
const PROJECT_ALIAS_MAX = 16
/** Suggestions are a hint, not the whole vocabulary. */
const PROJECT_SUGGEST_MAX = 12
const PROJECT_CAPSULE_SLOTS = ['current-state', 'decisions', 'open-questions']

function findProject(slug, layer) {
  return projectsList.find((p) => p.id === slug && (p.layer || '') === (layer || '')) || null
}

function openProjectRow() {
  return projectDetail ? findProject(projectDetail.slug, projectDetail.layer) : null
}

/** The workspace to name in a request. Team brains only: a solo brain has one layer. */
function projectWorkspace() {
  return TEAM_MODE && projectDetail ? projectDetail.layer : ''
}

function showProjectsView(detail) {
  document.getElementById('projects-list-view').hidden = detail
  document.getElementById('projects-detail-view').hidden = !detail
  // Creating is a list-view action; renderProjectsList() puts the button back.
  if (detail) document.getElementById('project-new-btn').hidden = true
  document.getElementById('projects-body').scrollTop = 0
}

async function openProject(slug, layer) {
  if (!findProject(slug, layer)) return
  projectDetail = { slug, layer: layer || '' }
  // Whatever the last project left in these belongs to it, not to this one.
  for (const id of ['project-alias-error', 'project-edit-error']) {
    const el = document.getElementById(id)
    el.hidden = true
    el.textContent = ''
  }
  document.getElementById('project-alias-input').value = ''
  document.getElementById('project-digest-result').innerHTML = ''
  showProjectsView(true)
  renderProjectDetail()
  // The row that was pressed has just left the screen; keyboard focus goes to the way back.
  document.getElementById('project-back-btn').focus()
  await Promise.all([loadProjectMemories(), loadProjectVocab()])
}

function backToProjects() {
  projectDetail = null
  showProjectsView(false)
  // The list is redrawn from what this session already knows, then reloaded:
  // counts move as memories are filed and forgotten while the detail is open.
  renderProjectsList()
  loadProjects()
}

/** Paint everything that comes from the project row itself. */
function renderProjectDetail() {
  const p = openProjectRow()
  if (!p) return
  const archived = p.status === 'archived'
  document.getElementById('project-head').innerHTML =
    `<div class="project-head-top">` +
    `<h2>${escHtml(p.name || p.id)}</h2>` +
    (archived ? `<span class="tag-chip">${escHtml(t('projects.archivedChip'))}</span>` : '') +
    projectLayerBadge(p) +
    `</div>` +
    `<code class="project-row-slug">${escHtml(p.id)}</code>` +
    (p.description ? `<p class="project-head-desc">${escHtml(p.description)}</p>` : '')
  document.getElementById('project-edit-name').value = p.name || ''
  document.getElementById('project-edit-desc').value = p.description || ''
  document.getElementById('project-archive-btn').textContent = archived ? t('projects.restore') : t('projects.archive')
  onProjectEditInput()
  renderProjectAliases()
  renderProjectSuggestions()
}

// ── Memories and capsule ──

/** `tags` arrives as the column's JSON string from /list, as an array elsewhere. */
function projectEntryTags(entry) {
  if (Array.isArray(entry.tags)) return entry.tags
  try {
    return JSON.parse(entry.tags || '[]')
  } catch {
    return []
  }
}

/**
 * Which capsule slots this project has filled, as slot -> entry id.
 *
 * Mirrors the Worker's rule (src/prompt-capsule/select.ts): one canonical
 * memory, tagged for this project and for exactly one known slot. A slot with
 * two candidates is ambiguous, and the Worker leaves it out, so it is empty here.
 */
function projectCapsuleSlots(slug, entries) {
  const base = `capsule:project:${slug}`
  const found = new Map()
  for (const entry of entries) {
    const tags = projectEntryTags(entry).map((tag) => String(tag).toLowerCase())
    const status = tags.filter((tag) => tag.startsWith('status:'))
    const namespaces = tags.filter((tag) => tag.startsWith('capsule:'))
    const slots = tags.filter((tag) => tag.startsWith('capsule-slot:')).map((tag) => tag.slice('capsule-slot:'.length))
    if (status.length !== 1 || status[0] !== 'status:canonical') continue
    if (namespaces.length !== 1 || namespaces[0] !== base) continue
    if (slots.length !== 1 || !PROJECT_CAPSULE_SLOTS.includes(slots[0])) continue
    found.set(slots[0], [...(found.get(slots[0]) || []), entry.id])
  }
  const filled = new Map()
  for (const [slot, ids] of found) if (ids.length === 1) filled.set(slot, ids[0])
  return filled
}

function renderProjectCapsule(slug, filled) {
  // Literal translate calls, not a lookup keyed by slot id: the i18n suite's
  // scanner only credits a key as used when it can read the call site.
  const label = (id) => {
    if (id === 'current-state') return t('projects.slotCurrentState')
    if (id === 'decisions') return t('projects.slotDecisions')
    return t('projects.slotOpenQuestions')
  }
  const rows = PROJECT_CAPSULE_SLOTS.map((id) => {
    if (filled.has(id)) {
      return `<button type="button" class="slot" onclick="openCapsuleMemory('${escAttr(filled.get(id))}', this)"><i class="ti ti-circle-check"></i><span class="slot-body">${escHtml(label(id))}<small>${escHtml(t('projects.slotSet'))}</small></span></button>`
    }
    return `<div class="slot empty"><i class="ti ti-circle"></i><span class="slot-body">${escHtml(label(id))}<small>${escHtml(t('board.slotEmpty'))}</small></span></div>`
  })
  const howTo = filled.size ? '' : `<p class="digest-note">${escHtml(t('projects.capsuleHowTo', { slug }))}</p>`
  document.getElementById('project-capsule').innerHTML = `<div class="slots">${rows.join('')}</div>${howTo}`
}

async function loadProjectMemories() {
  const detail = projectDetail
  if (!detail) return
  const box = document.getElementById('project-memories')
  const note = document.getElementById('project-memories-note')
  const workspace = projectWorkspace() || undefined
  // Two scans, side by side: the project's own, and the one tag that names its
  // capsule. A capsule memory is not necessarily filed under the project, so
  // the first alone could report a filled slot as empty.
  const [scan, capsule] = await Promise.all([
    apiList(50, workspace, null, '', detail.slug).catch(() => null),
    apiList(20, workspace, null, `capsule:project:${detail.slug}`).catch(() => null),
  ])
  // Superseded by another project, or by leaving: this answer is for nobody.
  if (projectDetail !== detail) return

  if (!Array.isArray(scan)) {
    box.innerHTML = `<div class="empty-state"><i class="ti ti-wifi-off"></i><span>${escHtml(t('memories.loadFailed'))}</span></div>`
    note.hidden = true
  } else if (!scan.length) {
    box.innerHTML = `<div class="empty-state"><i class="ti ti-brain"></i><span>${escHtml(t('projects.memoriesEmpty'))}</span></div>`
    note.hidden = true
  } else {
    box.innerHTML = ''
    scan.forEach((entry) => box.appendChild(makeRecentCard(entry, { selectable: false })))
    note.hidden = scan.length < 50
    note.textContent = t('projects.memoriesShowing', { n: scan.length })
  }

  const seen = new Set()
  const pool = [...(Array.isArray(scan) ? scan : []), ...(Array.isArray(capsule) ? capsule : [])].filter((e) => {
    if (!e || seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
  renderProjectCapsule(detail.slug, projectCapsuleSlots(detail.slug, pool))
}

/** refreshAll() calls this: a memory edited or forgotten here must not linger on screen. */
function refreshProjectDetail() {
  return projectDetail ? loadProjectMemories() : Promise.resolve()
}

// ── Aliases ──

function renderProjectAliases() {
  const p = openProjectRow()
  if (!p) return
  const aliases = p.aliases || []
  document.getElementById('project-aliases').innerHTML = aliases.length
    ? aliases
        .map(
          (a) =>
            `<button type="button" class="tag-chip tag-chip--removable" onclick="removeProjectAlias('${escAttr(a)}')" aria-label="${escHtml(t('projects.aliasRemove', { tag: a }))}">${escHtml(a)}<i class="ti ti-x"></i></button>`,
        )
        .join('')
    : `<span class="project-alias-none">${escHtml(t('projects.aliasNone'))}</span>`
}

/**
 * The vocabulary, with a count per tag where one is known.
 *
 * GET /tags?counts=1 answers { tag, count } objects; an older Worker's bare
 * names fall back to the brief's topics for the tags it covers. A tag with
 * no known count is still offered, without one.
 */
async function loadProjectVocab() {
  let raw = []
  projectVocabApprox = false
  try {
    const res = await fetch(`${WORKER_URL}/tags?counts=1`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } })
    if (res.ok) {
      raw = await res.json()
      // The Worker's tally stops at a row cap; counts past it are lower bounds.
      projectVocabApprox = res.headers.get('X-Counts-Approximate') === '1'
    }
  } catch {}
  const topics = new Map()
  if (typeof briefData !== 'undefined' && briefData) {
    for (const topic of briefData.topics || []) topics.set(topic.tag, topic.count)
  }
  projectVocab = (Array.isArray(raw) ? raw : [])
    .map((item) => (typeof item === 'string' ? { tag: item, count: topics.has(item) ? topics.get(item) : null } : { tag: item && item.tag, count: typeof item.count === 'number' ? item.count : topics.has(item.tag) ? topics.get(item.tag) : null }))
    .filter((v) => typeof v.tag === 'string' && !isSystemTag(v.tag))
  renderProjectSuggestions()
}

function renderProjectSuggestions() {
  const box = document.getElementById('project-alias-suggest')
  const p = openProjectRow()
  if (!p) return
  const typed = document.getElementById('project-alias-input').value.trim().replace(/^#/, '').toLowerCase()
  const taken = new Set((p.aliases || []).map((a) => a.toLowerCase()))
  const items = projectVocab
    .filter((v) => !taken.has(v.tag.toLowerCase()) && (!typed || v.tag.toLowerCase().includes(typed)))
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || (a.tag < b.tag ? -1 : 1))
    .slice(0, PROJECT_SUGGEST_MAX)
  box.innerHTML = items.length
    ? `<span class="project-suggest-label">${escHtml(t('projects.aliasSuggestLabel'))}</span>` +
      items
        .map(
          (v) =>
            `<button type="button" class="topic-chip" title="${escHtml(t('projects.aliasSuggestTitle', { tag: v.tag }))}" onclick="addProjectAlias('${escAttr(v.tag)}')">${escHtml(v.tag)}${v.count == null ? '' : `<span>${escHtml(formatNumberUI(v.count))}${projectVocabApprox ? '+' : ''}</span>`}</button>`,
        )
        .join('')
    : ''
}

function onProjectAliasInput() {
  const err = document.getElementById('project-alias-error')
  err.hidden = true
  err.textContent = ''
  renderProjectSuggestions()
}

function showProjectAliasError(message) {
  const err = document.getElementById('project-alias-error')
  err.textContent = message
  err.hidden = false
}

/** Save a new alias list, or say why not. Returns whether it stuck. */
async function saveProjectAliases(aliases) {
  const detail = projectDetail
  const res = await apiProjectPatch(detail.slug, { aliases }, projectWorkspace()).catch(() => null)
  if (!res || !res.ok) {
    showProjectAliasError((res && res.data.error) || t('projects.aliasFailed'))
    return false
  }
  const row = findProject(detail.slug, detail.layer)
  if (row) Object.assign(row, res.data.project || { aliases })
  if (projectDetail !== detail) return true
  renderProjectAliases()
  renderProjectSuggestions()
  // The set of memories that belong here just changed with the alias list.
  loadProjectMemories()
  return true
}

/** From the input, or from a suggestion chip that names the tag itself. */
async function addProjectAlias(tag) {
  const p = openProjectRow()
  if (!p) return
  const input = document.getElementById('project-alias-input')
  const alias = String(tag == null ? input.value : tag)
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
  if (!alias) return
  const aliases = p.aliases || []
  if (aliases.includes(alias)) return
  // isSystemTag covers every reserved prefix the Worker refuses, and the
  // pipeline's own markers, which no one means to group by.
  if (isSystemTag(alias) || alias.length > 128) return showProjectAliasError(t('projects.aliasInvalid'))
  if (aliases.length >= PROJECT_ALIAS_MAX) return showProjectAliasError(t('projects.aliasLimit'))
  if (await saveProjectAliases([...aliases, alias])) input.value = ''
}

async function removeProjectAlias(tag) {
  const p = openProjectRow()
  if (!p) return
  await saveProjectAliases((p.aliases || []).filter((a) => a !== tag))
}

// ── Name and description ──

function projectEditChanges() {
  const p = openProjectRow()
  if (!p) return {}
  const name = document.getElementById('project-edit-name').value.trim()
  const description = document.getElementById('project-edit-desc').value.trim()
  const changes = {}
  if (name !== (p.name || '')) changes.name = name
  if (description !== (p.description || '').trim()) changes.description = description
  return changes
}

function onProjectEditInput() {
  const changes = projectEditChanges()
  const nameEmpty = !document.getElementById('project-edit-name').value.trim()
  document.getElementById('project-save-btn').disabled = !Object.keys(changes).length || nameEmpty
  const err = document.getElementById('project-edit-error')
  err.hidden = true
  err.textContent = ''
}

async function saveProjectDetails() {
  const changes = projectEditChanges()
  if (!Object.keys(changes).length || ('name' in changes && !changes.name)) return
  const detail = projectDetail
  const btn = document.getElementById('project-save-btn')
  btn.disabled = true
  btn.textContent = t('memories.saving')
  const res = await apiProjectPatch(projectDetail.slug, changes, projectWorkspace()).catch(() => null)
  btn.textContent = t('projects.save')
  if (!res || !res.ok) {
    onProjectEditInput()
    const err = document.getElementById('project-edit-error')
    err.textContent = (res && res.data.error) || t('projects.saveFailed')
    err.hidden = false
    return
  }
  const row = findProject(detail.slug, detail.layer)
  if (row) Object.assign(row, res.data.project || changes)
  if (projectDetail === detail) renderProjectDetail()
  showToast(t('projects.savedToast'))
}

// ── Digest ──

async function runProjectDigest() {
  if (projectDigesting || !projectDetail) return
  const detail = projectDetail
  projectDigesting = true
  const btn = document.getElementById('project-digest-btn')
  const out = document.getElementById('project-digest-result')
  btn.disabled = true
  btn.textContent = t('upkeep.working')
  out.innerHTML = ''
  let data = null
  try {
    const body = { project: detail.slug }
    if (projectWorkspace()) body.workspace = projectWorkspace()
    const res = await fetch(`${WORKER_URL}/digest`, { method: 'POST', headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    data = await res.json()
  } catch {}
  projectDigesting = false
  btn.disabled = false
  btn.textContent = t('projects.digestAction')
  if (!data) {
    out.innerHTML = `<p class="project-digest-error">${escHtml(t('upkeep.requestFailed'))}</p>`
    return
  }
  if (!data.synthesis) {
    out.innerHTML = `<p class="project-digest-error">${escHtml(data.error || t('upkeep.digestFailed'))}</p>`
    return
  }
  out.innerHTML =
    `<div class="digest-result">${escHtml(data.synthesis)}` +
    `<div class="digest-result-meta"><i class="ti ti-lock"></i> ${escHtml(tPlural('upkeep.digestPreserved', data.source_count))}</div></div>`
  // The digest is filed inside the project, so it belongs in the list above.
  if (projectDetail === detail) loadProjectMemories()
}

// ── Archive and delete ──

/** Set a project's status, wherever the user is by the time it lands. */
async function setProjectStatus(slug, layer, status) {
  const res = await apiProjectPatch(slug, { status }, TEAM_MODE ? layer : '').catch(() => null)
  if (!res || !res.ok) {
    showToast(t('projects.updateFailed'))
    return
  }
  const row = findProject(slug, layer)
  if (row) row.status = status
  if (projectDetail && projectDetail.slug === slug && projectDetail.layer === (layer || '')) renderProjectDetail()
  // Only archiving is offered an undo: restoring is already the way back.
  if (status === 'archived') showToast(t('projects.archivedToast'), { action: t('team.undo'), onAction: () => setProjectStatus(slug, layer, 'active') })
  else showToast(t('projects.restoredToast'))
}

/**
 * Archive or restore. No confirmation: it hides nothing that cannot be
 * brought back with one press, and the toast offers exactly that press.
 */
function toggleProjectArchived() {
  const p = openProjectRow()
  if (!p) return
  return setProjectStatus(p.id, p.layer || '', p.status === 'archived' ? 'active' : 'archived')
}

function confirmDeleteProject() {
  const p = openProjectRow()
  if (!p) return
  const detail = projectDetail
  openDangerConfirm({
    title: t('projects.deleteTitle', { name: p.name || p.id }),
    body: t('projects.deleteBody'),
    confirmLabel: t('projects.delete'),
    onConfirm: async (_checked, done) => {
      const res = await apiProjectDelete(detail.slug, TEAM_MODE ? detail.layer : '').catch(() => null)
      done()
      if (!res || !res.ok) {
        showToast(t('projects.deleteFailed'))
        return
      }
      projectsList = projectsList.filter((x) => !(x.id === detail.slug && (x.layer || '') === detail.layer))
      showToast(t('projects.deletedToast'))
      if (projectDetail === detail) backToProjects()
    },
  })
}

// ── Everyday surfaces: composer picker, filters, chips ────────────────────

/** Active projects, as the composer picker and the two filters offer them. */
let composerProjects = []
/** The picker's slug. null until first read, so storage is not touched at load. */
let composerProject = null
const PROJECT_LAST_KEY = 'sb-project-last'

/** The composer's project, or '' for none: what the next capture files under. */
function selectedComposerProject() {
  const sel = document.getElementById('home-project')
  return sel ? sel.value : ''
}

function projectOptionsHtml(noneLabel) {
  return (
    `<option value="">${escHtml(noneLabel)}</option>` +
    composerProjects.map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.name || p.id)}</option>`).join('')
  )
}

/** Paint the composer picker and both filters from composerProjects. */
function renderProjectPickers() {
  const has = composerProjects.length > 0
  if (composerProject === null) {
    try {
      composerProject = localStorage.getItem(PROJECT_LAST_KEY) || ''
    } catch {
      composerProject = ''
    }
  }
  // A choice that has since been archived or deleted is not offered any more.
  if (!composerProjects.some((p) => p.id === composerProject)) composerProject = ''
  const filterVanished = selectedProject !== '' && !composerProjects.some((p) => p.id === selectedProject)
  if (filterVanished) selectedProject = ''

  const pick = document.getElementById('home-project')
  if (pick) {
    pick.innerHTML = projectOptionsHtml(t('projects.pickerNone'))
    pick.value = composerProject
  }
  const wrap = document.getElementById('home-project-wrap')
  if (wrap) wrap.style.display = has ? '' : 'none'

  for (const which of ['recent', 'recall']) {
    const filter = document.getElementById(`project-filter-${which}`)
    if (filter) {
      filter.innerHTML = projectOptionsHtml(t('projects.filterAll'))
      filter.value = selectedProject
    }
    const fwrap = document.getElementById(`project-filter-wrap-${which}`)
    if (fwrap) fwrap.style.display = has ? '' : 'none'
  }
  // The rows on screen were filtered by the project that just went away.
  if (filterVanished && currentTab === 'memories' && typeof loadRecent === 'function') loadRecent()
}

/** Pickers take the active rows once, de-duplicated by slug (first workspace wins). */
function setComposerProjects(rows) {
  const before = JSON.stringify(composerProjects.map((p) => [p.id, p.name]))
  const seen = new Set()
  composerProjects = (rows || []).filter((p) => p.status !== 'archived' && !seen.has(p.id) && seen.add(p.id))
  renderProjectPickers()
  // Cards already on screen named their projects before the names arrived.
  const after = JSON.stringify(composerProjects.map((p) => [p.id, p.name]))
  if (before !== after && currentTab === 'memories' && allEntries.length && typeof applyRecentFilters === 'function') applyRecentFilters()
}

/** A light fetch: no counts, no archived rows. Quiet when the Worker has no /projects. */
async function loadComposerProjects() {
  try {
    const res = await apiProjects({ counts: false, includeArchived: false })
    if (res.ok && Array.isArray(res.data.projects)) setComposerProjects(res.data.projects)
    else if (res.status === 404) setComposerProjects([])
  } catch {}
}

function onHomeProjectChange(slug) {
  composerProject = slug || ''
  try {
    if (slug) localStorage.setItem(PROJECT_LAST_KEY, slug)
    else localStorage.removeItem(PROJECT_LAST_KEY)
  } catch {}
  // A project lives in one workspace, so filing into it means capturing there.
  // The layer control moves with it, in view, rather than being overridden.
  const row = composerProjects.find((p) => p.id === slug)
  if (TEAM_MODE && row && row.layer) {
    const layer = document.getElementById('home-layer')
    if (layer) layer.value = row.layer
    onHomeLayerChange(row.layer)
  }
}

/** The Memories and recall filter: one selection, shown in both places. */
function onProjectFilterChange(slug) {
  selectedProject = slug || ''
  renderProjectPickers()
  // Recall reads the selection when it asks; the list has to be refetched, since
  // the Worker expands aliases and the browser cannot.
  if (currentTab === 'memories') loadRecent()
}

function projectName(slug) {
  const known = composerProjects.find((p) => p.id === slug) || projectsList.find((p) => p.id === slug)
  return (known && known.name) || slug
}
