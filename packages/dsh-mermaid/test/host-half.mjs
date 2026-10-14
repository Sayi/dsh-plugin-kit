/**
 * Host half of `dsh-mermaid`, run against a fake Cordis context: the one capability a preview
 * needs is the bytes of a file the browser is looking at, and this drives that route —
 * including the fence around it, which is the part that must not be got wrong.
 *
 *   node test/host-half.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { apply } = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname).href)

/** A fake Cordis context that records what the half registers and can emit events. */
function harness({ cwd, platformFails = false }) {
  const captured = { routes: new Map(), injects: [] }
  const listeners = new Map()
  const fsService = {
    resolve: async (target, opts) => {
      const absolute = path.resolve(opts?.cwd ?? cwd, target)
      return { targetKey: absolute, displayPath: absolute }
    },
    contains: (parent, child) =>
      child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + path.sep),
    stat: async (target) =>
      fs.existsSync(target.targetKey) && fs.statSync(target.targetKey).isFile()
        ? { type: 'file', size: fs.statSync(target.targetKey).size }
        : undefined,
    readText: async (target) => fs.readFileSync(target.targetKey, 'utf8'),
  }
  const ctx = {
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => {}
    },
    get: (name) =>
      name === 'fs'
        ? fsService
        : name === 'sandboxPolicy'
          ? { workspaceRoot: cwd }
          : name === 'sessions'
            ? {
                // Attached Sessions, exactly the registry the platform's scope resolver reads.
                get: (sessionId) =>
                  sessionId === 's1' ? { header: { cwd } } : sessionId === 's-plain' ? { header: {} } : undefined,
              }
            : name === 'workspaceFiles'
          ? {
              // The platform's reader resolves the workspace for any Session, which is the point:
              // a plain Session's header carries no cwd, and this is what the Host route leans on.
              read: async (scope, filePath, range) => {
                if (platformFails) throw new TypeError("Cannot read properties of undefined (reading 'offset')")
                // Two shapes the real service insists on, both of which this plugin got wrong once:
                // `range` is read for its defaults, and `workspaceRoot` comes off the scope
                // *object*, so a bare Session id fails deep in the filesystem backend.
                if (range === undefined) throw new TypeError("Cannot read properties of undefined (reading 'offset')")
                if (scope === null || typeof scope !== 'object' || typeof scope.workspaceRoot !== 'string') {
                  throw new TypeError("Cannot read properties of undefined (reading 'trim')")
                }
                if (scope.sessionId !== 's1' && scope.sessionId !== 's-plain') return { ok: false, error: 'no such session' }
                const absolute = path.resolve(scope.workspaceRoot, filePath)
                // The service the Host route leans on confides every read to the Session's
                // workspace (`confine` raises `workspace-file/outside-workspace`). A fake that
                // reads anything would be more permissive than the real thing and prove nothing.
                if (!absolute.startsWith(cwd + path.sep) && absolute !== cwd) {
                  return { ok: false, error: 'workspace-file/outside-workspace' }
                }
                return fs.existsSync(absolute)
                  ? { ok: true, value: { text: fs.readFileSync(absolute, 'utf8'), absolutePath: absolute } }
                  : { ok: false, error: 'not found' }
              },
            }
          : undefined,
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject: (deps, callback) => {
      const scoped = { ...ctx, webServer: { register: (route) => captured.routes.set(route.path, route.handler) } }
      void deps
      callback(scoped)
      return () => {}
    },
  }
  apply(ctx)
  const emit = async (event, payload) => {
    const handler = listeners.get(event)
    if (handler !== undefined) await handler(payload)
  }
  return { captured, emit }
}

/** Call one registered route the way the Web server would. */
function call(handler, { method = 'GET', url = '/dsh-mermaid/source', nonce, body } = {}) {
  return new Promise((resolve) => {
    const headers = nonce === undefined ? {} : { 'x-dsh-mermaid': nonce }
    const req = {
      method,
      url,
      headers,
      [Symbol.asyncIterator]: async function* () {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      status: undefined,
      payload: undefined,
      writeHead(status) {
        this.status = status
      },
      end(text) {
        this.payload = text === undefined ? undefined : JSON.parse(text)
        resolve({ status: this.status, body: this.payload })
      },
    }
    handler(req, res)
  })
}

const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

/** The nonce the Host injects into the page, read back from the index table. */
async function nonceOf(emit) {
  const table = []
  await emit('webserver/index-inject', table)
  const entry = table.find((row) => row.name === '__DSH_MERMAID__')
  return entry?.value?.nonce
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-test-'))
fs.writeFileSync(path.join(cwd, 'flow.mmd'), 'graph TD\n  A --> B\n')
const PLAIN_FILE = 'plain.d2'
fs.writeFileSync(path.join(cwd, PLAIN_FILE), 'PLAIN -> shape\n')
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-outside-'))
fs.writeFileSync(path.join(outside, 'elsewhere.mmd'), 'graph TD\n  X --> Y\n')

const { captured, emit } = harness({ cwd })
const nonce = await nonceOf(emit)
check('the Host publishes its route and nonce to the page', typeof nonce === 'string' && nonce.length > 0)

const source = captured.routes.get('/dsh-mermaid/source')
check('the source route is registered', typeof source === 'function')
const url = (query) => `/dsh-mermaid/source?${query}`

check(
  'the source route needs the nonce',
  (await call(source, { url: url('sessionId=s1&path=flow.mmd') })).status === 403,
)
check(
  'it requires every parameter',
  (await call(source, { nonce, url: url('sessionId=s1') })).status === 400,
)

const read = await call(source, { nonce, url: url('sessionId=s1&path=flow.mmd') })
check('it serves a Session file', read.status === 200 && read.body?.text?.includes('graph TD'), JSON.stringify(read.body))

// No `cwd` in the query: the address cannot carry one, and the Host resolves the root it
// fences the read with — a caller-supplied root would prove nothing.
const escaped = await call(source, {
  nonce,
  url: url(`sessionId=s1&path=${encodeURIComponent(path.join(outside, 'elsewhere.mmd'))}`),
})
check('it refuses a file outside the workspace', escaped.status === 403, JSON.stringify(escaped.body))

check(
  'it says a missing file is missing',
  (await call(source, { nonce, url: url('sessionId=s1&path=absent.mmd') })).body?.error?.includes('文件不存在') === true,
)
check('the source answer names the path it resolved', typeof read.body?.path === 'string' && read.body.path.endsWith('flow.mmd'), JSON.stringify(read.body?.path))

// The preview has no other way to tell the Host what it managed to render.
const diag = captured.routes.get('/dsh-mermaid/diag')
check('the diagnostic route is registered', typeof diag === 'function')
if (typeof diag === 'function') {
  check('it starts empty', (await call(diag, { url: '/dsh-mermaid/diag' })).body?.report === undefined)
  check(
    'it refuses a report without the nonce',
    (await call(diag, { method: 'POST', nonce: 'wrong', url: '/dsh-mermaid/diag', body: { projected: 'yes' } })).status === 403,
  )
  check(
    'it accepts one with the nonce',
    (await call(diag, { method: 'POST', nonce, url: '/dsh-mermaid/diag', body: { renderSlot: 'function', projected: 'yes' } })).status === 200,
  )
  const reported = await call(diag, { url: '/dsh-mermaid/diag' })
  check('and reads it back', reported.body?.report?.projected === 'yes', JSON.stringify(reported.body))
}

// The reported bug: in a plain Session — no file-session, no header.cwd — opening a file said
// "this Session has no workspace directory yet". The platform reader is what makes it work.
check(
  'a plain Session reads through the platform reader',
  await (async () => {
    const answer = await call(source, { nonce, url: url(`sessionId=s-plain&path=${PLAIN_FILE}`) })
    return answer.status === 200 && String(answer.body?.text ?? '').includes('PLAIN')
  })(),
)

check(
  'it explains a Session without a directory',
  (await call(source, { nonce, url: url('sessionId=s-unknown&path=flow.mmd') })).status === 409,
)

// The platform reader is not the only way in: a Session whose workspace is known still reads
// through the workspace-relative path, and when neither works the answer says why.
{
  const failing = harness({ cwd, platformFails: true })
  const failingTable = []
  await failing.emit('webserver/index-inject', failingTable)
  const failingNonce = failingTable.find((row) => row.name.startsWith('__DSH_'))?.value?.nonce
  const failingSource = failing.captured.routes.get('/dsh-mermaid/source')
  const known = await call(failingSource, { nonce: failingNonce, url: url('sessionId=s1&path=flow.mmd') })
  check(
    'a platform-read failure still reads through the workspace path',
    known.status === 200 && String(known.body?.text).includes('graph'),
    JSON.stringify(known.body).slice(0, 160),
  )
  // A Session that exists without a directory of its own still reads, because the scope falls
  // back to the sandbox policy's workspace root — the same fallback the platform applies.
  const plain = await call(failingSource, { nonce: failingNonce, url: url('sessionId=s-plain&path=' + PLAIN_FILE) })
  check(
    'a plain Session still reads when the platform reader is down',
    plain.status === 200 && String(plain.body?.text).includes('PLAIN'),
    JSON.stringify(plain.body).slice(0, 160),
  )
  // An unknown Session is refused outright rather than borrowing that root.
  const unknown = await call(failingSource, { nonce: failingNonce, url: url('sessionId=s-unknown&path=whatever.mmd') })
  check('an unknown Session is refused', unknown.status === 409 || unknown.status === 500, JSON.stringify(unknown).slice(0, 160))
}

fs.rmSync(cwd, { recursive: true, force: true })
fs.rmSync(outside, { recursive: true, force: true })

console.log(process.exitCode === 1 ? 'FAILURES above' : 'all dsh-mermaid host tests passed')
