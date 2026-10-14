/**
 * Host half of the `dsh-file-session` bundle.
 *
 * The product is one Session, one file. A Session running the `file-session` Agent
 * Preset binds exactly one file — either because the user picked it, or because
 * the Agent's first `write` created it — and from then on **cannot switch**: every
 * other write is denied, permanently, for that Session.
 *
 * Two seams carry the enforcement, both the weakest that suffice:
 *
 *   - `ctx.tools.guard(...)`, registered on the Agent's own context, denies
 *     `write`/`edit` aimed at anything but the bound file. Guards are synchronous,
 *     so paths are compared with string work, never `ctx.fs`.
 *   - `systemPrompt.section(...)` on the same context states the binding and the
 *     no-switch rule, so the model plans inside the boundary instead of
 *     discovering it through denials.
 *
 * The write escape hatches (`bash`, `pwsh`, `delegation`) are removed by the
 * preset's composition itself — see `cordis.patch.yml`.
 *
 * Formats whose editing needs an external toolchain (DOCX and friends) are `soft`:
 * the prompt section applies, the guard abstains, because the office pipeline
 * legitimately writes conversion artifacts beside the document.
 *
 * The Host map is plugin memory — a derived cache. The browser half keeps the
 * durable copy and re-states it when the Session becomes visible, so a Host
 * restart loses nothing that matters.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, watch } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize } from 'node:path'

/** Where the browser half reads and binds. */
const ROUTE = '/dsh-file-session/target'
/** Where the browser half asks for a new blank document. */
const CREATE_ROUTE = '/dsh-file-session/create'
/** Where the browser half reports what it registered; see the route handler for its gate. */
const HEALTH_ROUTE = '/dsh-file-session/health'
/** The blank Word document this bundle ships, made by python-docx's default template. */
const BLANK_DOCX = new URL('./assets/blank.docx', import.meta.url)
/** What 「新建」 offers, and the name each kind starts from. */
const CREATE_KINDS = {
  md: { extension: 'md', base: '新建文档' },
  docx: { extension: 'docx', base: '新建文档' },
  // A Mermaid file *is* its diagram, and Mermaid refuses an empty source, so this kind
  // starts from the smallest diagram that renders rather than from nothing.
  mermaid: { extension: 'mmd', base: '新建图表', content: 'graph TD\n    A[开始] --> B[结束]\n' },
}
/** Per-process secret handed to the page through the index; this route has no other gate. */
const NONCE = randomUUID()
/** The Agent Preset that owns this behaviour; declared in `cordis.patch.yml`. */
const PRESET_ID = 'file-session'
/** The tools whose first path argument names a write target. */
const WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * Sessions that have already been told their bound file is gone.
 *
 * A write that would *create* the missing bound file is refused once, so a Session whose file was
 * deleted cannot be silently rebuilt: the Agent has to surface it, and only a user who asks for
 * the rebuild gets one. The second attempt is allowed, which is what makes that possible without
 * asking the model to prove a conversation happened.
 */
const rebuildAfterNotice = new Set()

/** Formats whose file content is a Mermaid diagram. */
const MERMAID_EXTENSIONS = ['mmd', 'mermaid']
/** Formats the guard can hard-lock: editing them needs no external toolchain. */
const LOCKED_EXTENSIONS = ['md', 'markdown', 'mmd', 'mermaid', 'txt']
/**
 * Formats a focus Session may bind. Kept in step with `SUPPORTED_EXTENSIONS` in
 * `client.js`: they are what the right Sidebar can preview and what "one file"
 * means for the picker, for the workspace-change summary, and for the directory watch.
 */
const DOCUMENT_EXTENSIONS = ['md', 'markdown', 'mmd', 'mermaid', 'txt', 'docx', 'xlsx', 'pptx']
/** How long to wait after a turn for the recorder's summary before falling back to the watch. */
const WATCH_FALLBACK_MS = 1500
/** Office formats win a fallback choice: a created document beats a scratch note. */
const OFFICE_EXTENSIONS = ['docx', 'xlsx', 'pptx']
/** Placement after the repository's own sections, before structured output. */
const SECTION_ORDER = 9100
const SECTION_NAME = 'dsh-file-session:binding'
const MAX_BODY = 64 * 1024
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

/** sessionId -> { path, cwd?, mode: 'lock' | 'soft' } — written once, never replaced. */
const bindings = new Map()
/** sessionId -> the Session's committed directory, cached when its Agent enters. */
const directories = new Map()
/** sessionId -> live Agent, so the route can answer "is this a focus Session" without a persistence read. */
const agents = new Map()
/** sessionId -> live Session, for the one sandbox-policy lookup a create needs. */
const liveSessions = new Map()
/** The last report from the browser half, or `undefined` before it has ever applied. */
let clientHealth

/**
 * The per-call sandbox policy for writing into one Session's workspace.
 *
 * The enforcing backend resolves its own default when a call omits this, and that
 * default's writable root is the deployment fallback — not the Session's cwd — so an
 * omitted policy is refused as "file access denied under workspace-write mode". Pass
 * the Session's own policy when it is live, and otherwise the deployment policy with
 * its workspace root replaced by this Session's directory.
 */
function policyFor(ctx, sessionId, cwd) {
  const service = ctx.get('sandboxPolicy')
  if (service === undefined || typeof service.resolve !== 'function') return undefined
  const session = agents.get(sessionId)?.session ?? liveSessions.get(sessionId)
  try {
    if (session !== undefined) return service.resolve({ session })
    return { ...service.resolve({}), workspaceRoot: cwd, sessionId }
  } catch (error) {
    console.warn(`[dsh-file-session] sandbox policy unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Retitle the Session after the file it is bound to, so the sidebar row and the
 * session header name the one file this Session is about. The Harness title
 * service owns validation, and it is optional in a deployment; a failure is logged
 * and leaves the binding and the composer chip in place.
 */
async function renameToFile(ctx, sessionId, path) {
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.rename !== 'function') return
  const title = basename(path)
  if (title === '') return
  try {
    await controller.rename({ sessionId, title })
  } catch (error) {
    console.warn(`[dsh-file-session] session rename failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Bind one Session to one file — the only place a binding is ever created. */
function bind(ctx, sessionId, path, cwd) {
  const record = { path, cwd, mode: lockModeOf(path) }
  bindings.set(sessionId, record)
  stopWatching(sessionId)
  void renameToFile(ctx, sessionId, path)
  return record
}

/** sessionId -> { watcher, timer } for Sessions waiting for the file they are about. */
const watchers = new Map()

function stopWatching(sessionId) {
  const entry = watchers.get(sessionId)
  if (entry === undefined) return
  watchers.delete(sessionId)
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  try {
    entry.watcher.close()
  } catch {
    /* already closed */
  }
}

/** The absolute path a watch event announces, when it announces a document worth binding. */
function candidateFromWatch(cwd, filename) {
  if (typeof filename !== 'string' || filename === '') return undefined
  const relative = filename.replace(/\\/g, '/')
  if (relative.startsWith('.') || relative.includes('/.')) return undefined
  const name = basename(relative)
  if (name.startsWith('~$')) return undefined // LibreOffice's lock file
  if (!DOCUMENT_EXTENSIONS.includes(extensionOf(name))) return undefined
  return `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${relative}`
}

/**
 * Watch a focus Session's workspace until it binds a file. This is what catches a
 * document the Agent creates with a shell command — `bash` + python-docx writes no
 * `write`/`edit` call, so no guard ever sees it. The watch is scoped to one
 * Session's directory and runs only while that Session has no binding; it collects
 * candidates rather than binding eagerly, because a scratch note must not win over
 * the document the turn was about.
 */
function watchForCreation(ctx, sessionId, cwd) {
  if (watchers.has(sessionId) || bindings.has(sessionId)) return
  if (typeof cwd !== 'string' || cwd === '') return
  let watcher
  try {
    watcher = watch(cwd, { recursive: true, persistent: false })
  } catch (error) {
    console.warn(`[dsh-file-session] cannot watch ${cwd}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const entry = { watcher, candidates: new Set(), timer: undefined }
  watcher.on('error', () => stopWatching(sessionId))
  watcher.on('change', (_kind, filename) => {
    const candidate = candidateFromWatch(cwd, filename)
    if (candidate !== undefined) entry.candidates.add(candidate)
  })
  watchers.set(sessionId, entry)
}

/**
 * Arm the fallback at turn end: the recorder answers on the `workspace/changes`
 * event that follows, and this only fires if that answer never binds anything —
 * which is the normal case for a directory that is not a git repository.
 */
function armWatchFallback(ctx, sessionId, cwd) {
  const entry = watchers.get(sessionId)
  if (entry === undefined || entry.timer !== undefined) return
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    if (bindings.has(sessionId)) {
      stopWatching(sessionId)
      return
    }
    const candidate = chooseFromWatch(entry.candidates)
    if (candidate !== undefined) bind(ctx, sessionId, candidate, cwd)
  }, WATCH_FALLBACK_MS)
}

/** The best candidate the watch saw: a created office document, else the first document. */
function chooseFromWatch(candidates) {
  const list = [...candidates]
  if (list.length === 0) return undefined
  return list.find((path) => OFFICE_EXTENSIONS.includes(extensionOf(path))) ?? list[0]
}

/** Pick the document a turn produced, when the recorder listed the files it changed. */
function chooseDocument(files) {
  if (!Array.isArray(files)) return undefined
  const candidates = files.filter(
    (file) => file !== null && file !== undefined && typeof file.path === 'string' && DOCUMENT_EXTENSIONS.includes(extensionOf(file.path)),
  )
  if (candidates.length === 0) return undefined
  // An office document is unambiguous; otherwise the biggest change is the likeliest subject.
  const binary = candidates.find((file) => file.binary === true)
  if (binary !== undefined) return binary
  return candidates
    .slice()
    .sort((left, right) => (right.added ?? 0) + (right.deleted ?? 0) - ((left.added ?? 0) + (left.deleted ?? 0)))[0]
}

/**
 * Bind from the turn's workspace-change summary. The recorder cannot snapshot a
 * working directory that is not a git repository (it then lists only what the file
 * tools changed), which is exactly why the directory watch above exists as well.
 */
function bindFromChanges(ctx, sessionId, seq, cwd) {
  const changes = ctx.get('workspaceChanges')
  if (changes === undefined || typeof changes.summary !== 'function') return
  let summary
  try {
    summary = changes.summary(sessionId, seq)
  } catch {
    return
  }
  const file = chooseDocument(summary === undefined ? undefined : summary.files)
  if (file === undefined) return
  bind(ctx, sessionId, file.path, cwd ?? (summary === undefined ? undefined : summary.cwd))
}

function extensionOf(path) {
  const name = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

const lockModeOf = (path) => (LOCKED_EXTENSIONS.includes(extensionOf(path)) ? 'lock' : 'soft')

/** A path as written, for comparison when no directory is known. */
const normalWritten = (value) => value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+/g, '/')

/** Resolve one recorded or requested path to a comparable form. */
function resolveFor(value, cwd) {
  const unified = value.replace(/\\/g, '/')
  if (isAbsolute(unified)) return normalize(unified).replace(/\\/g, '/')
  if (cwd === undefined || cwd === '') return normalWritten(unified)
  return normalize(`${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${unified}`).replace(/\\/g, '/')
}

/** Whether two `{path, cwd}` records name the same file. */
function samePath(left, right) {
  const a = resolveFor(left.path, left.cwd)
  const b = resolveFor(right.path, right.cwd)
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The path a write tool call targets, when it carries one. */
function writtenPath(exec) {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const value = args.file_path ?? args.path
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The prompt text for one Session: empty while the Session is not a focus Session. */
function rulesFor(sessionId) {
  const record = bindings.get(sessionId)
  if (record === undefined) {
    return [
      '## 文件会话模式：尚未绑定文件',
      '- 本会话是「文件会话」会话，一次只服务一个文件，绑定后不可更改。',
      '- 有两种方式产生这个文件：用户直接选择一个文件，或者你现在就创建它。',
      '- 如果你需要文件会话：**你写入的第一个文件将成为本会话唯一的绑定文件**，此后只能修改它。',
      '- 因此不要先写临时文件、草稿或辅助脚本；第一个 `write` 就要落在真正的目标文件上。',
      '- 在创建之前，如果文件名或位置不确定，先和用户确认。',
    ].join('\n')
  }
  const bound = [
    '## 文件会话模式：已绑定唯一文件（不可切换）',
    `- 写入前先确认它还在：如果 \`${record.path}\` 已被删除或移动，**先告知用户，不要直接写回凭空重建**。`,
    '- 只有用户明确要求重建时，才可以在原路径重新创建它。',
    `- 本会话唯一的绑定文件是：\`${record.path}\``,
    '- 读取不受限制：`read`、`grep`、`glob` 可以查看任何文件。',
    '- 写入受硬性限制：`write` 与 `edit` 只能作用于这个文件；写到别处会被直接拒绝，且**没有解除方式**。',
    '- 不要创建辅助脚本、临时文件、草稿或说明文档；所有改动都直接写进这个文件。',
  ]
  // A `.mmd` file *is* the diagram: fences would be part of the syntax and break it.
  if (MERMAID_EXTENSIONS.includes(extensionOf(record.path))) {
    bound.push('- 这个文件是 Mermaid 图表源码：内容就是图表本身，不要写 ``` 代码围栏，也不要加 Markdown 标题；右侧会实时渲染它。')
  }
  if (record.mode === 'soft') {
    bound.push('- 该格式的编辑需要外部工具链，因此写入没有被硬性拦截；仍然请把改动集中在上面这个文件上。')
  } else {
    bound.push('- 如果用户的请求确实需要改动其他文件，告诉用户为本会话另开一个会话。')
  }
  return bound.join('\n')
}

/** Whether one live Agent is running the file-session preset, asked fresh so a later choice counts. */
function isFocus(ctx, agent) {
  const presets = ctx.get('agentPresets')
  return presets !== undefined && presets.composedPreset(agent.ctx) === PRESET_ID
}

/**
 * Give one Agent its guard and prompt section. Every Agent gets them; both stay
 * inert unless the Agent's preset is `file-session` at the moment they run, so the
 * preset may be chosen before or after the Agent entered.
 */
async function installFor(ctx, agent, fibers) {
  if (fibers.has(agent)) return
  const inject = agent.ctx?.inject
  if (typeof inject !== 'function') return

  const controller = ctx.get('sessionController')
  if (controller !== undefined) {
    try {
      const inspection = await controller.inspect(agent.id)
      const cwd = inspection?.meta?.cwd
      if (typeof cwd === 'string' && cwd !== '') directories.set(agent.id, cwd)
    } catch (error) {
      console.warn(`[dsh-file-session] session directory unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const fiber = agent.ctx.inject(['tools', 'systemPrompt'], (scope) => {
    scope.tools.guard((exec) => (isFocus(ctx, agent) ? guardCall(ctx, agent.id, exec) : undefined))
    scope.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => (isFocus(ctx, agent) ? rulesFor(agent.id) : ''),
    })
  })
  fibers.set(agent, fiber)
}

/** Deny every write that is not the bound file; bind on the first write. */
/**
 * Whether the bound file is gone.
 *
 * Synchronous because the guard is: it may only allow or refuse. A workspace this Host cannot
 * judge from a path — relative, or not a plain local one — answers "not missing", so the check can
 * refuse a write but never invent one.
 */
function isMissing(record, cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false
  try {
    const target = isAbsolute(record.path) ? normalize(record.path) : join(cwd, record.path)
    return !existsSync(target)
  } catch {
    return false
  }
}

function guardCall(ctx, sessionId, exec) {
  if (!WRITE_TOOLS.has(exec.name)) return undefined
  const raw = writtenPath(exec)
  if (raw === undefined) return undefined
  const cwd = directories.get(sessionId)
  const request = { path: raw, cwd }
  const record = bindings.get(sessionId)

  if (record === undefined) {
    // A chat-created file becomes the Session's one file, and names the Session.
    bind(ctx, sessionId, raw, cwd)
    return undefined
  }
  if (record.mode === 'soft') return undefined
  if (samePath(request, record)) {
    // The bound file is the one file this Session may write — but not silently from nothing.
    if (isMissing(record, cwd)) {
      const key = `${sessionId}\u0000${record.path}`
      if (!rebuildAfterNotice.has(key)) {
        rebuildAfterNotice.add(key)
        return [
          `文件会话模式：本会话绑定的文件已不存在：\`${record.path}\`（可能被删除、重命名或移出了会话工作区）。`,
          '请先把这件事告诉用户，不要直接写回：现在写入会凭空重建这个文件。',
          '如果用户明确要求重建，再次写入即可在原路径重建它。',
        ].join('')
      }
    }
    return undefined
  }
  return [
    `文件会话模式：本会话已绑定唯一文件 ${record.path}，不能再修改其他文件（本次 ${exec.name} 指向 ${raw} 已被拒绝）。`,
    '请把改动写进已绑定的文件；如果确实需要处理另一个文件，请为本会话之外新建一个「文件会话」会话。',
  ].join('')
}

function disposeFocus(agent, fibers) {
  const fiber = fibers.get(agent)
  fibers.delete(agent)
  directories.delete(agent.id)
  if (fiber === undefined) return
  Promise.resolve(fiber.dispose()).catch((error) => {
    console.warn(`[dsh-file-session] focus cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/** Read one JSON request body, bounded. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/**
 * Create one blank document in the Session's workspace and return its absolute path.
 * The name is ours: `新建文档`, then `新建文档-2`, `新建文档-3`, … past whatever is
 * already there. `createIfAbsent` semantics throughout — a race with another writer
 * picks the next name instead of clobbering a file.
 *
 * Markdown goes through `ctx.fs`, which is the sanctioned text path. A `.docx` is a
 * ZIP package, and `ctx.fs` exposes no binary write, so the shipped blank template is
 * copied with `node:fs` into the Session's own workspace.
 */
async function createDocument(ctx, kind, sessionId, cwd) {
  const spec = CREATE_KINDS[kind]
  if (spec === undefined) return { error: `kind must be one of ${Object.keys(CREATE_KINDS).join(', ')}` }
  if (typeof cwd !== 'string' || cwd === '') return { error: 'cwd required' }

  const policy = policyFor(ctx, sessionId, cwd)
  if (policy !== undefined && policy.mode === 'read-only') {
    return { error: '本会话处于只读模式，无法新建文件' }
  }

  let template
  if (kind === 'docx') {
    try {
      template = await readFile(BLANK_DOCX)
    } catch (error) {
      return { error: `blank template unavailable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const fsService = ctx.get('fs')

  for (let index = 1; index <= 50; index += 1) {
    const name = index === 1 ? `${spec.base}.${spec.extension}` : `${spec.base}-${index}.${spec.extension}`
    const absolute = join(cwd, name)
    if (existsSync(absolute)) continue
    try {
      if (kind === 'docx') await writeFile(absolute, template, { flag: 'wx' })
      else if (fsService !== undefined && typeof fsService.resolve === 'function') {
        const target = await fsService.resolve(name, { cwd })
        await fsService.writeText(target, spec.content ?? '', { kind: 'createIfAbsent' }, undefined, policy)
      } else await writeFile(absolute, spec.content ?? '', { flag: 'wx' })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EEXIST') continue
      return { error: error instanceof Error ? error.message : String(error) }
    }
    return { path: absolute }
  }
  return { error: 'no free file name after 50 tries' }
}

const recordOf = (sessionId) => {
  const record = bindings.get(sessionId)
  return record === undefined ? null : { path: record.path, cwd: record.cwd, mode: record.mode }
}

/** Whether the Host considers one Session a file-session Session, live Agent first, then its durable header. */
async function focusOf(ctx, sessionId) {
  const agent = agents.get(sessionId)
  if (agent !== undefined && isFocus(ctx, agent)) return true
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.inspect !== 'function') return false
  try {
    const inspection = await controller.inspect(sessionId)
    return inspection?.meta?.agentPreset === PRESET_ID
  } catch {
    return false
  }
}

/**
 * Answer the browser half's registration report.
 *
 * GET is intentionally ungated: it is the only way to see the client half from the Host
 * side when the page console is out of reach. It therefore carries no path, no binding, no
 * nonce and no free-form message — only counts, booleans, a version stamp and an error
 * *name* — so a page on another origin learns nothing it could not guess.
 */
async function healthRouteHandler(req, res) {
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  if (req.method === 'POST') {
    if (req.headers['x-dsh-file-session'] !== NONCE) return send(403, { ok: false, error: 'forbidden' })
    try {
      const body = JSON.parse(await readBody(req))
      clientHealth = {
        at: new Date().toISOString(),
        stamp: typeof body.stamp === 'string' ? body.stamp : undefined,
        injected: Array.isArray(body.injected) ? body.injected.filter((name) => typeof name === 'string') : [],
        seats: Number(body.seats) || 0,
        diagramType: body.diagramType === true,
        diagramBody: body.diagramBody === true,
        error: typeof body.error === 'string' ? body.error : undefined,
      }
    } catch (error) {
      return send(400, { ok: false, error: error instanceof Error ? error.name : 'bad request' })
    }
    return send(200, { ok: true })
  }
  if (req.method !== 'GET') return send(405, { ok: false, error: 'GET or POST' })
  return send(200, {
    ok: true,
    bindings: bindings.size,
    liveAgents: agents.size,
    client: clientHealth ?? null,
  })
}

async function routeHandler(ctx, req, res) {
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  if (req.headers['x-dsh-file-session'] !== NONCE) return send(403, { ok: false, error: 'forbidden' })

  const url = new URL(req.url ?? ROUTE, 'http://localhost')
  if (req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null) {
      return send(200, { ok: true, bindings: [...bindings].map(([id, record]) => ({ sessionId: id, ...record })) })
    }
    return send(200, { ok: true, target: recordOf(sessionId), focus: await focusOf(ctx, sessionId) })
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: 'POST or GET' })

  readBody(req)
    .then(async (body) => {
      const input = JSON.parse(body)
      const sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : undefined
      if (sessionId === undefined) return send(400, { ok: false, error: 'sessionId required' })
      const path = typeof input.path === 'string' && input.path !== '' ? input.path : undefined
      if (path === undefined) return send(400, { ok: false, error: 'path required' })
      const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : directories.get(sessionId)
      const request = { path, cwd }
      const existing = bindings.get(sessionId)
      if (existing !== undefined) {
        // Bind once: the same file is idempotent, any other file is refused.
        if (samePath(request, existing)) return send(200, { ok: true, target: recordOf(sessionId), rebound: false })
        return send(409, { ok: false, error: 'already-bound', target: recordOf(sessionId) })
      }
      bind(ctx, sessionId, path, cwd)
      return send(200, { ok: true, target: recordOf(sessionId), rebound: true })
    })
    .catch((error) => send(400, { ok: false, error: error instanceof Error ? error.message : String(error) }))
}

/** Create one blank document and bind the Session to it, in one request. */
async function createRouteHandler(ctx, req, res) {
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  if (req.headers['x-dsh-file-session'] !== NONCE) return send(403, { ok: false, error: 'forbidden' })
  if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
  try {
    const input = JSON.parse(await readBody(req))
    const sessionId = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : undefined
    if (sessionId === undefined) return send(400, { ok: false, error: 'sessionId required' })
    if (bindings.has(sessionId)) {
      return send(409, { ok: false, error: 'already-bound', target: recordOf(sessionId) })
    }
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : directories.get(sessionId)
    const created = await createDocument(ctx, input.kind, sessionId, cwd)
    if (created.error !== undefined) return send(400, { ok: false, error: created.error })
    bind(ctx, sessionId, created.path, cwd)
    return send(200, { ok: true, target: recordOf(sessionId) })
  } catch (error) {
    return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function apply(ctx) {
  // A plugin must not be able to keep the app from booting: an exception here fails this
  // entry's activation, and the desktop shell treats a failed web boot as fatal. Everything
  // below registers capabilities; a failure is reported and the plugin stays inert instead.
  try {
    applyInner(ctx)
  } catch (error) {
    console.warn('[dsh-file-session] the Host half could not be registered', error)
  }
}

function applyInner(ctx) {
  const fibers = new Map()

  ctx.effect(
    () =>
      ctx.on('webserver/index-inject', (table) => {
        table.push({
          kind: 'global',
          name: '__DSH_FILE_SESSION__',
          value: { nonce: NONCE, route: ROUTE, createRoute: CREATE_ROUTE },
        })
      }),
    'dsh-file-session: index nonce',
  )

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: ROUTE, handler: (req, res) => routeHandler(ctx, req, res) }),
      'dsh-file-session: binding route',
    )
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: CREATE_ROUTE,
          handler: (req, res) => createRouteHandler(ctx, req, res),
        }),
      'dsh-file-session: create route',
    )
    // The browser half reports what it managed to register, so the halves can be diagnosed
    // from the Host side. The report is written through the nonce-gated POST and read back
    // through a deliberately open GET that carries counts and an error *name* only — never a
    // path, a binding or the nonce — because the page's console is not reachable from here.
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: HEALTH_ROUTE,
          handler: (req, res) => healthRouteHandler(req, res),
        }),
      'dsh-file-session: health route',
    )
  })

  ctx.effect(
    () =>
      ctx.on('agent/created', async ({ agent }) => {
        agents.set(agent.id, agent)
        try {
          await installFor(ctx, agent, fibers)
        } catch (error) {
          console.warn(`[dsh-file-session] focus setup failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }),
    'dsh-file-session: agent guard and section',
  )
  ctx.effect(
    () =>
      ctx.on('agent/disposed', ({ agent }) => {
        agents.delete(agent.id)
        stopWatching(agent.id)
        disposeFocus(agent, fibers)
      }),
    'dsh-file-session: focus cleanup',
  )

  // A document the Agent creates with a shell command is invisible to the write guard:
  // `bash` + python-docx produces no `write`/`edit` call. The turn's workspace-change
  // summary catches it where the recorder can snapshot, and the directory watch catches
  // it everywhere else.
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        liveSessions.set(session.id, session)
        const sessionId = session.id
        if (bindings.has(sessionId)) {
          stopWatching(sessionId)
          return
        }
        const agent = agents.get(sessionId)
        if (agent === undefined || !isFocus(ctx, agent)) return
        const cwd = session.header === undefined ? directories.get(sessionId) : session.header.cwd
        if (event.type === 'workspace/changes') {
          bindFromChanges(ctx, sessionId, event.seq, cwd)
          return
        }
        if (event.type === 'turn/end') armWatchFallback(ctx, sessionId, cwd)
        if (!bindings.has(sessionId)) watchForCreation(ctx, sessionId, cwd)
      }),
    'dsh-file-session: bind files created outside write/edit',
  )
  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        liveSessions.delete(session.id)
      }),
    'dsh-file-session: session cache',
  )

  ctx.effect(
    () => () => {
      const pending = [...fibers.keys()]
      for (const agent of pending) disposeFocus(agent, fibers)
      for (const sessionId of [...watchers.keys()]) stopWatching(sessionId)
      agents.clear()
      liveSessions.clear()
    },
    'dsh-file-session: own teardown',
  )
}
