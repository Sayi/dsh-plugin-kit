/**
 * Browser half of `dsh-d2`, driven against a fake browser: the real module is loaded through the
 * module loader, the kit is resolved by package name the way the page resolves it, and the two
 * Host routes this preview uses are stubbed at the fetch boundary.
 *
 * What is covered here is what makes this preview D2: the type it claims, the Host compile it asks
 * for, how a compile error reaches the view, and that a missing kit leaves it inert rather than
 * failing an activation.
 *
 *   node test/client-half.mjs
 */
import fs from 'node:fs'

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const chunkSource = fs.readFileSync(new URL('../client.d2.js', import.meta.url), 'utf8')
const kitCode = fs.readFileSync(new URL('../../dsh-preview-kit/client.js', import.meta.url), 'utf8')

let loaded
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

const textOf = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
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

const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}
const tick = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function run(label, { missingKit = false, compileFails = false, typeThrows = false } = {}) {
  const renders = []
  const registry = new Map()
  globalThis.window = {
    __ModuleLoader__: {
      load: (mod) => {
        if (mod.id === 'dsh-preview-kit') registry.set(mod.id, mod)
        else loaded = mod
      },
    },
    __DSH_D2__: { nonce: 'n', header: 'x-dsh-d2', route: '/dsh-d2/source', renderRoute: '/dsh-d2/render', diagRoute: '/dsh-d2/diag' },
    addEventListener: () => {},
  }
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/dsh-d2/source')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, text: 'a -> b: hello\n', path: '/repo/flow.d2' }) }
    }
    if (String(url).includes('/dsh-d2/render')) {
      const body = JSON.parse(options.body)
      renders.push(body.source)
      return compileFails
        ? {
            ok: true,
            status: 200,
            json: async () => ({ ok: false, error: 'd2-failed', message: 'err: failed to compile -: -:1:1: connection missing destination' }),
          }
        : { ok: true, status: 200, json: async () => ({ ok: true, svg: '<svg data-d2="1"></svg>' }) }
    }
    if (String(url).includes('/dsh-d2/diag')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (String(url).includes('/open-in-app/apps')) return { ok: true, status: 200, json: async () => ({ apps: [] }) }
    throw new Error(`unexpected fetch(${url})`)
  }

  new Function(kitCode)()
  const kit = registry.get('dsh-preview-kit').factory((name) => {
    if (name === 'react') return React
    throw new Error(`the kit requires nothing but react, got ${name}`)
  })

  const chunk = { highlightDiagram: (text) => `<span class="hljs-keyword">${text}</span>` }
  const requireStub = (name) => {
    if (name === 'react') return React
    if (name === 'dsh-preview-kit') {
      if (missingKit) throw new Error('module not found: dsh-preview-kit')
      return kit
    }
    throw new Error(`unexpected require(${name})`)
  }
  requireStub.async = async () => chunk
  new Function(code)()
  const mod = loaded.factory(requireStub)

  const registrations = []
  const tabTypes = []
  const effects = []
  const ctx = {
    sidebarRightTabs: {
      register: (definition) => {
        if (typeThrows) throw new Error('the tab registry refused')
        tabTypes.push(definition)
        return () => {}
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
        return () => {}
      },
    },
    get: () => undefined,
  }
  mod.apply(ctx)

  const address = 'dsh-resource://file/session/s1/docs/flow.d2'
  const tabProps = (tab = { contentId: address, signal: undefined, navigation: undefined }) => ({
    useTabInfo: () => ({ tab }),
    useResource: () => ({ version: 1, value: { absolutePath: '/repo/docs/flow.d2' } }),
  })
  return { registrations, tabTypes, renders, tabProps, injected: mod.inject }
}

// ---------------------------------------------------------------- what it contributes
{
  const harness = run('type')
  check('declares the services the kit uses', JSON.stringify(harness.injected) === JSON.stringify(['slots', 'sidebarRightTabs', 'remote', 'remote.session']), JSON.stringify(harness.injected))
  check('registers one tab type', harness.tabTypes.length === 1, String(harness.tabTypes.length))
  const type = harness.tabTypes[0]
  check('the type owns the d2 extension', JSON.stringify(type?.patterns) === JSON.stringify(['*.d2']), JSON.stringify(type?.patterns))
  check('it opens a Session file address and nothing else', type?.canOpen('dsh-resource://file/session/s1/flow.d2') === true && type?.canOpen('dsh-resource://other/x.d2') === false)
  check('the tab is titled by the file name', type?.title('dsh-resource://file/session/s1/docs/flow.d2') === 'flow.d2')
  check('one body registers under the type id', harness.registrations.length === 1 && harness.registrations[0].options.key === type.id)
}

// ---------------------------------------------------------------- compiling through the Host
{
  const harness = run('render')
  const view = mount(harness.registrations[0].component, harness.tabProps())
  await tick()
  view.again()
  check('the body asks the Host to compile the source it read', harness.renders[0]?.includes('a -> b'), JSON.stringify(harness.renders))
  check('and renders the SVG that came back', view.text.includes('<svg data-d2='), view.text.slice(0, 200))

  findButton(view.tree, '图表').props.onClick()
  view.again()
  findButton(view.tree, '代码').props.onClick()
  view.again()
  check('the code view highlights through this bundle chunk', view.text.includes('hljs-keyword'), view.text.slice(0, 240))

  // Back to the diagram: the surface unmounts in the code view and has to come back, which is
  // exactly the round trip a blank pane would hide in.
  findButton(view.tree, '代码').props.onClick()
  view.again()
  findButton(view.tree, '图表').props.onClick()
  view.again()
  check('switching back to the diagram shows it again', view.text.includes('<svg data-d2='), view.text.slice(0, 300))
  check('and the canvas is still in the surface', findByKey(view.tree, 'canvas') !== undefined)
}

// ---------------------------------------------------------------- what a compile error looks like
{
  const harness = run('compile-error', { compileFails: true })
  const view = mount(harness.registrations[0].component, harness.tabProps())
  await tick()
  view.again()
  check(
    'a compile error is shown with the CLI message',
    view.text.includes('failed to compile') && view.text.includes('connection missing destination'),
    view.text.slice(0, 260),
  )
  check('and the source is still there to fix', view.text.includes('a -> b'), view.text.slice(0, 260))
}

// ---------------------------------------------------------------- failures that must stay inert
{
  const missing = run('missing-kit', { missingKit: true })
  check('a missing kit registers nothing', missing.tabTypes.length === 0 && missing.registrations.length === 0)
  const refused = run('refused-type', { typeThrows: true })
  check('a refused registration does not throw out of apply', refused.tabTypes.length === 0 && refused.injected !== undefined)
}

// ---------------------------------------------------------------- the shipped chunk
{
  let registration
  globalThis.window = { __ModuleLoader__: { load: (mod) => { registration = mod } }, addEventListener: () => {} }
  new Function(chunkSource)()
  check('the chunk registers itself for this bundle', registration?.id === 'dsh-d2' && registration?.chunk === 'client.d2.js', JSON.stringify({ id: registration?.id, chunk: registration?.chunk }))
  check('it is self-contained', !/\bimport\s*\(/.test(chunkSource))
  const chunk = registration.factory(() => {
    throw new Error('the chunk must not require anything')
  })
  check('it exports the highlighter', typeof chunk?.highlightDiagram === 'function', JSON.stringify(Object.keys(chunk ?? {})))
  const highlighted = chunk.highlightDiagram('# comment\na -> b: |label|')
  check('the grammar marks a connection', highlighted.includes('hljs-operator'), highlighted.slice(0, 140))
  check('the grammar marks a comment', highlighted.includes('hljs-comment'))
  check('the grammar marks a label', highlighted.includes('hljs-string'))
  check('the highlighter escapes markup in the source', chunk.highlightDiagram('a: "<img src=x>"').includes('&lt;img'))
}

console.log(process.exitCode === 1 ? 'FAILURES above' : 'all dsh-d2 browser tests passed')
