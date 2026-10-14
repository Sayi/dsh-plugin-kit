/**
 * `dsh-preview-kit` on its own: the bundle is required by name from a sibling preview, so what
 * matters here is that it loads without a Cordis context, that it is also a valid (inert) plugin,
 * and that the two address helpers every preview leans on behave.
 *
 * The kit's *behaviour* is covered where it is used: `dsh-mermaid`'s suite drives the real body
 * this module builds. This file covers the contract the other bundle depends on.
 *
 *   node test/client-half.mjs
 */
import fs from 'node:fs'

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) process.exitCode = 1
}

let registration
globalThis.window = { __ModuleLoader__: { load: (mod) => { registration = mod } }, addEventListener: () => {} }
new Function(code)()

check('it registers itself as its own bundle', registration?.id === 'dsh-preview-kit', JSON.stringify(registration?.id))

const React = { createElement: () => null, Fragment: 'Fragment' }
const kit = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error(`the kit requires nothing but react, got ${name}`)
})

check('it exports the body factory', typeof kit.createPreviewBody === 'function')
check('and the address helpers a preview needs', typeof kit.parseFileAddress === 'function' && typeof kit.basenameOf === 'function')
check('it is a valid plugin with nothing to register', Array.isArray(kit.inject) && kit.inject.length === 0 && typeof kit.apply === 'function')
check('applying it does nothing at all', kit.apply({}) === undefined)
check('and it needs no services, so it can never hold up the boot', kit.inject.length === 0)

const address = 'dsh-resource://file/session/s1/docs/flow.mmd'
check(
  'the address helper reads a Session file address',
  JSON.stringify(kit.parseFileAddress(address)) === JSON.stringify({ sessionId: 's1', path: 'docs/flow.mmd' }),
  JSON.stringify(kit.parseFileAddress(address)),
)
check('and refuses anything else', kit.parseFileAddress('dsh-resource://other/x') === undefined)
check('the name helper takes the last segment', kit.basenameOf('/a/b/文档.md') === '文档.md', kit.basenameOf('/a/b/文档.md'))

// Every failure mode the kit must survive rather than throw through: no ctx service at all.
const body = kit.createPreviewBody({ get: () => undefined, effect: () => {} }, {
  read: async () => ({ text: 'x' }),
  load: async () => ({}),
  prepare: async () => ({ svg: '<svg/>' }),
  bridge: () => undefined,
})
check('the body factory accepts a minimal adapter', typeof body === 'function')

console.log(process.exitCode === 1 ? 'FAILURES above' : 'all dsh-preview-kit tests passed')
