/**
 * Offline verification for dsh-session-purge's Host half.
 *
 * Runs with no DSH process, no ports and no prompts: a scratch DSH home and a
 * stub `sessionPersistence` stand in for the deployment, and a stub `webServer`
 * records the routes and drives their handlers directly. The assertions cover
 * the two things that must never be wrong here — what the plan selects, and what
 * the purge actually removes.
 *
 *   node verify/verify-host.mjs
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, internals } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = join(here, '..', '.scratch', 'verify-host')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Read a JSON response captured by the stub response object. */
async function callRoute(handler, { method = 'POST', body, headers, dropMarker = false } = {}) {
  const effective = headers ?? {
    'x-dsh-session-purge': '1',
    host: '127.0.0.1:19387',
    origin: 'http://127.0.0.1:19387',
  }
  if (dropMarker) delete effective['x-dsh-session-purge']
  const request = {
    method,
    headers: effective,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  let status = 0
  let payload = null
  let settle
  const finished = new Promise((resolve) => { settle = resolve })
  const response = {
    headersSent: false,
    writeHead(value) {
      status = value
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) payload = JSON.parse(Buffer.from(chunk).toString('utf8'))
      settle()
    },
  }
  // Handlers answer from an async wrapper, so the response, not the handler
  // call, is what settles the request.
  void handler(request, response)
  await finished
  return { status, payload }
}

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER_ID = 'session-99999999-8888-7777-6666-555555555555'
const ATTACHMENT_HEX = 'ab'.repeat(32)

async function main() {
  await rm(scratch, { recursive: true, force: true })

  const home = join(scratch, 'home')
  const workspace = join(scratch, 'workspace')
  const outside = join(scratch, 'outside')
  const sessionDir = join(home, 'sessions', '--C-scratch-workspace--', SESSION_ID)
  const attachmentObject = join(home, 'attachments', 'v1', 'objects', 'ab', ATTACHMENT_HEX)

  await mkdir(sessionDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(dirname(attachmentObject), { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'not really zstd', 'utf8')
  await writeFile(join(workspace, 'a.txt'), 'written absolutely', 'utf8')
  await writeFile(join(workspace, 'b.txt'), 'written relatively', 'utf8')
  await writeFile(join(workspace, 'untouched.txt'), 'never written by the session', 'utf8')
  await writeFile(join(outside, 'outside.txt'), 'outside the working directory', 'utf8')
  await writeFile(attachmentObject, 'attachment bytes', 'utf8')

  process.env.DSH_HOME = home

  const events = [
    { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: join(workspace, 'a.txt'), content: 'x' }) } },
    { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: 'b.txt', old_string: 'a', new_string: 'b' }) } },
    { type: 'tool/call', seq: 3, data: { turn: 1, step: 2, callId: 'c3', name: 'write', arguments: JSON.stringify({ file_path: join(outside, 'outside.txt'), content: 'x' }) } },
    { type: 'tool/call', seq: 4, data: { turn: 1, step: 2, callId: 'c4', name: 'write', arguments: '{"file_path":' } },
    { type: 'tool/call', seq: 5, data: { turn: 1, step: 3, callId: 'c5', name: 'read', arguments: JSON.stringify({ path: join(workspace, 'untouched.txt') }) } },
    { type: 'tool/result', seq: 6, data: { turn: 1, step: 3, callId: 'c5', message: { role: 'tool', content: [] } } },
    { type: 'user/message', seq: 7, data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${ATTACHMENT_HEX}` } }], role: 'user' } },
  ]

  const persistence = {
    async stat(id) {
      if (id !== SESSION_ID) throw new Error('not found')
      return { header: { version: 4, id, createdAt: 1234, cwd: workspace, isSeeded: false }, revision: 'rev', eventCount: events.length, sizeBytes: 16 }
    },
    async open(id) {
      return {
        async read() {
          return { eventState: 'detached', events: id === SESSION_ID ? events : [] }
        },
        async close() {},
      }
    },
    async list() {
      return [{ header: { id: SESSION_ID, version: 4, cwd: workspace } }, { header: { id: OTHER_ID, version: 4, cwd: workspace } }]
    },
  }

  let detached = []
  let archived = false
  const registry = {
    list: () => [{
      id: 'workspace-1',
      path: workspace,
      sessionIds: [SESSION_ID],
      detachSession: async (id) => { detached.push(id) },
    }],
    archiveSession: async () => { archived = true },
  }

  const routes = []
  const ctx = {
    sessionPersistence: persistence,
    logger: { info() {}, warn() {}, error() {} },
    emit() { ctx.emitted.push(arguments) },
    emitted: [],
    get(name) {
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
    effect(callback) {
      callback()
      return () => {}
    },
  }
  ctx.webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }

  console.log('# pure helpers')
  equal('attachmentPaths resolves the image object', internals.attachmentPaths(home, `sha256:${ATTACHMENT_HEX}`)[0].path, attachmentObject)
  equal('attachmentPaths rejects an unrecognized id', internals.attachmentPaths(home, 'not-a-digest').length, 0)
  equal('headerOf unwraps a nested header', internals.headerOf({ header: { id: 'x', version: 4 } })?.id, 'x')
  equal('collectWrittenPaths counts repeated writes once', internals.collectWrittenPaths(events, workspace).length, 3)
  equal('collectWrittenPaths ignores non-writing tools', internals.collectWrittenPaths(events, workspace).some(row => row.path.endsWith('untouched.txt')), false)

  console.log('# routes')
  apply(ctx)
  equal('three routes registered', routes.length, 3)
  equal('routes are exact', routes.every(route => route.kind === 'exact'), true)
  const health = routes.find(route => route.path.endsWith('/health'))
  const scan = routes.find(route => route.path.endsWith('/scan'))
  const purgeRoute = routes.find(route => route.path.endsWith('/purge'))
  check('health route exists', health !== undefined)
  check('scan route exists', scan !== undefined)
  check('purge route exists', purgeRoute !== undefined)

  const healthAnswer = await callRoute(health.handler, { method: 'GET' })
  equal('health answers 200', healthAnswer.status, 200)

  const rejected = await callRoute(scan.handler, { body: { sessionId: '../../etc' } })
  equal('a traversal-shaped id is refused', rejected.payload?.ok, false)

  const plan = await callRoute(scan.handler, { body: { sessionId: SESSION_ID } })
  equal('scan answers ok', plan.payload?.ok, true)
  equal('scan finds the storage directory', plan.payload.store.directories.length, 1)
  equal('scan allows the two joined files', plan.payload.artifacts.allowed.length, 2)
  equal('scan refuses the outside file', plan.payload.artifacts.refused.some(row => row.path.endsWith('outside.txt')), true)
  equal('scan refuses the unparsable call silently (no candidate)', plan.payload.artifacts.refused.some(row => row.path.includes('undefined')), false)
  equal('scan reports the attachment', plan.payload.attachments.ids.length, 1)
  equal('scan is not live', plan.payload.live, false)

  console.log('# purge: record only')
  const recordOnly = await callRoute(purgeRoute.handler, { body: { sessionId: SESSION_ID, mode: 'record', confirm: true } })
  equal('purge answers ok', recordOnly.payload?.ok, true)
  equal('storage directory removed', existsSync(sessionDir), false)
  equal('produced file kept in record mode', existsSync(join(workspace, 'a.txt')), true)
  equal('attachment kept in record mode', existsSync(attachmentObject), true)
  equal('workspace detached', detached.includes(SESSION_ID), true)
  equal('a live session was not archived', archived, false)

  console.log('# purge: artifacts')
  const artifactsOnly = await callRoute(purgeRoute.handler, { body: { sessionId: SESSION_ID, mode: 'artifacts', confirm: true } })
  equal('purge answers ok', artifactsOnly.payload?.ok, true)
  equal('absolute written file removed', existsSync(join(workspace, 'a.txt')), false)
  equal('relative written file removed', existsSync(join(workspace, 'b.txt')), false)
  equal('untouched file kept', existsSync(join(workspace, 'untouched.txt')), true)
  equal('outside file kept', existsSync(join(outside, 'outside.txt')), true)
  equal('attachment kept in artifacts mode', existsSync(attachmentObject), true)
  equal('the working directory itself survives', existsSync(workspace), true)

  console.log('# purge: everything')
  const everything = await callRoute(purgeRoute.handler, { body: { sessionId: SESSION_ID, mode: 'everything', confirm: true } })
  equal('purge answers ok', everything.payload?.ok, true)
  equal('unreferenced attachment removed', existsSync(attachmentObject), false)

  console.log('# guards')
  const noConfirm = await callRoute(purgeRoute.handler, { body: { sessionId: SESSION_ID, mode: 'record' } })
  equal('a missing confirmation is refused', noConfirm.payload?.ok, false)
  const badMode = await callRoute(purgeRoute.handler, { body: { sessionId: SESSION_ID, mode: 'nuke', confirm: true } })
  equal('an unknown mode is refused', badMode.payload?.ok, false)
  const wrongMethod = await callRoute(purgeRoute.handler, { method: 'GET' })
  equal('a GET is refused', wrongMethod.status, 405)
  const noMarker = await callRoute(scan.handler, { body: { sessionId: SESSION_ID }, dropMarker: true })
  equal('a request without the page marker is refused', noMarker.payload?.ok, false)
  const foreignOrigin = await callRoute(scan.handler, {
    body: { sessionId: SESSION_ID },
    headers: { 'x-dsh-session-purge': '1', host: '127.0.0.1:19387', origin: 'http://evil.example' },
  })
  equal('a cross-origin request is refused', foreignOrigin.payload?.ok, false)

  console.log('# plugin files')
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  equal('the browser bundle is declared', manifest.exports['./client'], './lib/client.js')
  equal('the client platform is web', manifest.dsh.client.platform, 'web')
  equal('the bundle patch is declared', manifest.dsh.bundle.patch, './cordis.patch.yml')

  // The scratch root is this suite's own; removing it leaves the package tree
  // exactly as it shipped (a bare `rm(scratch)` would leave the empty parent).
  await rm(join(here, '..', '.scratch'), { recursive: true, force: true })

  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
  if (failures > 0) process.exitCode = 1
}

await main()
