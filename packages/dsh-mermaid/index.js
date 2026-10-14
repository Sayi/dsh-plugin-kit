/**
 * Host half of the `dsh-mermaid` bundle.
 *
 * A preview plugin needs exactly one Host capability: the bytes of a file the browser is
 * looking at. It serves them through its own route rather than injecting the client's
 * `remote.workspaceFiles` service, because an optional preview must not become a *hard*
 * dependency of an entry's activation — an unsatisfied one keeps the entry inactive, and the
 * desktop shell treats a failed web boot as fatal.
 *
 * The route resolves the workspace root itself and ignores anything the caller claims:
 * containment checked against a root the caller chose would prove nothing.
 */

import { randomUUID } from 'node:crypto'

/** Where the browser half reads one text file of a Session. */
const SOURCE_ROUTE = '/dsh-mermaid/source'
/** Where the browser half reports what it managed to do, for Host-side diagnosis. */
const DIAG_ROUTE = '/dsh-mermaid/diag'
/** The largest file the preview reads back; a diagram is never this big. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
/** Per-process secret handed to the page through the index; this route has no other gate. */
const NONCE = randomUUID()
/** The rendered global the page reads the nonce and route from. */
const GLOBAL_NAME = '__DSH_MERMAID__'

/** The last report from the browser half: booleans and names only, never a path. */
let diag = { at: undefined, report: undefined }

/** sessionId -> live Session, so a Session's committed directory can be resolved host-side. */
const liveSessions = new Map()

/**
 * The workspace root of one Session, resolved on the Host.
 *
 * The browser half knows the Session id and the file's path — a `dsh-resource://file/...`
 * address carries nothing else — so the root must come from here.
 */
/**
 * The Session's header, from the live cache or the controller. `undefined` means the Session is
 * unknown to this Host — which is a different answer from "it has no directory yet".
 */
async function sessionHeaderOf(ctx, sessionId) {
  // The attached Session first — the same source the platform's own scope resolver reads — then
  // the events this half has seen, then persistence for a Session that is not attached here.
  const attached = (() => {
    try {
      const sessions = ctx.get('sessions')
      return typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    } catch {
      return undefined
    }
  })()
  const header = attached?.header ?? liveSessions.get(sessionId)?.header
  if (header !== undefined) return header
  try {
    const persistence = ctx.get('sessionPersistence')
    const stored = typeof persistence?.stat === 'function' ? await persistence.stat(sessionId) : undefined
    return stored?.header
  } catch {
    return undefined
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The scope the platform's reader expects for one Session.
 *
 * It is an object — `{ sessionId, workspaceRoot }` — not a Session id: passed a string, the
 * service reads `scope.workspaceRoot` as undefined and fails deep inside the filesystem backend
 * ("Cannot read properties of undefined (reading 'trim')"). The root is the Session's own
 * directory when it has one, and otherwise the sandbox policy's workspace root — the same
 * fallback the platform's own scope resolver applies, and what makes a plain Session work.
 */
async function workspaceScopeOf(ctx, sessionId) {
  const header = await sessionHeaderOf(ctx, sessionId)
  // An unknown Session gets no scope at all — the platform's resolver returns undefined for one
  // too. Only a Session that exists *without* a directory of its own falls back to the policy.
  if (header === undefined) return undefined
  const policy = (() => {
    try {
      return ctx.get('sandboxPolicy')
    } catch {
      return undefined
    }
  })()
  const workspaceRoot = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : policy?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return undefined
  return { sessionId, workspaceRoot }
}

/**
 * Read one file's text, the platform's way.
 *
 * `workspaceFiles` resolves a Session's workspace itself, which is what makes this work in **any**
 * Session: a plain Session's header carries no `cwd`, and resolving the root by hand answered
 * "this Session has no workspace directory yet" there. The workspace-relative fallback below is
 * kept for a deployment without the service.
 *
 * @returns `{ text, path }`, `{ error }`, or undefined when the service cannot help.
 */
async function readThroughPlatform(ctx, scope, path, signal) {
  let files
  try {
    files = ctx.get('workspaceFiles')
  } catch {
    files = undefined
  }
  if (files === undefined || typeof files.read !== 'function') return undefined
  try {
    // An empty range, not undefined: the service reads `range.offset` for its defaults.
    const result = await files.read(scope, path, {}, signal)
    const value = result?.ok === true ? result.value : result
    const text = typeof value?.text === 'string' ? value.text : undefined
    if (text === undefined) return undefined
    const absolute = typeof value?.path === 'string' ? value.path : value?.absolutePath
    return { text, path: typeof absolute === 'string' && absolute !== '' ? absolute : undefined }
  } catch (error) {
    // Not fatal: the caller still has the workspace-relative fallback, and the platform's own
    // message is worth keeping in case both fail — it names the reason, which a guess cannot.
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function sourceRouteHandler(ctx, req, res) {
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  if (req.headers['x-dsh-mermaid'] !== NONCE) return send(403, { ok: false, error: 'forbidden' })
  if (req.method !== 'GET') return send(405, { ok: false, error: 'GET' })

  const url = new URL(req.url ?? SOURCE_ROUTE, 'http://localhost')
  const sessionId = url.searchParams.get('sessionId')
  const path = url.searchParams.get('path')
  if (sessionId === null || path === null || sessionId === '' || path === '') {
    return send(400, { ok: false, error: 'sessionId and path are required' })
  }
  // The platform's own reader first: it resolves the workspace for any Session.
  // A platform-read failure is not the end: the fallback below can still read a file whose
  // Session workspace is known, and it reports the platform's reason if it cannot.
  const scope = await workspaceScopeOf(ctx, sessionId)
  const direct = scope === undefined ? undefined : await readThroughPlatform(ctx, scope, path)
  if (direct?.text !== undefined) return send(200, { ok: true, text: direct.text, path: direct.path })
  const platformError = direct?.error

  const cwd = scope?.workspaceRoot
  if (cwd === undefined) {
    // No workspace to fall back to, and the platform reader already said why.
    return send(platformError === undefined ? 409 : 500, {
      ok: false,
      error:
        platformError === undefined ? 'this Session has no workspace directory yet' : `平台读取失败：${platformError}`,
    })
  }
  const fsService = ctx.get('fs')
  if (fsService === undefined || typeof fsService.readText !== 'function') {
    return send(503, { ok: false, error: 'this deployment has no filesystem service' })
  }
  try {
    const root = await fsService.resolve(cwd, {})
    const target = await fsService.resolve(path, { cwd })
    if (typeof fsService.contains === 'function' && !fsService.contains(root, target)) {
      return send(403, { ok: false, error: 'outside the Session workspace' })
    }
    const info = await fsService.stat(target)
    if (info === undefined) return send(404, { ok: false, error: '文件不存在或已被移动（可能被删除、重命名或移出了会话工作区）' })
  if (info.type !== 'file') return send(404, { ok: false, error: 'this path is not a regular file' })
    if ((info.size ?? 0) > MAX_SOURCE_BYTES) return send(413, { ok: false, error: 'file is too large to preview' })
    return send(200, {
      ok: true,
      text: await fsService.readText(target),
      // The absolute path this Host resolved. The preview needs it for the shared header
      // actions, and resolving it here means it does not depend on the pane's own metadata.
      path: typeof target?.displayPath === 'string' ? target.displayPath : undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return send(500, {
      ok: false,
      error: platformError === undefined ? message : `${message}（平台读取也失败：${platformError}）`,
    })
  }
}

/** Register everything, under a guard: a preview must never be able to stop the boot. */
function applyInner(ctx) {
  ctx.effect(
    () =>
      ctx.on('webserver/index-inject', (table) => {
        table.push({
          kind: 'global',
          name: GLOBAL_NAME,
          value: { nonce: NONCE, route: SOURCE_ROUTE, diagRoute: DIAG_ROUTE },
        })
      }),
    'dsh-mermaid: index nonce',
  )

  ctx.effect(
    () =>
      ctx.on('session/event', (session) => {
        liveSessions.set(session.id, session)
      }),
    'dsh-mermaid: session cache',
  )
  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        liveSessions.delete(session.id)
      }),
    'dsh-mermaid: session cache',
  )

  // A preview has no other way to tell the Host what it managed to render — the page's console
  // is not reachable from here — so it reports through this route: booleans and type names only,
  // never a path or a binding. The POST needs the nonce; the GET is open on purpose and carries
  // exactly what the browser half chose to say.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: DIAG_ROUTE,
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(payload))
            }
            if (req.method === 'GET') return send(200, { ok: true, ...diag })
            if (req.headers['x-dsh-mermaid'] !== NONCE) return send(403, { ok: false, error: 'forbidden' })
            if (req.method !== 'POST') return send(405, { ok: false, error: 'GET or POST' })
            try {
              const report = JSON.parse(await readBody(req))
              diag = { at: new Date().toISOString(), report }
              return send(200, { ok: true })
            } catch (error) {
              return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      'dsh-mermaid: diagnostic route',
    )
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: SOURCE_ROUTE,
          handler: (req, res) => sourceRouteHandler(ctx, req, res),
        }),
      'dsh-mermaid: source route',
    )
  })

  ctx.effect(
    () => () => {
      liveSessions.clear()
    },
    'dsh-mermaid: own teardown',
  )
}

export function apply(ctx) {
  // A plugin must not be able to keep the app from booting: an exception here fails this
  // entry's activation, and the desktop shell treats a failed web boot as fatal. Everything
  // below registers capabilities, so a failure is reported and the plugin stays inert.
  try {
    applyInner(ctx)
  } catch (error) {
    console.warn('[dsh-mermaid] the Host half could not be registered', error)
  }
}
