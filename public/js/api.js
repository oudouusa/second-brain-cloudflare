// Team-edition flag for the whole dashboard: set once /health answers (see
// maybeRevealHomeLayer in home.js). Every layer control — capture target,
// share actions, layer filters — reads this, so solo brains never render any
// of it. Declared here because api.js loads before every consumer.
let TEAM_MODE = false
/** The composer's capture target: null = Auto (server-side member/org default decides). */
let homeLayer = null

async function apiCapture(content, tags, source, workspace, project) {
  const res = await fetch(`${WORKER_URL}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    // workspace is omitted unless the user picked a layer explicitly — the
    // server's per-member/org default then decides, which is what makes admin
    // policy the quiet default rather than a hard-coded one here.
    // project files the memory under a registered project; the Worker unions the
    // project:<slug> tag in itself.
    body: JSON.stringify({ content, tags, source: source || 'web-ui', ...(workspace ? { workspace } : {}), ...(project ? { project } : {}) }),
  })
  return res.json()
}

async function apiList(n = 50, workspace, actor, tag, project) {
  const body = { n }
  if (workspace) body.workspace = workspace
  if (actor) body.actor = actor
  if (tag) body.tag = tag
  if (project) body.project = project
  const res = await fetch(`${WORKER_URL}/list`, { method: "POST", headers: { Authorization: `Bearer ${AUTH_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return res.json()
}

/**
 * One request to the /projects routes, resolved to { ok, status, data }.
 *
 * Not thrown on a non-2xx: callers branch on the status (409 means the slug is
 * taken, which the create form explains rather than reports as a failure).
 * A rejected promise still means the network itself failed.
 */
async function projectsRequest(method, path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${AUTH_TOKEN}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  let data = {}
  try {
    data = await res.json()
  } catch {}
  return { ok: res.ok, status: res.status, data }
}

/**
 * Registry rows. The Projects screen wants counts and archived rows; a picker
 * wants neither, and counts cost a scan on the Worker.
 */
function apiProjects({ counts = true, includeArchived = true } = {}) {
  const params = new URLSearchParams()
  if (counts) params.set('counts', '1')
  if (includeArchived) params.set('include_archived', '1')
  const query = String(params)
  return projectsRequest('GET', query ? `/projects?${query}` : '/projects')
}

function apiProjectCreate(body) {
  return projectsRequest('POST', '/projects', body)
}

/** `workspace` is the row's layer: the same slug can exist in two workspaces. */
function projectPath(slug, workspace) {
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
  return `/projects/${encodeURIComponent(slug)}${q}`
}

function apiProjectPatch(slug, body, workspace) {
  return projectsRequest('PATCH', projectPath(slug, workspace), body)
}

function apiProjectDelete(slug, workspace) {
  return projectsRequest('DELETE', projectPath(slug, workspace))
}

/** Move a memory between the personal and company layers (MOVE semantics). */
async function apiShare(id, workspace) {
  const res = await fetch(`${WORKER_URL}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify({ id, workspace }),
  })
  return res.json()
}

/**
 * Move a memory between layers, reporting it with an undo toast.
 *
 * No confirmation in front of this: the act is reversible in one tap and the
 * toast is what offers that tap. Asking first as well made two questions of
 * one reversible decision, which is how people learn to dismiss dialogs
 * without reading them.
 */
async function toggleEntryLayer(id, currentLayer, onDone) {
  const goingShared = currentLayer !== 'company'
  const target = goingShared ? 'company' : 'personal'
  const previous = currentLayer === 'company' ? 'company' : 'personal'
  try {
    const r = await apiShare(id, target)
    if (!r.ok) throw new Error(r.error || t('team.actionFailed'))
    showToast(goingShared ? t('team.sharedToast') : t('team.unsharedToast'), {
      action: t('team.undo'),
      onAction: async () => {
        // Checked and caught, unlike the fire-and-forget this replaced. This
        // is the one control in the dashboard whose entire job is reversing a
        // mistake, and a refused or unreachable undo used to leave the memory
        // exactly where the user did not want it while saying nothing at all —
        // so their correction looked identical to their error. Reported the
        // same way the outer failure is, through the toast.
        try {
          const undone = await apiShare(id, previous)
          if (!undone.ok) throw new Error(undone.error || t('team.actionFailed'))
        } catch (e) {
          showToast(e.message || t('team.actionFailed'))
          return
        }
        if (typeof onDone === 'function') onDone()
        else if (typeof refreshAll === 'function') refreshAll()
      },
    })
    if (typeof onDone === 'function') onDone()
    else if (typeof loadRecent === 'function') loadRecent()
    else if (typeof refreshAll === 'function') refreshAll()
  } catch (e) {
    showToast(e.message || t('team.actionFailed'))
  }
}
