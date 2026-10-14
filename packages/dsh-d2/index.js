/**
 * Host half of the `dsh-d2` bundle.
 *
 * A preview needs two Host capabilities, and this half is both: the bytes of the file the browser
 * is looking at, and the compiled SVG. The second one is why this plugin exists in the shape it
 * does — D2 renders through the `d2` CLI, which is the real implementation (same grammar, same
 * layout engines, same errors with line and column) rather than a re-implementation in a browser
 * bundle. The browser half therefore never parses D2 at all.
 *
 * Both routes resolve the workspace root here and ignore anything the caller claims: containment
 * checked against a caller-chosen root would prove nothing.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** Where the browser half reads one text file of a Session. */
const SOURCE_ROUTE = '/dsh-d2/source'
/** Where it asks for a source to be compiled. */
const RENDER_ROUTE = '/dsh-d2/render'
/** Where it reports what it managed to render, for Host-side diagnosis. */
const DIAG_ROUTE = '/dsh-d2/diag'
/** The largest file this preview reads back. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
/** The largest source this preview will compile. */
const MAX_RENDER_CHARS = 1024 * 1024
/** How long one compile may take, passed to the CLI's own timeout. */
const RENDER_TIMEOUT_SECONDS = 20
/** Per-process secret handed to the page through the index; the routes have no other gate. */
const NONCE = randomUUID()
/** The rendered global the page reads the nonce and routes from. */
const GLOBAL_NAME = '__DSH_D2__'
/** The CLI to run, overridable so a deployment can point at its own build. */
const BINARY = () => process.env.DSH_D2_BIN ?? 'd2'

/** The last report from the browser half: booleans and names only, never a path. */
let diag = { at: undefined, report: undefined }

/** sessionId -> live Session, so a Session's committed directory can be resolved host-side. */
const liveSessions = new Map()

/** The workspace root of one Session, resolved on the Host. */
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

/**
 * Compile one source with the `d2` CLI.
 *
 * The CLI writes the SVG to stdout (`-`) and, on success, still prints a progress line to stderr —
 * so the **exit code** decides, never the presence of stderr. A compile error comes back as the
 * CLI's own message, line and column included, which is exactly what the code view wants to show.
 *
 * @param source - the D2 source.
 * @returns `{ ok: true, svg }`, or `{ ok: false, error, message }` with `d2-missing` when the CLI
 *   is not installed at all — the one failure a user can act on.
 */
function compile(source) {
  return new Promise((resolve) => {
    const binary = BINARY()
    let child
    try {
      child = spawn(binary, [`--timeout=${RENDER_TIMEOUT_SECONDS}`, '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, error: 'd2-unavailable', message: error instanceof Error ? error.message : String(error) })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.on('error', (error) => {
      finish(
        error?.code === 'ENOENT'
          ? {
              ok: false,
              error: 'd2-missing',
              message: `未找到 d2 可执行文件（${binary}）。安装 D2 后即可预览，例如：brew install d2`,
            }
          : { ok: false, error: 'd2-unavailable', message: error instanceof Error ? error.message : String(error) },
      )
    })
    child.stdout.on('data', (chunk) => {
      out += chunk
      // A runaway render must not fill memory; the CLI's own timeout handles the rest.
      if (out.length > 8 * 1024 * 1024) child.kill()
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('close', (code) => {
      if (code === 0 && out.includes('<svg')) return finish({ ok: true, svg: out })
      const message = err.trim() === '' ? `d2 退出码 ${code}` : err.trim()
      finish({ ok: false, error: 'd2-failed', message: message.slice(0, 2000) })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(source)
  })
}

export function apply(ctx) {
  // A plugin must not be able to keep the app from booting: an exception in `apply` fails this
  // entry's activation, and the desktop shell treats a failed web boot as fatal.
  try {
    applyInner(ctx)
  } catch (error) {
    console.warn('[dsh-d2] the Host half could not be registered', error)
  }
}

function applyInner(ctx) {
  ctx.effect(
    () =>
      ctx.on('webserver/index-inject', (table) => {
        table.push({
          kind: 'global',
          name: GLOBAL_NAME,
          value: { nonce: NONCE, route: SOURCE_ROUTE, renderRoute: RENDER_ROUTE, diagRoute: DIAG_ROUTE },
        })
      }),
    'dsh-d2: index nonce',
  )

  ctx.effect(
    () =>
      ctx.on('session/event', (session) => {
        liveSessions.set(session.id, session)
      }),
    'dsh-d2: session cache',
  )
  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        liveSessions.delete(session.id)
      }),
    'dsh-d2: session cache',
  )

  ctx.inject(['webServer'], (webCtx) => {
    const send = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: SOURCE_ROUTE,
          handler: async (req, res) => {
            if (req.headers['x-dsh-d2'] !== NONCE) return send(res, 403, { ok: false, error: 'forbidden' })
            if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'GET' })
            const url = new URL(req.url ?? SOURCE_ROUTE, 'http://localhost')
            const sessionId = url.searchParams.get('sessionId')
            const path = url.searchParams.get('path')
            if (sessionId === null || path === null || sessionId === '' || path === '') {
              return send(res, 400, { ok: false, error: 'sessionId and path are required' })
            }
            // The platform's own reader first: it resolves the workspace for any Session.
            // A platform-read failure is not the end: the fallback below can still read a file
            // whose Session workspace is known, and it reports the platform's reason if it cannot.
            const scope = await workspaceScopeOf(ctx, sessionId)
            const direct = scope === undefined ? undefined : await readThroughPlatform(ctx, scope, path)
            if (direct?.text !== undefined) return send(res, 200, { ok: true, text: direct.text, path: direct.path })
            const platformError = direct?.error

            const cwd = scope?.workspaceRoot
            if (cwd === undefined) {
              // No workspace to fall back to, and the platform reader already said why.
              return send(res, platformError === undefined ? 409 : 500, {
                ok: false,
                error:
                  platformError === undefined
                    ? 'this Session has no workspace directory yet'
                    : `平台读取失败：${platformError}`,
              })
            }
            const fsService = ctx.get('fs')
            if (fsService === undefined || typeof fsService.readText !== 'function') {
              return send(res, 503, { ok: false, error: 'this deployment has no filesystem service' })
            }
            try {
              const target = await fsService.resolve(path, { cwd })
              const info = await fsService.stat(target)
              if (info === undefined) return send(res, 404, { ok: false, error: '文件不存在或已被移动（可能被删除、重命名或移出了会话工作区）' })
              if (info.type !== 'file') return send(res, 404, { ok: false, error: 'this path is not a regular file' })
              if ((info.size ?? 0) > MAX_SOURCE_BYTES) return send(res, 413, { ok: false, error: 'file is too large to preview' })
              return send(res, 200, {
                ok: true,
                text: await fsService.readText(target),
                path: typeof target?.displayPath === 'string' ? target.displayPath : undefined,
              })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
            return send(res, 500, {
              ok: false,
              error: platformError === undefined ? message : `${message}（平台读取也失败：${platformError}）`,
            })
            }
          },
        }),
      'dsh-d2: source route',
    )

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: RENDER_ROUTE,
          handler: async (req, res) => {
            if (req.headers['x-dsh-d2'] !== NONCE) return send(res, 403, { ok: false, error: 'forbidden' })
            if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
            try {
              const input = JSON.parse(await readBody(req))
              const source = typeof input.source === 'string' ? input.source : ''
              if (source.trim() === '') return send(res, 400, { ok: false, error: 'empty', message: 'D2 源码为空' })
              if (source.length > MAX_RENDER_CHARS) {
                return send(res, 413, { ok: false, error: 'too-large', message: '文件太大，无法编译' })
              }
              return send(res, 200, await compile(source))
            } catch (error) {
              return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      'dsh-d2: render route',
    )

    // A preview has no other way to tell the Host what it managed to render — the page's console
    // is not reachable from here — so it reports booleans and type names through this route.
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: DIAG_ROUTE,
          handler: async (req, res) => {
            if (req.method === 'GET') return send(res, 200, { ok: true, ...diag })
            if (req.headers['x-dsh-d2'] !== NONCE) return send(res, 403, { ok: false, error: 'forbidden' })
            if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'GET or POST' })
            try {
              diag = { at: new Date().toISOString(), report: JSON.parse(await readBody(req)) }
              return send(res, 200, { ok: true })
            } catch (error) {
              return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      'dsh-d2: diagnostic route',
    )
  })

  ctx.effect(
    () => () => {
      liveSessions.clear()
    },
    'dsh-d2: own teardown',
  )
}
