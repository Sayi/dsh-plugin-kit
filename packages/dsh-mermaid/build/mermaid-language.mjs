/**
 * A compact Mermaid grammar for highlight.js.
 *
 * Shiki ships no Mermaid grammar (checked against the grammar list inside the installed
 * Harness: `mermaid` appears only inside the AsciiDoc grammar), and the dedicated npm
 * packages for it are published at version `0.0.0`, which is not something to depend on. So
 * the grammar lives here: the diagram declarations, the structural keywords, the arrows that
 * carry a diagram's meaning, labels, directives and comments — enough for the code view to be
 * readable, and small enough to keep honest.
 *
 * Exported as a highlight.js language definition, registered by `mermaid-entry.mjs`.
 */

/** The diagram declarations that open a file. */
const DIAGRAMS = [
  'graph',
  'flowchart',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'quadrantChart',
  'requirementDiagram',
  'gitGraph',
  'mindmap',
  'timeline',
  'sankey-beta',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'architecture-beta',
  'C4Context',
  'C4Container',
  'C4Component',
  'C4Dynamic',
  'C4Deployment',
]

/** The words that structure one. */
const STRUCTURE = [
  'subgraph',
  'end',
  'direction',
  'participant',
  'actor',
  'activate',
  'deactivate',
  'autonumber',
  'loop',
  'alt',
  'else',
  'opt',
  'par',
  'and',
  'rect',
  'critical',
  'break',
  'note',
  'over',
  'class',
  'classDef',
  'click',
  'style',
  'linkStyle',
  'section',
  'title',
  'state',
  'namespace',
  'accTitle',
  'accDescr',
]

/** Arrows, plus the class-diagram relation markers. */
const ARROW = /(?:[<>ox|}]{0,2}(?:--+|==+|\.\.+|-\.-+|~~~)[<>ox|{]{0,2}|:::|<<|>>)/

export default function mermaidLanguage(hljs) {
  return {
    name: 'Mermaid',
    aliases: ['mmd'],
    case_insensitive: false,
    keywords: {
      keyword: DIAGRAMS,
      built_in: STRUCTURE,
      literal: ['true', 'false', 'null'],
    },
    contains: [
      // `%%` comments, and the `%%{ ... }%%` directives that configure a diagram.
      { className: 'meta', begin: /%%\{/, end: /\}%%/ },
      hljs.COMMENT('%%', '$'),
      hljs.QUOTE_STRING_MODE,
      hljs.C_NUMBER_MODE,
      { className: 'operator', begin: ARROW },
      { className: 'punctuation', begin: /[[\]{}()|:;,]/ },
    ],
  }
}
