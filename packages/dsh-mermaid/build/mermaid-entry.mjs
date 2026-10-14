/**
 * Entry point of the lazily loaded Mermaid chunk.
 *
 * The right Sidebar gets no renderer registry from the Harness for third-party
 * packages (only the built-in Document Preview renders documents), so this plugin
 * ships its own renderer: this module is bundled by `build/build-chunk.mjs` into
 * `client.mermaid.js`, which the browser half fetches only when a `.mmd` / `.mermaid`
 * diagram tab is mounted.
 *
 * Mermaid keeps its configuration in module state, so initialization is memoized per
 * theme and re-run only when the theme actually changes.
 */

import hljs from 'highlight.js/lib/core'
import mermaid from 'mermaid'
import mermaidLanguage from './mermaid-language.mjs'

hljs.registerLanguage('mermaid', mermaidLanguage)

/** The theme the current configuration was built for, or `undefined` before the first render. */
let configured

/** One incrementing suffix per render: Mermaid requires a DOM id it can own. */
let sequence = 0

/**
 * Render one Mermaid diagram to SVG markup.
 * @param text - the diagram source, exactly as the file holds it.
 * @param theme - `'dark'` or anything else for the light theme.
 * @returns SVG markup, ready to be placed in a container.
 */
export async function renderDiagram(text, theme) {
  const resolved = theme === 'dark' ? 'dark' : 'default'
  if (configured !== resolved) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: resolved,
      fontFamily: 'inherit',
    })
    configured = resolved
  }
  sequence += 1
  const { svg } = await mermaid.render(`dsh-mermaid-diagram-${sequence}`, text)
  return svg
}

/**
 * Highlight Mermaid source for the code view.
 * @param text - the diagram source.
 * @returns HTML with `hljs-*` classes, styled by the plugin on the application's tokens.
 */
export function highlightDiagram(text) {
  return hljs.highlight(text, { language: 'mermaid', ignoreIllegals: true }).value
}

/**
 * Parse a diagram without rendering it, so the tab can distinguish a syntax error from
 * a broken preview.
 * @param text - the diagram source.
 * @returns the error message, or `undefined` when the source parses.
 */
export async function parseDiagram(text) {
  try {
    await mermaid.parse(text)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
