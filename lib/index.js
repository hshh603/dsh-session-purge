/**
 * dsh-session-purge — Host half.
 *
 * One contributed capability: permanently delete one Session's durable record,
 * and — by chosen mode — the files that Session wrote inside its own working
 * directory plus the attachment objects no other Session references.
 *
 * DSH has no deletion API anywhere: `@deepseek-ai/dsh-session-persistence`
 * documents "No deletion or retention API — pruning stored sessions is
 * out-of-band backend maintenance", and the JSONL backend documents "Nothing
 * deletes session files". This plugin is that out-of-band maintenance, done from
 * inside the process so it can use the backend's own reader instead of
 * re-implementing Zstandard frame handling.
 *
 * Three surfaces:
 *
 *   1. `POST /plugins/dsh-session-purge/api/scan`  — build a deletion plan and
 *      report exactly what would be removed, plus every path it refuses.
 *   2. `POST /plugins/dsh-session-purge/api/purge` — rebuild that same plan and
 *      execute it. The plan is recomputed from the Session log on the Host; the
 *      browser never sends a path list, so a tampered request cannot widen what
 *      is deleted.
 *   3. `GET  /plugins/dsh-session-purge/api/health` — liveness for the browser
 *      half and for an operator's curl.
 *
 * Safety invariants, all enforced here rather than in the browser:
 *
 *   * A Session id is validated as a single safe path segment before it is used
 *     to locate anything; no request value is ever concatenated into a path.
 *   * An artifact is deleted only when its real path is strictly inside the
 *     Session's recorded `cwd`, and never when it lies inside the DSH home.
 *   * Only files are deleted in "artifacts" mode; directories are left alone.
 *   * An attachment object is deleted only after every other stored Session has
 *     been read and none references it; any read failure keeps it.
 */

import { readdir, realpath, rm, stat as fsStat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Package name the loader mounts this row as; also the browser module id. */
export const name = 'dsh-session-purge'

/**
 * Services this half requires. `webServer` carries the three routes; the
 * persistence seam is the only supported reader of a stored Session log, and it
 * is never absent from a composition that can list Sessions at all.
 */
export const inject = ['webServer', 'sessionPersistence']

/** Route prefix for this plugin's own JSON endpoints. */
const ROUTE = '/plugins/dsh-session-purge/api'

/** Accepted delete modes, in increasing destructiveness. */
const MODES = ['record', 'artifacts', 'everything']

/**
 * A Session id is one path segment: letters, digits, dot, underscore, dash.
 * Every id DSH produces today (`<uuid>` and `session-<uuid>`) matches, and the
 * shape check is what makes joining it onto the sessions root safe.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/

/**
 * Argument keys that carry the target path, per writing tool. `write` and `edit`
 * name it `file_path`; the Minimal preset's `str_replace_editor` uses `path`.
 */
const WRITE_TOOL_PATHS = {
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  str_replace_editor: ['path', 'file_path'],
  create_file: ['file_path', 'path'],
}

/** Largest request body this plugin accepts; every body it defines is tiny. */
const MAX_BODY_BYTES = 256 * 1024

/** How many artifact/attachment rows one scan response may carry. */
const MAX_REPORTED_ROWS = 500

/** Resolve the DSH home exactly as the rest of the harness does. */
async function resolveHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  try {
    // Present in every shipped composition; a dynamic import keeps this half
    // loadable even where the library cannot be resolved.
    const library = await import('@deepseek-ai/dsh-home-paths')
    if (typeof library.resolveDshHome === 'function') return library.resolveDshHome()
  } catch {
    // Fall through to the documented default.
  }
  return join(homedir(), '.dsh')
}

/** One short human-readable line for a caught value. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Whether `child` is strictly inside `parent`, comparing real paths. */
function inside(parent, child) {
  if (parent === child) return false
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(prefix)
}

/** Sum the bytes of every regular file under one directory, missing paths read as 0. */
async function directoryBytes(directory) {
  let total = 0
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) {
      try {
        total += (await fsStat(child)).size
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total
}

/**
 * Read a full request body as JSON.
 * @param req - incoming Node request.
 * @returns the parsed body; an absent body parses as `{}`.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** Answer one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Refuse anything that did not come from this plugin's own page.
 *
 * `/plugins` routes answer without the shell's session authorization, so a bare
 * endpoint here would let any local page or process trigger a deletion. The
 * marker header cannot be set by a cross-origin form or simple request (it
 * forces a preflight the web server does not answer), and the origin check
 * rejects a same-shape request from another page's origin.
 *
 * @param req - incoming request.
 */
function requireOwnPage(req) {
  if (req.headers?.['x-dsh-session-purge'] !== '1') throw new Error('缺少插件请求标记')
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return
  let originHost = null
  try {
    originHost = new URL(origin).host
  } catch {
    throw new Error('请求来源不合法')
  }
  const host = req.headers.host
  if (typeof host === 'string' && host !== '' && originHost !== host) throw new Error('已拒绝跨站请求')
}

/**
 * The Session creation header, whatever shape the backend's snapshot uses.
 * @param snapshot - result of `sessionPersistence.stat`.
 * @returns the header record, or null when the snapshot carries none.
 */
function headerOf(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null
  const nested = snapshot.header
  if (nested !== null && typeof nested === 'object' && typeof nested.id === 'string') return nested
  if (typeof snapshot.id === 'string' && typeof snapshot.version === 'number') return snapshot
  return null
}

/**
 * Read one Session's stored events through the persistence seam.
 * @param persistence - the `sessionPersistence` service.
 * @param sessionId - validated Session id.
 * @returns the event list, plus a warning when the log could not be read.
 */
async function readEvents(persistence, sessionId) {
  let handle
  try {
    handle = await persistence.open(sessionId, 'read')
    const result = await handle.read()
    const events = Array.isArray(result?.events) ? result.events : []
    return { events, warning: undefined }
  } catch (error) {
    return { events: [], warning: `读取会话日志失败：${describe(error)}` }
  } finally {
    try {
      await handle?.close?.()
    } catch {
      // A close failure never changes the plan.
    }
  }
}

/**
 * Every attachment id any nested value in one event names.
 * @param value - event payload to walk.
 * @param into - accumulator.
 */
function collectAttachmentIds(value, into) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentIds(item, into)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'attachmentId' && typeof child === 'string' && child !== '') into.add(child)
    else collectAttachmentIds(child, into)
  }
}

/**
 * Files this Session's own writing tools targeted.
 * @param events - stored Session events.
 * @param cwd - the Session's recorded working directory, if any.
 * @returns one row per candidate, with the recorded operation count.
 */
function collectWrittenPaths(events, cwd) {
  const rows = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const data = event.data ?? {}
    const keys = WRITE_TOOL_PATHS[data.name]
    if (keys === undefined) continue
    let args
    try {
      args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
    } catch {
      continue
    }
    if (args === null || typeof args !== 'object') continue
    const raw = keys.map(key => args[key]).find(value => typeof value === 'string' && value.trim() !== '')
    if (raw === undefined) continue
    const absolute = isAbsolute(raw) ? raw : cwd === undefined ? undefined : resolve(cwd, raw)
    if (absolute === undefined) continue
    const existing = rows.get(absolute)
    if (existing === undefined) rows.set(absolute, { path: absolute, ops: 1 })
    else existing.ops += 1
  }
  return [...rows.values()]
}

/**
 * Resolve which of the written paths may actually be deleted.
 * @param rows - candidates from {@link collectWrittenPaths}.
 * @param cwd - the Session's recorded working directory.
 * @param home - resolved DSH home.
 * @returns `allowed` rows with sizes, and `refused` rows with a reason.
 */
async function classifyArtifacts(rows, cwd, home) {
  const allowed = []
  const refused = []
  let realCwd
  if (cwd === undefined) {
    for (const row of rows) refused.push({ path: row.path, reason: '会话未记录工作目录，无法安全定位' })
    return { allowed, refused }
  }
  try {
    realCwd = await realpath(cwd)
  } catch {
    for (const row of rows) refused.push({ path: row.path, reason: '会话工作目录已不存在，无法校验归属' })
    return { allowed, refused }
  }
  let realHome = home
  try {
    realHome = await realpath(home)
  } catch {
    // An absent home cannot contain anything that exists.
  }
  for (const row of rows) {
    let info
    try {
      info = await fsStat(row.path)
    } catch {
      refused.push({ path: row.path, reason: '文件已不存在' })
      continue
    }
    if (!info.isFile()) {
      refused.push({ path: row.path, reason: '不是普通文件，已跳过' })
      continue
    }
    let real
    try {
      real = await realpath(row.path)
    } catch {
      refused.push({ path: row.path, reason: '无法解析真实路径，已跳过' })
      continue
    }
    if (!inside(realCwd, real)) {
      refused.push({ path: row.path, reason: '不在该对话的工作目录内，已跳过' })
      continue
    }
    if (inside(realHome, real)) {
      refused.push({ path: row.path, reason: '位于 DSH 数据目录内，已跳过' })
      continue
    }
    allowed.push({ path: real, displayPath: row.path, bytes: info.size, ops: row.ops })
  }
  return { allowed, refused }
}

/**
 * Locate this Session's storage directories under the sessions root.
 *
 * The backend escapes a Session id into one safe path segment and nests it under
 * a readable project directory; the id itself is already a safe segment for
 * every id DSH produces, so the search is an exact directory-name match across
 * every project directory. Nothing is joined from an unvalidated value.
 *
 * @param home - resolved DSH home.
 * @param sessionId - validated Session id.
 * @returns absolute session directories, plus any legacy one-file generation.
 */
async function findSessionDirectories(home, sessionId) {
  const root = join(home, 'sessions')
  const found = []
  if (!existsSync(root)) return found
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, sessionId)
    if (!existsSync(candidate)) continue
    try {
      if (!(await fsStat(candidate)).isDirectory()) continue
    } catch {
      continue
    }
    found.push(candidate)
  }
  return found
}

/**
 * Attachment object paths implied by one attachment id.
 *
 * `@deepseek-ai/attachment-local` stores images at
 * `<home>/attachments/v1/objects/<sha256-prefix>/<sha256>`, generic file bytes at
 * `file-objects/...`, and one read-only hard-link directory per stored file name
 * at `files/<sha256-prefix>/<sha256>/`. An id this plugin does not recognize
 * resolves to nothing, and therefore deletes nothing.
 *
 * @param home - resolved DSH home.
 * @param attachmentId - id as stored in the Session log.
 * @returns candidate paths, most specific first.
 */
function attachmentPaths(home, attachmentId) {
  const raw = typeof attachmentId === 'string' ? attachmentId : ''
  const hash = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
  if (!/^[0-9a-fA-F]{16,128}$/.test(hash)) return []
  const digest = hash.toLowerCase()
  const prefix = digest.slice(0, 2)
  const base = join(home, 'attachments', 'v1')
  return [
    { path: join(base, 'objects', prefix, digest), kind: 'image-object' },
    { path: join(base, 'file-objects', prefix, digest), kind: 'file-object' },
    { path: join(base, 'files', prefix, digest), kind: 'file-reference' },
  ]
}

/**
 * Attachment ids some other stored Session references.
 *
 * Conservative by construction: every other Session is read, and a read failure
 * marks every still-unresolved id as shared. The cost is bounded by the number
 * of stored Sessions and is paid only for the two modes that touch attachments.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param sessionId - the Session being deleted.
 * @param ids - candidate attachment ids from that Session.
 * @returns the ids at least one other Session references.
 */
async function idsReferencedElsewhere(persistence, sessionId, ids) {
  const shared = new Set()
  const pending = new Set(ids)
  if (pending.size === 0) return shared
  if (typeof persistence.list !== 'function') return new Set(ids)
  let snapshots
  try {
    snapshots = await persistence.list()
  } catch {
    return new Set(ids)
  }
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (pending.size === 0) break
    const header = headerOf(snapshot)
    const other = header?.id ?? snapshot?.id
    if (typeof other !== 'string' || other === sessionId) continue
    const { events, warning } = await readEvents(persistence, other)
    if (warning !== undefined) {
      for (const id of pending) shared.add(id)
      pending.clear()
      break
    }
    const found = new Set()
    collectAttachmentIds(events, found)
    for (const id of [...pending]) {
      if (found.has(id)) {
        shared.add(id)
        pending.delete(id)
      }
    }
  }
  // An id that survives every successful read of every other stored Session is
  // unreferenced and therefore deletable; the failure branch above is the only
  // path that marks an id shared without evidence.
  return shared
}

/**
 * Build the complete deletion plan for one Session.
 * @param ctx - Host plugin context.
 * @param sessionId - validated Session id.
 * @returns the plan the browser renders and the purge route re-derives.
 */
async function buildPlan(ctx, sessionId) {
  const home = await resolveHome()
  const persistence = ctx.sessionPersistence
  const warnings = []

  let snapshot = null
  try {
    snapshot = await persistence.stat(sessionId)
  } catch (error) {
    warnings.push(`未找到该会话的存储记录：${describe(error)}`)
  }
  const header = headerOf(snapshot)
  const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined

  const { events, warning } = await readEvents(persistence, sessionId)
  if (warning !== undefined) warnings.push(warning)

  const directories = await findSessionDirectories(home, sessionId)
  if (directories.length === 0) warnings.push('未在会话目录中找到该对话的文件（可能已被删除）。')
  const storeBytes = (await Promise.all(directories.map(directoryBytes))).reduce((a, b) => a + b, 0)

  const written = collectWrittenPaths(events, cwd)
  const { allowed, refused } = await classifyArtifacts(written, cwd, home)

  const attachmentIds = new Set()
  collectAttachmentIds(events, attachmentIds)

  return {
    home,
    sessionId,
    cwd,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
    live: isLive(ctx, sessionId),
    store: { directories, bytes: storeBytes },
    artifacts: {
      allowed: allowed.slice(0, MAX_REPORTED_ROWS),
      refused: refused.slice(0, MAX_REPORTED_ROWS),
      totalBytes: allowed.reduce((sum, row) => sum + row.bytes, 0),
      truncated: allowed.length > MAX_REPORTED_ROWS || refused.length > MAX_REPORTED_ROWS,
    },
    attachments: { ids: [...attachmentIds].slice(0, MAX_REPORTED_ROWS) },
    warnings,
  }
}

/** Whether the Session is currently live in this process. */
function isLive(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return false
    return sessions.get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * Execute one plan.
 * @param ctx - Host plugin context.
 * @param sessionId - validated Session id.
 * @param mode - one of {@link MODES}.
 * @returns a per-step report; every failure is reported rather than thrown.
 */
async function purge(ctx, sessionId, mode) {
  const plan = await buildPlan(ctx, sessionId)
  const errors = []
  const removed = {
    directories: [],
    directoryBytes: 0,
    artifacts: [],
    artifactBytes: 0,
    attachments: [],
    archived: false,
    detached: [],
  }

  // A live Session is stopped and archived first: the archive write is durable
  // before the stop requests go out, so nothing wakes the Session again while
  // its files are being removed, and the sidebar already hides it.
  if (plan.live) {
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined && typeof registry.archiveSession === 'function') {
        await registry.archiveSession(sessionId, { stopActivity: true })
        removed.archived = true
      }
    } catch (error) {
      errors.push({ step: 'archive', path: null, message: describe(error) })
    }
  }

  // Detach the Session from its Workspace accounting so no stale grouping row
  // survives the reload.
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.list === 'function') {
      for (const workspace of registry.list()) {
        const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
        if (!ids.includes(sessionId)) continue
        await workspace.detachSession(sessionId)
        removed.detached.push(workspace.id ?? workspace.path ?? 'workspace')
      }
    }
  } catch (error) {
    errors.push({ step: 'detach', path: null, message: describe(error) })
  }

  // The durable record itself.
  for (const directory of plan.store.directories) {
    try {
      const bytes = await directoryBytes(directory)
      await rm(directory, { recursive: true, force: true })
      removed.directories.push(directory)
      removed.directoryBytes += bytes
    } catch (error) {
      errors.push({ step: 'record', path: directory, message: describe(error) })
    }
  }

  // Files the Session wrote inside its own working directory.
  if (mode === 'artifacts' || mode === 'everything') {
    for (const row of plan.artifacts.allowed) {
      try {
        await rm(row.path, { force: true })
        removed.artifacts.push(row.displayPath)
        removed.artifactBytes += row.bytes
      } catch (error) {
        errors.push({ step: 'artifact', path: row.displayPath, message: describe(error) })
      }
    }
  }

  // Attachment objects no other stored Session references.
  let attachmentReport = null
  if (mode === 'everything') {
    const ids = plan.attachments.ids
    const shared = await idsReferencedElsewhere(ctx.sessionPersistence, sessionId, ids)
    const deletable = ids.filter(id => !shared.has(id))
    const skipped = []
    for (const id of deletable) {
      const candidates = attachmentPaths(plan.home, id)
      let deleted = false
      for (const candidate of candidates) {
        if (!existsSync(candidate.path)) continue
        try {
          await rm(candidate.path, { recursive: true, force: true })
          removed.attachments.push(candidate.path)
          deleted = true
        } catch (error) {
          errors.push({ step: 'attachment', path: candidate.path, message: describe(error) })
        }
      }
      if (!deleted) skipped.push(id)
    }
    attachmentReport = { referenced: ids.length, shared: shared.size, deleted: removed.attachments.length, notFound: skipped.length }
  }

  // Best-effort removal notice. The archived set and the deleted log are the
  // durable truth; this only lets an open page drop the row without a reload.
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch {
    // Not every composition relays this event to the browser; the caller also
    // offers a reload.
  }

  return {
    plan: {
      sessionId,
      cwd: plan.cwd,
      live: plan.live,
      storeBytes: plan.store.bytes,
      artifactCount: plan.artifacts.allowed.length,
      artifactBytes: plan.artifacts.totalBytes,
      attachmentCount: plan.attachments.ids.length,
      warnings: plan.warnings,
    },
    removed,
    attachments: attachmentReport,
    errors,
  }
}

/**
 * Mount the three routes.
 * @param ctx - Host plugin context, with `webServer` and `sessionPersistence`.
 */
export function apply(ctx) {
  const server = ctx.webServer

  /** Route bodies share one shape: validate, run, answer, never throw out. */
  const wrap = (handler) => (req, res) => {
    void (async () => {
      try {
        await handler(req, res)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: describe(error) })
        else res.end()
      }
    })()
  }

  /** Parse and validate one request body's Session id. */
  const sessionIdOf = (body) => {
    const sessionId = body?.sessionId
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
      throw new Error('会话 id 不合法')
    }
    return sessionId
  }

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/health`,
    handler: wrap((req, res) => {
      sendJson(res, 200, { ok: true, plugin: name, version: '0.1.0' })
    }),
  }), 'dsh-session-purge: health route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/scan`,
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      requireOwnPage(req)
      const body = await readJsonBody(req)
      const sessionId = sessionIdOf(body)
      const plan = await buildPlan(ctx, sessionId)
      sendJson(res, 200, {
        ok: true,
        sessionId,
        cwd: plan.cwd,
        createdAt: plan.createdAt,
        live: plan.live,
        store: {
          directories: plan.store.directories,
          bytes: plan.store.bytes,
        },
        artifacts: plan.artifacts,
        attachments: { ids: plan.attachments.ids },
        warnings: plan.warnings,
      })
    }),
  }), 'dsh-session-purge: scan route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/purge`,
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      requireOwnPage(req)
      const body = await readJsonBody(req)
      const sessionId = sessionIdOf(body)
      const mode = body?.mode
      if (typeof mode !== 'string' || !MODES.includes(mode)) {
        throw new Error('删除模式不合法')
      }
      if (body?.confirm !== true) throw new Error('缺少删除确认')

      // A Session with no stored record and no on-disk directory is already
      // gone; deleting twice is a no-op rather than an error.
      const result = await purge(ctx, sessionId, mode)
      ctx.logger?.info?.(
        `dsh-session-purge: deleted session ${sessionId} (mode=${mode}, dirs=${result.removed.directories.length}, `
        + `files=${result.removed.artifacts.length}, errors=${result.errors.length})`,
      )
      sendJson(res, 200, { ok: true, sessionId, mode, ...result })
    }),
  }), 'dsh-session-purge: purge route')
}

// Re-exported for the offline verification suite, which drives the plan and the
// purge against a stub Host context and a scratch sessions root.
export const internals = {
  attachmentPaths,
  buildPlan,
  classifyArtifacts,
  collectAttachmentIds,
  collectWrittenPaths,
  findSessionDirectories,
  headerOf,
  purge,
  requireOwnPage,
  resolveHome,
}
