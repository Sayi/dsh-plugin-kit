/**
 * Host half of `dsh-d2`, run against a fake Cordis context and the **real** `d2` binary: the
 * interesting part of this plugin is that it compiles with the CLI, so the test compiles with it
 * too rather than with a stub of it.
 *
 *   node test/host-half.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { apply } = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname).href)

function harness({ cwd, platformFails = false }) {
  const captured = { routes: new Map() }
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
  return { captured, emit: async (event, payload) => listeners.get(event)?.(payload) }
}

function call(handler, { method = 'GET', url = '/dsh-d2/source', nonce, body } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      headers: nonce === undefined ? {} : { 'x-dsh-d2': nonce },
      [Symbol.asyncIterator]: async function* () {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      status: undefined,
      writeHead(status) {
        this.status = status
      },
      end(text) {
        resolve({ status: this.status, body: text === undefined ? undefined : JSON.parse(text) })
      },
    }
    handler(req, res)
  })
}

const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-test-'))
fs.writeFileSync(path.join(cwd, 'flow.d2'), 'a -> b: hello\n')
const PLAIN_FILE = 'plain.d2'
fs.writeFileSync(path.join(cwd, PLAIN_FILE), 'PLAIN -> shape\n')

const { captured, emit } = harness({ cwd })
const table = []
await emit('webserver/index-inject', table)
const nonce = table.find((row) => row.name === '__DSH_D2__')?.value?.nonce
check('the Host publishes its routes and nonce to the page', typeof nonce === 'string' && nonce.length > 0)

const url = (query) => `/dsh-d2/source?${query}`
const source = captured.routes.get('/dsh-d2/source')
const render = captured.routes.get('/dsh-d2/render')
const diag = captured.routes.get('/dsh-d2/diag')
check('the source route is registered', typeof source === 'function')
check('the render route is registered', typeof render === 'function')
check('the diagnostic route is registered', typeof diag === 'function')

check('the source route needs the nonce', (await call(source, { url: url('sessionId=s1&path=flow.d2') })).status === 403)
check('it requires every parameter', (await call(source, { nonce, url: url('sessionId=s1') })).status === 400)
const read = await call(source, { nonce, url: url('sessionId=s1&path=flow.d2') })
check('it serves a Session file', read.status === 200 && read.body?.text?.includes('a -> b'), JSON.stringify(read.body))
check('and names the path it resolved', typeof read.body?.path === 'string' && read.body.path.endsWith('flow.d2'), read.body?.path)
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
  (await call(source, { nonce, url: url('sessionId=s-unknown&path=flow.d2') })).status === 409,
)

check('the render route needs the nonce', (await call(render, { method: 'POST', url: '/dsh-d2/render', body: { source: 'a -> b' } })).status === 403)
check(
  'and refuses an empty source',
  (await call(render, { method: 'POST', nonce, url: '/dsh-d2/render', body: { source: '  ' } })).status === 400,
)

// The real CLI: this is the plugin's whole reason for existing, so the test drives it for real.
const compiled = await call(render, { method: 'POST', nonce, url: '/dsh-d2/render', body: { source: 'a -> b: hello' } })
check('it compiles a source into SVG with the CLI', compiled.status === 200 && compiled.body?.ok === true && String(compiled.body.svg).includes('<svg'), JSON.stringify(compiled.body).slice(0, 160))

const broken = await call(render, { method: 'POST', nonce, url: '/dsh-d2/render', body: { source: 'a -> {\n' } })
check('and answers a compile error with the CLI message', broken.body?.ok === false && /failed to compile|maps must be terminated/i.test(String(broken.body?.message)), String(broken.body?.message).slice(0, 200))

// A deployment without the CLI: the one failure a user can act on, said in words.
process.env.DSH_D2_BIN = path.join(cwd, 'definitely-not-d2')
const missing = await call(render, { method: 'POST', nonce, url: '/dsh-d2/render', body: { source: 'a -> b' } })
delete process.env.DSH_D2_BIN
check('a missing binary is reported as such', missing.body?.error === 'd2-missing' && /d2/.test(String(missing.body?.message)), JSON.stringify(missing.body))

check('the diagnostic route starts empty', (await call(diag, { url: '/dsh-d2/diag' })).body?.report === undefined)
check(
  'it refuses a report without the nonce',
  (await call(diag, { method: 'POST', nonce: 'wrong', url: '/dsh-d2/diag', body: { rendered: 'yes' } })).status === 403,
)
check(
  'it accepts one with the nonce',
  (await call(diag, { method: 'POST', nonce, url: '/dsh-d2/diag', body: { rendered: 'yes' } })).status === 200,
)
check('and reads it back', (await call(diag, { url: '/dsh-d2/diag' })).body?.report?.rendered === 'yes')

// The platform reader is not the only way in: a Session whose workspace is known still reads
// through the workspace-relative path, and when neither works the answer says why.
{
  const failing = harness({ cwd, platformFails: true })
  const failingTable = []
  await failing.emit('webserver/index-inject', failingTable)
  const failingNonce = failingTable.find((row) => row.name.startsWith('__DSH_'))?.value?.nonce
  const failingSource = failing.captured.routes.get('/dsh-d2/source')
  const known = await call(failingSource, { nonce: failingNonce, url: url('sessionId=s1&path=flow.d2') })
  check(
    'a platform-read failure still reads through the workspace path',
    known.status === 200 && String(known.body?.text).includes('a -> b'),
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
  const unknown = await call(failingSource, { nonce: failingNonce, url: url('sessionId=s-unknown&path=whatever.d2') })
  check('an unknown Session is refused', unknown.status === 409 || unknown.status === 500, JSON.stringify(unknown).slice(0, 160))
}

fs.rmSync(cwd, { recursive: true, force: true })
console.log(process.exitCode === 1 ? 'FAILURES above' : 'all dsh-d2 host tests passed')
