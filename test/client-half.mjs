/**
 * Browser half, run against a fake browser: it loads the real module through the
 * module loader, applies it to a fake Cordis context, and asserts the entry's
 * behaviour in every state it must handle — both seats, every composer layout, the
 * four actions, the diagram tab type it contributes, and that creating a file also
 * starts its Session.
 *
 *   node test/client-half.mjs
 */
import fs from 'node:fs'

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** The text a node renders, however deeply it nests. */
const textOf = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}


let loaded
/**
 * A miniature React: hooks with real state, dependency-checked effects, and re-render
 * passes. A stub whose `useState` never updates and whose `useEffect` never runs cannot
 * exercise a body that loads a file, renders it, and switches views — which is exactly
 * what these tests now need to check.
 */
let current = undefined
const React = {
  Fragment: 'Fragment',
  createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
  useState: (init) => {
    const slot = current.hook()
    if (!('value' in slot)) slot.value = typeof init === 'function' ? init() : init
    return [
      slot.value,
      (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        current.dirty = true
      },
    ]
  },
  useEffect: (fn, deps) => {
    const slot = current.hook()
    const same = slot.deps !== undefined && deps !== undefined &&
      slot.deps.length === deps.length && slot.deps.every((value, index) => Object.is(value, deps[index]))
    if (same) return
    slot.deps = deps
    slot.fn = fn
  },
  useRef: () => {
    const slot = current.hook()
    if (!('value' in slot)) slot.value = { current: null }
    return slot.value
  },
}

/**
 * Render one component function with working hooks, run its effects, and re-render up to
 * `passes` times while state keeps changing. Async effect work is awaited by the caller,
 * which then asks for another pass with `again()`.
 */
function mount(Component, props, passes = 6) {
  let hooks = []
  let cleanups = []
  const run = () => {
    let cursor = 0
    current = { hook: () => (hooks[cursor++] ??= {}), dirty: false }
    const tree = Component(props)
    for (const slot of hooks) {
      if (slot.fn === undefined) continue
      const fn = slot.fn
      slot.fn = undefined
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    return tree
  }
  let tree = run()
  for (let pass = 0; pass < passes; pass += 1) {
    if (!current.dirty) break
    tree = run()
  }
  return {
    // A getter, not a captured value: the tree changes on every re-render, and a stale
    // snapshot silently hid the zoom bar this suite is supposed to drive.
    get tree() {
      return tree
    },
    get text() {
      return JSON.stringify(tree)
    },
    again: (more = 6) => {
      current.dirty = true
      for (let pass = 0; pass < more; pass += 1) {
        if (!current.dirty) break
        tree = run()
      }
      return tree
    },
    unmount: () => {
      for (const cleanup of cleanups) cleanup()
      cleanups = []
    },
  }
}

function run(
  label,
  {
    storage = null,
    blank = false,
    preset = 'file-session',
    layout,
    canReadFiles = true,
    colorScheme = 'light',
    diagramSource = 'graph TD\n  A --> B\n',
    parseError = undefined,
    diagramTypeThrows = false,
    sourceFails = false,
    /** The desktop preload's `pathFor`, or `null` to prove a pick without one is refused. */
    hostPaths = () => '/repo/docs/plan.md',
  } = {},
) {
  globalThis.window = {
    __ModuleLoader__: { load: (mod) => { loaded = mod } },
    __DSH_FILE_SESSION__: { nonce: 'n', route: '/dsh-file-session/target', createRoute: '/dsh-file-session/create' },
    // The desktop preload the browser half asks for a picked file's absolute path.
    ...(hostPaths === null ? {} : { __DSH_HOST_PATHS__: { pathFor: hostPaths } }),
    localStorage: { getItem: () => storage, setItem: () => {} },
  }
  const posted = []
  const health = []
  const sourceUrls = []
  // Named apart from the option so it can be toggled inside the fake after construction.
  let failsSourceRead = sourceFails
  // The menus close on an outside pointer press or Escape, which needs a document to listen on.
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }
  globalThis.fetch = async (url, options) => {
    // The diagram preview reads its file through this bundle's own Host route.
    if (String(url).includes('/dsh-file-session/source')) {
      sourceUrls.push(String(url))
      if (failsSourceRead) return { ok: true, status: 200, json: async () => ({ ok: false, error: 'this Session has no workspace directory yet' }) }
      return { ok: true, status: 200, json: async () => ({ ok: true, text: diagramSource }) }
    }
    // The diagnostic beacon is reported separately: it is not one of the actions under test.
    if (options?.body !== undefined) {
      const body = JSON.parse(options.body)
      if (String(url).includes('/health')) health.push(body)
      else posted.push(body)
      // The bind route answers with the binding it kept, so a picked path comes back as itself.
      if (String(url).includes('/target') && typeof body.path === 'string') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            target: { path: body.path, cwd: body.cwd ?? '/repo', mode: 'lock' },
            focus: true,
          }),
        }
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        target: { path: '/repo/新建文档.md', cwd: '/repo', mode: 'lock' },
        focus: true,
      }),
    }
  }
  new Function(code)()
  const renders = []
  const chunk = {
    highlightDiagram: (text) => `<span class="hljs-keyword">${text}</span>`,
    parseDiagram: async () => parseError,
    renderDiagram: async (text, scheme) => {
      renders.push({ text, scheme })
      return `<svg data-scheme="${scheme}"></svg>`
    },
  }
  const requireStub = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  }
  requireStub.async = async (name) => {
    if (name === './client.mermaid.js') return chunk
    throw new Error(`unexpected require.async(${name})`)
  }
  const mod = loaded.factory(requireStub)
  if (typeof mod.apply !== 'function' || !Array.isArray(mod.inject)) throw new Error('bad module shape')

  const registrations = []
  const prompts = []
  const tabTypes = []
  const effectDisposers = []
  const themeHandlers = []
  // `remote` is a *namespace*: its members are services of their own, and Cordis guards
  // property access on it. Reading `remote.workspaceFiles` as a property throws
  // `cannot get property "remote.workspaceFiles" without inject` — the mistake that once
  // failed this entry's activation and took the whole web boot down with it. Modelling
  // that here is the regression test. The reader also only *mounts* later, so `mount`
  // drives its arrival and the pending `ctx.inject` callback fires then, never before.
  const mounted = new Set()
  if (canReadFiles) mounted.add('remote.workspaceFiles')
  const readBytes = async () => ({ data: new TextEncoder().encode(diagramSource) })
  const reader = { readBytes }
  // Cordis only lets a plugin read a namespaced service whose exact key it declared.
  const declared = new Set(mod.inject)
  const remoteNamespace = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'workspaceFiles' && declared.has('remote.workspaceFiles')) {
          return mounted.has('remote.workspaceFiles') ? reader : undefined
        }
        throw new Error(`cannot get property "remote.${String(property)}" without inject`)
      },
    },
  )
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: { s1: { cwd: '/repo', blank, projectionValues: { agentPreset: preset } } },
      }),
    },
    binding: (id) => ({
      session: {
        prompt: async (content, mode) => {
          prompts.push({ id, content, mode })
          return { ok: true }
        },
      },
    }),
  }
  const pendingInjects = []
  const settleInjects = () => {
    for (const entry of [...pendingInjects]) {
      if (!entry.dependencies.every((name) => resolve(name) !== undefined)) continue
      pendingInjects.splice(pendingInjects.indexOf(entry), 1)
      const dispose = entry.callback()
      entry.dispose = typeof dispose === 'function' ? dispose : () => {}
    }
  }
  const ctx = {
    sidebarRightTabs: {
      register: (definition) => {
        if (diagramTypeThrows) throw new Error('the tab registry refused')
        // The real registry refuses a duplicate id, which is exactly what a second `apply`
        // hits when the previous registration was not owned by an effect.
        if (tabTypes.some((type) => type.id === definition.id)) {
          throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`)
        }
        tabTypes.push(definition)
        return () => {
          const index = tabTypes.indexOf(definition)
          if (index >= 0) tabTypes.splice(index, 1)
        }
      },
    },
    effect: (fn) => {
      const dispose = fn()
      effectDisposers.push(typeof dispose === 'function' ? dispose : () => {})
    },
    // Cordis runs the callback only once every named dependency resolves.
    inject: (dependencies, callback) => {
      pendingInjects.push({ dependencies, callback, dispose: () => {} })
      settleInjects()
      return () => {}
    },
    on: (event, handler) => {
      themeHandlers.push({ event, handler })
      return () => {}
    },
    get: (name) => {
      if (name === 'remote.workspaceFiles') return resolve(name)
      if (name === 'remote') return remoteNamespace
      if (name === 'theme') {
        return { getTheme: () => ({ active: { colorScheme: colorScheme } }) }
      }
      if (name === 'sessions') return sessions
      return undefined
    },
    slots: {
      inject: (_slot, cb) => cb(),
      register: (options, component) => {
        // A list slot addresses its cells by id: registering the same id replaces that cell.
        const existing = registrations.findIndex(
          (item) => item.options.name === options.name && item.options.id === options.id,
        )
        if (existing >= 0) registrations.splice(existing, 1)
        const entry = { options, component }
        registrations.push(entry)
        return () => {
          const index = registrations.indexOf(entry)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    sidebarRight: { openResource: () => {} },
  }
  // A declared injection is a property of the context, which is why the bundle reads
  // `ctx.remote.workspaceFiles` rather than digging through `ctx.get('remote')`.
  ctx.remote = remoteNamespace

  /** What Cordis would find for one injected key: a context property, or a service. */
  const resolve = (name) => {
    if (name === 'remote.workspaceFiles') return mounted.has(name) ? reader : undefined
    if (name === 'remote') return remoteNamespace
    if (name in ctx) return ctx[name]
    return ctx.get(name)
  }

  // An entry with an unsatisfied hard injection does not activate: Cordis keeps it pending
  // until every declared service resolves, and `mount` plays that arrival.
  let activated = false
  const activateIfReady = () => {
    if (activated) return
    if (mod.inject.some((name) => resolve(name) === undefined)) return
    activated = true
    mod.apply(ctx)
  }
  activateIfReady()
  const entry = (name) => registrations.find((r) => r.options.name === name)
  const propsFor = (seat) => ({
    sessionId: 's1',
    seat,
    ...(layout === undefined
      ? {}
      : {
          useSession: () => layout.session,
          useSessions: (select) => select({ byId: { s1: { blank: layout.summaryBlank } } }),
          useConversation: () => layout.conversation,
        }),
  })
  /** What a plugin disposal does: every effect this instance owns is torn down. */
  const dispose = () => {
    for (const disposer of effectDisposers.splice(0)) disposer()
  }
  /** What an HMR reload does: dispose the old instance, then apply the new module. */
  const reapply = () => {
    dispose()
    activated = false
    activateIfReady()
  }
  const mount = (name) => {
    mounted.add(name)
    settleInjects()
    activateIfReady()
  }
  /** The access Cordis refuses without an injection; a probe for the model itself. */
  const nestedServiceAccess = () => ctx.get('remote').notAnInjectedService
  return {
    registrations,
    entry,
    propsFor,
    prompts,
    tabTypes,
    posted,
    mount,
    dispose,
    reapply,
    nestedServiceAccess,
    themeHandlers,
    injected: mod.inject,
    activated: () => activated,
    resolve,
    health,
    renders,
    reader,
    sourceUrls,
  }
}

/** Render one registered entry through the mini React; returns its tree. */
const render = (harness, slot, props) => mount(harness.entry(slot).component, props).tree
/** Address one seat exactly: two entries share the composer dock, so the slot is ambiguous. */
const renderSeat = (harness, id, props) =>
  mount(harness.registrations.find((entry) => entry.options.id === id).component, props).tree

const findByKey = (node, key) => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findByKey(item, key)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (node.props !== undefined && node.props.key === key) return node
  for (const child of node.children ?? []) {
    const hit = findByKey(child, key)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** The percentage the zoom control currently shows, read from its own node. */
const percentOf = (view) => {
  const node = findByKey(view.tree, 'zoom-value')
  return node === undefined ? undefined : Number(String(node.children[0]).replace('%', ''))
}

/** Buttons whose glyph is not their name are addressed by their accessible label. */
const findByLabel = (node, label) => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findByLabel(item, label)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (node.props !== undefined && (node.props['aria-label'] === label || node.props.title === label)) return node
  for (const child of node.children ?? []) {
    const hit = findByLabel(child, label)
    if (hit !== undefined) return hit
  }
  return undefined
}

const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

// Two seats, one entry each, with distinct ids. The preview of a bound file is a separate
// plugin's business, so nothing here registers a tab type or a tab body.
const both = run('seats')
const dockIds = both.registrations.map((r) => r.options.id)
check(
  'registers both dock seats',
  both.entry('conversation.composer.dock') !== undefined &&
    both.entry('conversation.input.dock') !== undefined &&
    dockIds.includes('dsh-file-session.composer') &&
    dockIds.includes('dsh-file-session.row') &&
    dockIds.includes('dsh-file-session.hero'),
  JSON.stringify(dockIds),
)
check('registers exactly the three seats', both.registrations.length === 3, String(both.registrations.length))

const composer = run('composer')
const composerText = JSON.stringify(render(composer, 'conversation.composer.dock', { sessionId: 's1', seat: 'composer' }))
// Once a Session has a conversation, creating the file is the Agent's job there too: the row
// offers the picker and nothing else.
check('the row offers picking a file', composerText.includes('选择文件'), composerText.slice(0, 200))
check('and offers no create control', !composerText.includes('新建文件') && !composerText.includes('aria-haspopup'), composerText.slice(0, 200))

const heroBlank = run('hero-blank', { blank: true })
check(
  'a blank Session renders the entry above the composer',
  render(heroBlank, 'conversation.input.dock', { sessionId: 's1', seat: 'hero' }) !== null,
)

const heroText = JSON.stringify(render(heroBlank, 'conversation.input.dock', { sessionId: 's1', seat: 'hero' }))
// The blank layout is chat-first: creating the file is something the Agent does, so the row
// above the card carries a line of guidance rather than a button.
check('the blank layout says what to type', heroText.includes('在聊天输入框输入「新建文件」'), heroText.slice(0, 220))
check('and offers no button at all', !heroText.includes('"type":"button"'), heroText.slice(0, 220))

// The blank layout projects no row below the card — the conversation dock belongs to the other
// layout — so the picker lives in the composer's own tool row, beside `+`.
const rowText = JSON.stringify(
  renderSeat(heroBlank, 'dsh-file-session.row', { sessionId: 's1', seat: 'row' }),
)
check('the picker sits in the composer tool row in the blank layout', rowText.includes('选择文件'), rowText.slice(0, 220))
check('and that seat offers no create control', !rowText.includes('新建文件'), rowText.slice(0, 220))

const heroBound = run('hero-bound', { blank: true, storage: JSON.stringify({ s1: { path: 'docs/plan.md', cwd: '/repo', mode: 'lock' } }) })
check(
  'a bound blank Session shows the chip in the hero seat too',
  JSON.stringify(render(heroBound, 'conversation.input.dock', { sessionId: 's1', seat: 'hero' })).includes('plan.md'),
)
check(
  'and the tool-row picker stands down once bound',
  renderSeat(heroBound, 'dsh-file-session.row', { sessionId: 's1', seat: 'row' }) === null,
)
check(
  'the 文件会话 prefix label is gone from both seats',
  !heroText.includes('文件会话：') && !composerText.includes('文件会话：'),
)

const heroUsed = run('hero-used', { blank: false })
check(
  'a used Session renders nothing in the hero seat',
  render(heroUsed, 'conversation.input.dock', { sessionId: 's1', seat: 'hero' }) === null,
)
check(
  'and the used Session is served by the composer seat instead',
  renderSeat(heroUsed, 'dsh-file-session.row', { sessionId: 's1', seat: 'row' }) === null &&
    renderSeat(heroUsed, 'dsh-file-session.composer', { sessionId: 's1', seat: 'composer' }) !== null,
)

const composerBlank = run('composer-blank', { blank: true })
check(
  'a blank Session renders nothing in the composer seat',
  render(composerBlank, 'conversation.composer.dock', { sessionId: 's1', seat: 'composer' }) === null,
)

const other = run('other-preset', { preset: 'standard' })
check(
  'a non-focus Session renders nothing',
  render(other, 'conversation.composer.dock', { sessionId: 's1', seat: 'composer' }) === null,
)

const bound = run('bound', { storage: JSON.stringify({ s1: { path: 'docs/plan.md', cwd: '/repo', mode: 'lock' } }) })
const boundText = JSON.stringify(render(bound, 'conversation.composer.dock', { sessionId: 's1', seat: 'composer' }))
check('a bound Session renders the chip', boundText.includes('plan.md'), boundText.slice(0, 140))

// The composer dock is one narrow row shared with the usage meter. A chip that could not
// shrink and could not wrap put its own state on two lines and squeezed the file name away,
// which is exactly what it looked like before: the chip is now one shrinkable, unwrappable
// line, and the binding state moved into the tooltip.
{
  const chip = findByKey(
    render(bound, 'conversation.composer.dock', { sessionId: 's1', seat: 'composer' }),
    'chip',
  )
  check('the chip can shrink inside the dock row', chip?.props?.style?.flex === '0 1 auto' && chip?.props?.style?.minWidth === 0, JSON.stringify(chip?.props?.style))
  check('the chip never wraps', chip?.props?.style?.whiteSpace === 'nowrap')
  check('the chip names the file and nothing else', textOf(chip) === '📄 plan.md', textOf(chip))
  check('and states the binding in its tooltip', String(chip?.props?.title).includes('已绑定') && String(chip?.props?.title).includes('docs/plan.md'), String(chip?.props?.title))
}

// The layout decides the side, so exactly one seat must render for every layout
// state — that invariant is what removes the chip's jump between the two.
const layoutStates = [
  ['a fresh blank Session', { session: { blank: true, awaitingFirstTurn: false, running: false, promptAttempted: false, openState: 'open' }, conversation: { activeTargets: new Set() }, summaryBlank: true }, 'hero'],
  ['a blank Session before the list loads', { session: { blank: true, awaitingFirstTurn: false, running: false, promptAttempted: false, openState: 'open' }, conversation: { activeTargets: new Set() }, summaryBlank: undefined }, 'hero'],
  ['a Session still loading', { session: { blank: true, awaitingFirstTurn: false, running: false, promptAttempted: false, openState: 'loading' }, conversation: { activeTargets: new Set() }, summaryBlank: undefined }, 'composer'],
  ['a Session with a first prompt in flight', { session: { blank: true, awaitingFirstTurn: true, running: false, promptAttempted: true, openState: 'open' }, conversation: { activeTargets: new Set() }, summaryBlank: true }, 'composer'],
  ['a Session with an active target', { session: { blank: true, awaitingFirstTurn: false, running: false, promptAttempted: false, openState: 'open' }, conversation: { activeTargets: new Set(['x']) }, summaryBlank: true }, 'composer'],
  ['a running Session', { session: { blank: true, awaitingFirstTurn: false, running: true, promptAttempted: false, openState: 'open' }, conversation: { activeTargets: new Set() }, summaryBlank: true }, 'composer'],
  ['a Session with history', { session: { blank: false, awaitingFirstTurn: false, running: false, promptAttempted: false, openState: 'open' }, conversation: { activeTargets: new Set() }, summaryBlank: false }, 'composer'],
]
for (const [label, layout, expected] of layoutStates) {
  const harness = run(label, { layout })
  const heroRenders = render(harness, 'conversation.input.dock', harness.propsFor('hero')) !== null
  const composerRenders = render(harness, 'conversation.composer.dock', harness.propsFor('composer')) !== null
  check(`${label}: exactly one seat renders`, heroRenders !== composerRenders, `hero=${heroRenders} composer=${composerRenders}`)
  check(`${label}: on the ${expected} side`, (expected === 'hero') === heroRenders, `hero=${heroRenders}`)
}

// Creating a file must also start the Session: a blank Session is hidden from the
// workspace list, so an unstarted Session would orphan the file it just produced.
const findButton = (node, label) => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findButton(item, label)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  // Labelled by its rendered text, which the markup is free to wrap in spans.
  if (node.type === 'button' && textOf(node).includes(label)) {
    return node
  }
  for (const child of node.children ?? []) {
    const hit = findButton(child, label)
    if (hit !== undefined) return hit
  }
  return undefined
}

// The picker is the only way a user binds an existing file, and it had no test at all — which
// is exactly how a deleted `pick` reached a syntax-clean build. Drive the real input.
const flow = run('pick-flow', { blank: false, hostPaths: () => '/repo/docs/plan.md' })
const tree = render(flow, 'conversation.composer.dock', { sessionId: 's1', seat: 'composer' })
const fileInput = findByKey(tree, 'input')
check('the row carries a file input', fileInput !== undefined)
if (fileInput !== undefined) {
  fileInput.props.onChange({ target: { files: [{ name: 'plan.md' }], value: '' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const bindPost = flow.posted.find((body) => body.path === '/repo/docs/plan.md')
  check('picking a file binds exactly that path', bindPost?.sessionId === 's1', JSON.stringify(flow.posted))
  check('binding starts the Session', flow.prompts.length === 1, JSON.stringify(flow.prompts))
  const first = flow.prompts[0]
  check('the turn is queued', first?.mode === 'queue', String(first?.mode))
  check(
    'and it names the file that was bound',
    typeof first?.content?.[0]?.text === 'string' && first.content[0].text.includes('plan.md'),
    JSON.stringify(first?.content),
  )
}

// Without the desktop preload there is no way to name the file: say so instead of doing nothing.
const noPaths = run('pick-no-paths', { blank: false, hostPaths: null })
const noPathsTree = render(noPaths, 'conversation.composer.dock', { sessionId: 's1', seat: 'composer' })
findByKey(noPathsTree, 'input').props.onChange({ target: { files: [{ name: 'plan.md' }], value: '' } })
await new Promise((resolve) => setTimeout(resolve, 0))
check('a pick without a readable path posts nothing', noPaths.posted.length === 0, JSON.stringify(noPaths.posted))

console.log(process.exitCode === 1 ? 'FAILURES above' : 'all browser-half tests passed')
