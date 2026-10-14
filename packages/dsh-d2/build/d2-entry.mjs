/**
 * The chunk `dsh-d2` loads lazily: highlight.js core and the D2 grammar.
 *
 * D2's *rendering* is not here on purpose — the Host compiles through the `d2` CLI, so this chunk
 * is only what the code view needs, which keeps it small (and keeps the browser from carrying a
 * second implementation of the language).
 */
import hljs from 'highlight.js/lib/core'
import d2Language from './d2-language.mjs'

hljs.registerLanguage('d2', d2Language)

/**
 * Highlight D2 source for the code view.
 * @param text - the diagram source.
 * @returns HTML with `hljs-*` classes, styled by the preview kit on the application's tokens.
 */
export function highlightDiagram(text) {
  return hljs.highlight(text, { language: 'd2', ignoreIllegals: true }).value
}
