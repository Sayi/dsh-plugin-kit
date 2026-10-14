/**
 * Host half, run against a fake Cordis context: no Harness needed. It drives the
 * real `apply()` — the write guard, the binding and create routes, the
 * workspace-change summary, the directory watch and the sandbox policy — and reads
 * results back through the plugin's own HTTP handlers.
 *
 *   node test/host-half.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { apply } = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname).href)

const nonceOf = async (emit) => {
  const table = []
  await emit('webserver/index-inject', table)
  return table[0].value.nonce
}

function harness({ cwd, summary, enforceSandbox = false, withSourceFs = false }) {
  const listeners = new Map()
  const captured = { route: undefined, guard: undefined, section: undefined }
  const on = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(fn)
    return () => {}
  }
  const scope = {
    tools: {
      guard: (fn) => {
        captured.guard = fn
        return () => {}
      },
    },
    systemPrompt: {
      section: (section) => {
        captured.section = section
        return () => {}
      },
    },
  }
  const runEffect = (fn) => {
    const cleanup = fn()
    return () => {
      if (typeof cleanup === 'function') cleanup()
    }
  }
  const ctx = {
    on,
    effect: runEffect,
    get: (name) => {
      if (name === 'agentPresets') return { composedPreset: () => 'file-session' }
      if (enforceSandbox && name === 'sandboxPolicy') {
        // Mirrors the real service: the deployment default's writable root is NOT the
        // session's cwd, so a call that omits the policy is refused by containment.
        return {
          resolve: (request) =>
            request !== undefined && request.session !== undefined
              ? { mode: 'workspace-write', workspaceRoot: cwd, sessionId: request.session.id }
              : { mode: 'workspace-write', workspaceRoot: '/deployment/fallback' },
        }
      }
      if (withSourceFs && name === 'fs') {
        // A minimal node-backed filesystem, so the source route can be driven for real.
        return {
          resolve: async (target, opts) => ({
            targetKey: path.resolve(opts?.cwd ?? cwd, target),
            displayPath: path.resolve(opts?.cwd ?? cwd, target),
          }),
          contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + path.sep),
          stat: async (target) =>
            fs.existsSync(target.targetKey) && fs.statSync(target.targetKey).isFile()
              ? { type: 'file', size: fs.statSync(target.targetKey).size }
              : undefined,
          readText: async (target) => fs.readFileSync(target.targetKey, 'utf8'),
        }
      }
      if (enforceSandbox && name === 'fs') {
        return {
          resolve: async (name, opts) => ({ targetKey: 'k', displayPath: path.join(opts.cwd, name) }),
          writeText: async (target, content, intent, _signal, policy) => {
            if (policy === undefined || policy.workspaceRoot !== cwd) {
              const error = new Error(
                `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
              )
              error.code = 'FS_SANDBOX_DENIED'
              throw error
            }
            fs.writeFileSync(target.displayPath, content, { flag: intent?.kind === 'createIfAbsent' ? 'wx' : 'w' })
          },
        }
      }
      if (name === 'sessionController') {
        return { rename: async () => {}, inspect: async () => ({ meta: { cwd } }) }
      }
      if (name === 'workspaceChanges') return { summary: () => summary }
      return undefined
    },
    inject: (deps, cb) => {
      if (deps.includes('webServer')) {
        cb({
          effect: runEffect,
          webServer: {
            register: (route) => {
              captured.handlers = captured.handlers ?? {}
              captured.handlers[route.path] = route.handler
              captured.route = route
              captured.handler = route.handler
              return () => {}
            },
          },
        })
      }
      return () => {}
    },
  }
  apply(ctx)
  const emit = async (name, ...args) => {
    for (const fn of listeners.get(name) ?? []) await fn(...args)
  }
  const agentFor = (id) => ({
    id,
    ctx: {
      inject: (_deps, cb) => {
        cb(scope)
        return { dispose: async () => {} }
      },
    },
  })
  return { captured, emit, agentFor }
}

async function call(handler, { method = 'GET', url = '/dsh-file-session/target', nonce, body } = {}) {
  return new Promise((resolve) => {
    const headers = nonce === undefined ? {} : { 'x-dsh-file-session': nonce }
    const res = {
      writeHead: (status) => {
        res.status = status
      },
      end: (payload) => resolve({ status: res.status, body: payload === undefined ? undefined : JSON.parse(payload) }),
    }
    const req = {
      method,
      url,
      headers,
      on: (name, fn) => {
        if (name === 'data' && body !== undefined) fn(JSON.stringify(body))
        if (name === 'end') fn()
      },
      destroy: () => {},
    }
    handler(req, res)
  })
}

const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

// ---------------------------------------------------------------- 1. docx created by a shell command
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'))
  const { captured, emit, agentFor } = harness({ cwd, summary: undefined })
  const nonce = await nonceOf(emit)
  const session = { id: 's-watch', header: { cwd } }

  await emit('agent/created', { agent: agentFor('s-watch') })
  await emit('session/event', session, { type: 'user/message', seq: 1 }) // opens the watch
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'scratch') // a scratch note must not win
  await new Promise((r) => setTimeout(r, 150))
  fs.writeFileSync(path.join(cwd, 'out.docx'), 'PK') // the document the turn was about
  await new Promise((r) => setTimeout(r, 150))
  await emit('session/event', session, { type: 'turn/end', seq: 2 }) // arms the fallback
  await new Promise((r) => setTimeout(r, 1800))

  const answer = await call(captured.handlers['/dsh-file-session/target'], { nonce, url: '/dsh-file-session/target?sessionId=s-watch' })
  check('shell-created docx binds through the watch', answer.body?.target?.path === path.join(cwd, 'out.docx'), JSON.stringify(answer.body))
  check('the binding is a focus Session', answer.body?.focus === true)
  check('an office document beats the scratch note', !String(answer.body?.target?.path).endsWith('notes.md'))
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 2. the write guard
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'))
  const { captured, emit, agentFor } = harness({ cwd, summary: undefined })
  const nonce = await nonceOf(emit)
  await emit('agent/created', { agent: agentFor('s-guard') })
  const first = captured.guard({ name: 'write', arguments: { file_path: 'plan.md' } })
  const second = captured.guard({ name: 'write', arguments: { file_path: 'other.md' } })
  const read = captured.guard({ name: 'read', arguments: { file_path: 'other.md' } })
  check('the first write is allowed and binds', first === undefined, String(first))
  check('a later write elsewhere is denied', typeof second === 'string' && second.includes('plan.md'), String(second))
  check('reads are never denied', read === undefined)
  // The bound file disappears. A Session whose one file is gone must not be able to rebuild it
  // silently: the first write is refused with the news, and only the one after that — by which
  // point the Agent has had to say so — may recreate it.
  await emit('session/event', { id: 's-guard', header: { cwd } })
  fs.rmSync(path.join(cwd, 'plan.md'), { force: true })
  const afterDelete = captured.guard({ name: 'write', arguments: { file_path: 'plan.md' } })
  check(
    'a write that would rebuild a deleted bound file is refused once',
    typeof afterDelete === 'string' && afterDelete.includes('已不存在') && afterDelete.includes('重建'),
    String(afterDelete),
  )
  const rebuild = captured.guard({ name: 'write', arguments: { file_path: 'plan.md' } })
  check('and the attempt after that is allowed, so an asked-for rebuild works', rebuild === undefined, String(rebuild))


  const answer = await call(captured.handlers['/dsh-file-session/target'], { nonce, url: '/dsh-file-session/target?sessionId=s-guard' })
  check('the guard bound the file', answer.body?.target?.path === 'plan.md', JSON.stringify(answer.body))
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 3. bind once, never switch
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'))
  const { captured, emit, agentFor } = harness({ cwd, summary: undefined })
  const nonce = await nonceOf(emit)
  await emit('agent/created', { agent: agentFor('s-pick') })
  const first = await call(captured.handlers['/dsh-file-session/target'], { method: 'POST', nonce, body: { sessionId: 's-pick', path: `${cwd}/a.md`, cwd } })
  const again = await call(captured.handlers['/dsh-file-session/target'], { method: 'POST', nonce, body: { sessionId: 's-pick', path: `${cwd}/a.md`, cwd } })
  const other = await call(captured.handlers['/dsh-file-session/target'], { method: 'POST', nonce, body: { sessionId: 's-pick', path: `${cwd}/b.md`, cwd } })
  const unauthorized = await call(captured.handlers['/dsh-file-session/target'], { url: '/dsh-file-session/target?sessionId=s-pick' })
  check('POST binds', first.body?.rebound === true)
  check('the same file is idempotent', again.status === 200 && again.body?.rebound === false)
  check('a different file is refused', other.status === 409 && other.body?.error === 'already-bound')
  check('a missing nonce is forbidden', unauthorized.status === 403)
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 4. create a blank document
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'))
  const { captured, emit, agentFor } = harness({ cwd, summary: undefined })
  const nonce = await nonceOf(emit)
  const create = captured.handlers['/dsh-file-session/create']
  await emit('agent/created', { agent: agentFor('s-create') })

  const md = await call(create, { method: 'POST', nonce, body: { sessionId: 's-create', kind: 'md', cwd } })
  const mdPath = path.join(cwd, '新建文档.md')
  check('create md writes a blank file', md.body?.target?.path === mdPath && fs.existsSync(mdPath) && fs.readFileSync(mdPath, 'utf8') === '')
  check('create binds the Session', md.body?.target?.mode === 'lock')

  const blocked = await call(create, { method: 'POST', nonce, body: { sessionId: 's-create', kind: 'docx', cwd } })
  check('create refuses once bound', blocked.status === 409)
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 4b. create a Mermaid diagram
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'))
  const { captured, emit, agentFor } = harness({ cwd, summary: undefined })
  const nonce = await nonceOf(emit)
  const create = captured.handlers['/dsh-file-session/create']
  await emit('agent/created', { agent: agentFor('s-mermaid') })

  const answer = await call(create, { method: 'POST', nonce, body: { sessionId: 's-mermaid', kind: 'mermaid', cwd } })
  const mmdPath = path.join(cwd, '新建图表.mmd')
  const source = fs.existsSync(mmdPath) ? fs.readFileSync(mmdPath, 'utf8') : ''
  check('create mermaid writes a starter diagram', answer.body?.target?.path === mmdPath && source.length > 0, JSON.stringify(answer.body))
  // Mermaid refuses an empty source, so the starter has to be a diagram, not a blank file.
  check('the starter is a real diagram, not an empty file', /^graph TD\n/.test(source), JSON.stringify(source))
  // `.mmd` is a plain-text format, so the guard can hard-lock it.
  check('the binding is locked for a Mermaid file', answer.body?.target?.mode === 'lock')
  check('a second kind is refused once bound', (await call(create, { method: 'POST', nonce, body: { sessionId: 's-mermaid', kind: 'md', cwd } })).status === 409)
  // The file is the diagram, so the prompt has to say that fences would break it.
  // A section's text is a thunk so it re-reads the live binding on every assembly.
  const promptText = typeof captured.section?.text === 'function' ? captured.section.text() : captured.section?.text
  check(
    'the prompt tells the model a diagram file is bare Mermaid',
    typeof promptText === 'string' && promptText.includes('不要写 ``` 代码围栏'),
    String(promptText).slice(0, 160),
  )
  check('an unknown kind is rejected', (await call(create, { method: 'POST', nonce, body: { sessionId: 's-mermaid-x', kind: 'pdf', cwd } })).status === 400)
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 5. create a blank docx
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'))
  const { captured, emit, agentFor } = harness({ cwd, summary: undefined })
  const nonce = await nonceOf(emit)
  const create = captured.handlers['/dsh-file-session/create']
  await emit('agent/created', { agent: agentFor('s-docx') })

  const answer = await call(create, { method: 'POST', nonce, body: { sessionId: 's-docx', kind: 'docx', cwd } })
  const docxPath = path.join(cwd, '新建文档.docx')
  const bytes = fs.existsSync(docxPath) ? fs.readFileSync(docxPath) : Buffer.alloc(0)
  check('create docx writes the shipped template', answer.body?.target?.path === docxPath && bytes.length > 1000)
  check('the blank docx is a ZIP package', bytes[0] === 0x50 && bytes[1] === 0x4b)
  check('the binding is soft for a container format', answer.body?.target?.mode === 'soft')

  // A second create picks the next free name rather than overwriting — simulate by clearing the binding.
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 6. the sandbox policy is passed through
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'))
  const { captured, emit, agentFor } = harness({ cwd, summary: undefined, enforceSandbox: true })
  const nonce = await nonceOf(emit)
  const create = captured.handlers['/dsh-file-session/create']
  await emit('agent/created', { agent: agentFor('s-sandbox') })

  const answer = await call(create, { method: 'POST', nonce, body: { sessionId: 's-sandbox', kind: 'md', cwd } })
  const wrote = fs.existsSync(path.join(cwd, '新建文档.md'))
  check(
    'create passes a policy whose writable root is the Session cwd',
    answer.body?.ok === true && wrote,
    JSON.stringify(answer.body),
  )
  fs.rmSync(cwd, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 7. the health route
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'))
  const { captured, emit } = harness({ cwd, summary: undefined })
  const nonce = await nonceOf(emit)
  const health = captured.handlers['/dsh-file-session/health']

  const before = await call(health, { method: 'GET' })
  check('health reads without a nonce', before.status === 200 && before.body?.client === null, JSON.stringify(before.body))

  const denied = await call(health, { method: 'POST', body: { stamp: 'x' } })
  check('health refuses an unreported write', denied.status === 403)

  const wrote = await call(health, {
    method: 'POST',
    nonce,
    body: { stamp: 'stamp-1', injected: ['slots', 'remote.workspaceFiles'], seats: 2, diagramType: true, diagramBody: true },
  })
  check('health accepts the browser report', wrote.status === 200, JSON.stringify(wrote.body))

  const after = await call(health, { method: 'GET' })
  check(
    'health reports the browser half back',
    after.body?.client?.stamp === 'stamp-1' && after.body?.client?.diagramType === true && after.body?.client?.seats === 2,
    JSON.stringify(after.body),
  )
  // The open read must not leak a Session, a path or the nonce.
  const text = JSON.stringify(after.body)
  check(
    'health leaks no path or nonce',
    !text.includes(cwd) && !text.includes(nonce) && !text.includes('sessionId'),
    text.slice(0, 200),
  )
  fs.rmSync(cwd, { recursive: true, force: true })
}

console.log(process.exitCode === 1 ? 'FAILURES above' : 'all host-half tests passed')
