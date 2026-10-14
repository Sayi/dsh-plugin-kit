/**
 * Browser half of `dsh-mermaid`, run against a fake browser: it loads the real module through
 * the module loader, applies it to a fake Cordis context, and drives the tab type, the body
 * and the shipped chunk — including the grammar, which is this bundle's own.
 *
 *   node test/client-half.mjs
 */
import fs from 'node:fs'

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const chunkSource = fs.readFileSync(new URL('../client.mermaid.js', import.meta.url), 'utf8')
const kitCode = fs.readFileSync(new URL('../../dsh-preview-kit/client.js', import.meta.url), 'utf8')

let loaded
/** A miniature React: real state, dependency-checked effects, re-render passes. */
let current
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
    const same =
      slot.deps !== undefined &&
      deps !== undefined &&
      slot.deps.length === deps.length &&
      slot.deps.every((value, index) => Object.is(value, deps[index]))
    if (same) return
    slot.deps = deps
    slot.fn = fn
  },
  useRef: () => {
    const slot = current.hook()
    if (!('value' in slot)) slot.value = { current: null }
    return slot.value
  },
  // The kit keeps its ref callback stable, which is what stops React detaching the node on every
  // render; the harness only has to hand the function back.
  useCallback: (fn) => fn,
}

function mount(Component, props, passes = 6) {
  let hooks = []
  const run = () => {
    let cursor = 0
    current = { hook: () => (hooks[cursor++] ??= {}), dirty: false }
    const tree = Component(props)
    for (const slot of hooks) {
      if (slot.fn === undefined) continue
      const fn = slot.fn
      slot.fn = undefined
      fn()
    }
    return tree
  }
  let tree = run()
  for (let pass = 0; pass < passes; pass += 1) {
    if (!current.dirty) break
    tree = run()
  }
  return {
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
  }
}

/** The text a node renders, however deeply it nests. */
const textOf = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}
const findButton = (node, label) => {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findButton(item, label)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (node.type === 'button' && textOf(node).includes(label)) return node
  for (const child of node.children ?? []) {
    const hit = findButton(child, label)
    if (hit !== undefined) return hit
  }
  return undefined
}
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

/** Let a chain of awaited effects settle: one microtask turn is not enough for two requests. */
const tick = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

function run(label, { parseError, diagramTypeThrows = false, remote = undefined, missingKit = false } = {}) {
  const sourceUrls = []
  const headers = []
  const renders = []
  // The module loader resolves declared bundles by package name, exactly as the page's does, so
  // the kit is loaded the same way the plugin requires it rather than stubbed.
  const registry = new Map()
  globalThis.window = {
    __ModuleLoader__: {
      load: (mod) => {
        if (mod.id === 'dsh-preview-kit') registry.set(mod.id, mod)
        else loaded = mod
      },
    },
    __DSH_MERMAID__: { nonce: 'n', header: 'x-dsh-mermaid', route: '/dsh-mermaid/source' },
    addEventListener: () => {},
  }
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/dsh-mermaid/source')) {
      sourceUrls.push(String(url))
      headers.push(options?.headers ?? {})
      // The Host resolves the absolute path; the preview uses it for the header actions.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, text: 'graph TD\n  A --> B\n', path: '/host/resolved/flow.mmd' }),
      }
    }
    if (String(url).includes('/open-in-app/apps')) {
      // The platform's own installed-application list, which the association list falls back to.
      return { ok: true, status: 200, json: async () => ({ apps: ['cursor', 'vscode', 'xcode'] }) }
    }
    throw new Error(`unexpected fetch(${url})`)
  }
  new Function(kitCode)()
  const requireForKit = (name) => {
    if (name === 'react') return React
    throw new Error(`the kit requires nothing but react, got ${name}`)
  }
  const kit = registry.get('dsh-preview-kit').factory(requireForKit)
  new Function(code)()
  const chunk = {
    highlightDiagram: (text) => `<span class="hljs-keyword">${text}</span>`,
    parseDiagram: async () => parseError,
    renderDiagram: async (text, scheme) => {
      renders.push({ text, scheme })
      return `<svg data-scheme="${scheme}"></svg>`
    },
  }
  // Only `react`, plus the lazy chunk through `require.async` — nothing else is requirable.
  const requireStub = (name) => {
    if (name === 'react') return React
    if (name === 'dsh-preview-kit') {
      // A deployment where the kit did not install must not be a failed activation: the preview
      // goes inert instead, which is what this switch exists to prove.
      if (missingKit) throw new Error('module not found: dsh-preview-kit')
      return kit
    }
    throw new Error(`unexpected require(${name})`)
  }
  requireStub.async = async () => chunk
  const mod = loaded.factory(requireStub)

  const registrations = []
  const tabTypes = []
  const effects = []
  const ctx = {
    sidebarRightTabs: {
      register: (definition) => {
        if (diagramTypeThrows) throw new Error('the tab registry refused')
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
      effects.push(typeof dispose === 'function' ? dispose : () => {})
    },
    slots: {
      inject: (_slot, cb) => cb(),
      register: (options, component) => {
        const entry = { options, component }
        registrations.push(entry)
        return () => {
          const index = registrations.indexOf(entry)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    get: (name) => (name === 'remote' ? remote : undefined),
  }
  mod.apply(ctx)

  const address = 'dsh-resource://file/session/s1/docs/flow.mmd'
  const tabProps = (
    tab = { contentId: address, signal: undefined, navigation: undefined },
    { absolutePath = '/repo/docs/flow.mmd' } = {},
    // `null` is "the Host gave no path"; `undefined` would read as "not supplied" and default.
  ) => ({
    useTabInfo: () => ({ tab }),
    // The real snapshot shape: `useResource(...).value` carries the resource's own fields.
    // A stub that puts `absolutePath` at the top level passes while the app shows nothing.
    useResource: () => ({ version: 1, value: absolutePath === null ? {} : { absolutePath } }),
  })
  const reapply = () => {
    for (const dispose of effects.splice(0)) dispose()
    mod.apply(ctx)
  }
  return { registrations, tabTypes, sourceUrls, headers, renders, tabProps, reapply, remote, injected: mod.inject }
}

// ---------------------------------------------------------------- a missing kit is not a boot failure
{
  const broken = run('missing-kit', { missingKit: true })
  // A missing kit used to leave the preview silently inert. It now claims the extension and
  // registers a body that names the package and the spec to install: a silent failure cannot be
  // told apart from "the plugin does not work".
  check(
    'a missing kit still claims the extension',
    broken.tabTypes.length === 1 && broken.tabTypes[0].canOpen('dsh-resource://file/session/s1/x.mmd') === true,
    JSON.stringify(broken.tabTypes.map((type) => type.patterns)),
  )
  check('and registers a body that explains', broken.registrations.length === 1)
  if (broken.registrations.length === 1) {
    const kitless = mount(broken.registrations[0].component, broken.tabProps())
    check(
      'which names the package and how to install it',
      kitless.text.includes('dsh-preview-kit') && kitless.text.includes('github:Sayi/dsh-plugin-kit'),
      kitless.text.slice(0, 240),
    )
  }
  check('and does not throw out of apply', broken.injected !== undefined)
}

// ---------------------------------------------------------------- what it contributes
{
  const harness = run('type')
  // A declared service is a hard dependency of activation: it must be a subset of the services
  // the running composition is already known to satisfy (the file plugin activates on exactly
  // `slots`, `sessions`, `sidebarRight` and `sidebarRightTabs` today), or the entry would stay
  // inactive and the desktop shell would call that a failed web boot.
  check(
    'declares only the services it uses',
    JSON.stringify(harness.injected) === JSON.stringify(['slots', 'sidebarRightTabs', 'remote', 'remote.session']),
    JSON.stringify(harness.injected),
  )
  // `remote` is proven by the running app: the shipped preview and its 「打开方式」 control both
  // read `remote.session` here and both work, so the service is provided in this composition.
  // `remote.session` too: the shipped 「打开方式」 control reads that exact namespace here and
  // works, so both the service and the namespace are provided in this composition.
  const proven = ['slots', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.session']
  check('every declared service is one the composition satisfies', harness.injected.every((name) => proven.includes(name)), JSON.stringify(harness.injected))
  check('registers one tab type', harness.tabTypes.length === 1, String(harness.tabTypes.length))
  const type = harness.tabTypes[0]
  check('the type owns both Mermaid extensions', JSON.stringify(type?.patterns) === JSON.stringify(['*.mmd', '*.mermaid']), JSON.stringify(type?.patterns))
  check('and sits in the extension band', type?.priority === undefined)
  check(
    'it opens a Session file address and nothing else',
    type?.canOpen('dsh-resource://file/session/s1/docs/flow.mmd') === true &&
      type?.canOpen('dsh-resource://file/session/s1/docs/flow.md') === true &&
      type?.canOpen('dsh-resource://other/thing.mmd') === false,
  )
  check('the tab is titled by the file name', type?.title('dsh-resource://file/session/s1/docs/flow.mmd') === 'flow.mmd')
  check('it registers exactly one body, under the type id', harness.registrations.length === 1 && harness.registrations[0].options.key === type.id)

  // The failure mode this guards: a registration held by anyone but this plugin's own effect
  // outlives its instance, so the next materialization throws on the duplicate id.
  harness.reapply()
  check('a second apply still leaves one type and one body', harness.tabTypes.length === 1 && harness.registrations.length === 1, `${harness.tabTypes.length}/${harness.registrations.length}`)
}

{
  // A refused registration must not fail activation: a preview may not stop the boot.
  const broken = run('refused', { diagramTypeThrows: true })
  check('a refused type leaves the plugin alive', broken.tabTypes.length === 0 && broken.registrations.length === 0)
}

// ---------------------------------------------------------------- the body
{
  const harness = run('body')
  const view = mount(harness.registrations[0].component, harness.tabProps())
  await new Promise((resolve) => setTimeout(resolve, 0))
  view.again()
  check('the body reads through its own Host route', harness.sourceUrls[0]?.startsWith('/dsh-mermaid/source?sessionId=s1&path=docs%2Fflow.mmd'), harness.sourceUrls[0])
  check('with its own nonce header', harness.headers[0]?.['x-dsh-mermaid'] === 'n', JSON.stringify(harness.headers[0]))
  check('and renders the diagram', harness.renders.length === 1 && view.text.includes('<svg data-scheme='), view.text.slice(0, 160))
  check('with both views offered', view.text.includes('图表') && view.text.includes('aria-haspopup'))

  // The view control is a dropdown, as the built-in Markdown renderer's is: the code view is
  // one of its items, not a control of its own.
  findButton(view.tree, '图表').props.onClick()
  view.again()
  const code = findButton(view.tree, '代码')
  check('the dropdown offers the code view', code !== undefined)
  if (code !== undefined) {
    code.props.onClick()
    view.again()
    check('and renders highlighted source', view.text.includes('hljs-keyword') && view.text.includes('graph TD'), view.text.slice(0, 220))
  }
}

// ---------------------------------------------------------------- opening elsewhere
{
  const session = {
    canOpenWorkspacePath: async () => ({ ok: true, value: true }),
    associated: [
      { id: 'workbuddy', name: 'WorkBuddy.app', default: true, icon: null },
      { id: 'xcode', name: 'Xcode.app', default: false, icon: null },
      { id: '', name: 'no usable id', default: false, icon: null },
    ],
    workspacePathApplications: async () => ({ ok: true, value: session.associated }),
    opened: [],
    async openWorkspacePath(request) {
      this.opened.push(request)
      return { ok: true }
    },
  }
  const harness = run('open-with', { remote: { session } })
  const view = mount(harness.registrations[0].component, harness.tabProps())
  await tick()
  view.again()
  const trigger = findByLabel(view.tree, '打开方式')
  check('the header offers opening the file elsewhere', trigger !== undefined, view.text.slice(0, 200))
  check(
    'and marked with its icon, not its name',
    JSON.stringify(trigger?.children ?? []).includes('"type":"img"'),
    JSON.stringify(trigger?.children)?.slice(0, 200),
  )

  trigger?.props.onClick()
  view.again()
  check(
    'the menu lists the applications, dropping a malformed entry',
    view.text.includes('WorkBuddy.app（默认）') && view.text.includes('Xcode.app') && !view.text.includes('no usable id'),
    view.text.slice(0, 320),
  )
  check('and offers revealing the file', view.text.includes('显示文件位置'))

  // The reveal row first, then an application: each click closes the menu by design.
  findButton(view.tree, '显示文件位置').props.onClick()
  await tick()
  check('revealing asks for the reveal action', session.opened[0]?.action === 'reveal', JSON.stringify(session.opened))

  // A second mount for the application row: each click closes the menu by design, and re-opening
  // it inside one mount only tests the test.
  const appSession = {
    canOpenWorkspacePath: session.canOpenWorkspacePath,
    workspacePathApplications: session.workspacePathApplications,
    opened: [],
    openWorkspacePath: session.openWorkspacePath,
  }
  const second = run('open-with-app', { remote: { session: appSession } })
  const secondView = mount(second.registrations[0].component, second.tabProps())
  await tick()
  secondView.again()
  findByLabel(secondView.tree, '打开方式').props.onClick()
  secondView.again()
  findButton(secondView.tree, 'Xcode.app').props.onClick()
  await tick()
  check(
    'choosing an application opens that path with it',
    JSON.stringify(appSession.opened) === JSON.stringify([{ path: '/repo/docs/flow.mmd', application: 'xcode' }]),
    JSON.stringify(appSession.opened),
  )

  // A type macOS associates with nothing — `.mmd` — gets an empty association list, and the
  // platform's own installed-application list is what stands in for it.
  {
    const empty = {
      canOpenWorkspacePath: async () => ({ ok: true, value: true }),
      associated: [],
      workspacePathApplications: async () => ({ ok: true, value: [] }),
      opened: [],
      openWorkspacePath: async (request) => {
        empty.opened.push(request)
        return { ok: true }
      },
    }
    const fallback = run('open-with-installed', { remote: { session: empty } })
    const view = mount(fallback.registrations[0].component, fallback.tabProps())
    await tick()
    view.again()
    findByLabel(view.tree, '打开方式')?.props.onClick()
    view.again()
    check(
      'an unassociated type falls back to the installed applications',
      view.text.includes('Cursor') && view.text.includes('Visual Studio Code') && view.text.includes('Xcode'),
      view.text.slice(0, 260),
    )
    check('and still offers revealing the file', view.text.includes('显示文件位置'))
    check(
      'an installed application takes its icon from the platform route',
      view.text.includes('/open-in-app/icon/cursor'),
      view.text.slice(0, 300),
    )
  }

  // No Remote namespace, or one that says the desktop cannot open paths: no control at all.
  const noRemote = run('open-with-none')
  const noRemoteView = mount(noRemote.registrations[0].component, noRemote.tabProps())
  await tick()
  noRemoteView.again()
  check('without the Remote namespace there is no control', findByLabel(noRemoteView.tree, '打开方式') === undefined)

  const refused = run('open-with-refused', {
    remote: { session: { ...session, canOpenWorkspacePath: async () => ({ ok: true, value: false }) } },
  })
  const refusedView = mount(refused.registrations[0].component, refused.tabProps())
  await tick()
  refusedView.again()
  check('and none when the desktop cannot open paths', findByLabel(refusedView.tree, '打开方式') === undefined)
}

// ---------------------------------------------------------------- zoom and pan
{
  const harness = run('surface')
  const view = mount(harness.registrations[0].component, harness.tabProps())
  await new Promise((resolve) => setTimeout(resolve, 0))
  view.again()
  const percentOf = () => Number(String(findByKey(view.tree, 'zoom-value').children[0]).replace('%', ''))
  const start = percentOf()
  findByLabel(view.tree, '放大').props.onClick()
  view.again()
  check('zoom in steps the percentage', percentOf() > start, `${start}% -> ${percentOf()}%`)
  findByLabel(view.tree, '缩小').props.onClick()
  view.again()
  check('zoom out steps it back', percentOf() === start, `${percentOf()}%`)

  const surface = findByKey(view.tree, 'surface')
  check('the surface pans with the keyboard', typeof surface.props.onKeyDown === 'function')
  const offsetOf = (transform) => (/translate\((-?\d+)px, (-?\d+)px\)/.exec(transform) ?? []).slice(1).map(Number)
  const before = offsetOf(findByKey(view.tree, 'canvas').props.style.transform)
  surface.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  view.again()
  const after = offsetOf(findByKey(view.tree, 'canvas').props.style.transform)
  check('an arrow key pans by one step', Math.abs(after[0] - before[0] - 24) <= 1, `${before} -> ${after}`)

  // A press that never moves must not capture: capture retargets the click, which is how the
  // controls inside the surface stopped responding once.
  const calls = { capture: 0 }
  const target = { setPointerCapture: () => { calls.capture += 1 }, releasePointerCapture: () => {}, focus: () => {} }
  surface.props.onPointerDown({ button: 0, clientX: 5, clientY: 5, pointerId: 1, currentTarget: target })
  surface.props.onPointerUp({ pointerId: 1, currentTarget: target })
  view.again()
  check('a plain click does not capture the pointer', calls.capture === 0)
}

// ---------------------------------------------------------------- the shipped chunk
{
  let registration
  globalThis.window = { __ModuleLoader__: { load: (mod) => { registration = mod } }, addEventListener: () => {} }
  new Function(chunkSource)()
  check('the chunk registers itself for this bundle', registration?.id === 'dsh-mermaid' && registration?.chunk === 'client.mermaid.js', JSON.stringify({ id: registration?.id, chunk: registration?.chunk }))
  check('it is self-contained', !/\bimport\s*\(/.test(chunkSource))
  const chunk = registration.factory(() => {
    throw new Error('the chunk must not require anything')
  })
  check(
    'it exports the renderer and highlighter',
    ['renderDiagram', 'parseDiagram', 'highlightDiagram'].every((name) => typeof chunk?.[name] === 'function'),
    JSON.stringify(Object.keys(chunk ?? {})),
  )
  const highlighted = chunk.highlightDiagram('%% note\nsequenceDiagram\n  A->>B: hi')
  check('the grammar marks the declaration', highlighted.includes('hljs-keyword'), highlighted.slice(0, 120))
  check('the grammar marks arrows', chunk.highlightDiagram('graph TD\n  A-->B').includes('hljs-operator'))
  check('the grammar marks comments', highlighted.includes('hljs-comment'))
  check('the grammar marks strings', chunk.highlightDiagram('A["label"]').includes('hljs-string'))
  check(
    'the highlighter escapes markup in the source',
    chunk.highlightDiagram('A["<img src=x onerror=1>"]').includes('&lt;img'),
  )
}

console.log(process.exitCode === 1 ? 'FAILURES above' : 'all dsh-mermaid browser tests passed')
