/**
 * A compact D2 grammar for highlight.js.
 *
 * D2 has no published highlight.js grammar (the language's own tooling does the parsing), so the
 * grammar lives here: the declaration keywords, the structural ones, connections, labels, strings,
 * numbers, comments and the braces that carry a diagram's shape. Enough for the code view to be
 * readable, small enough to keep honest.
 */

/** The keywords that declare something. */
const DECLARATIONS = [
  'shape',
  'style',
  'direction',
  'vars',
  'classes',
  'label',
  'tooltip',
  'icon',
  'link',
  'near',
  'constraint',
  'grid-rows',
  'grid-columns',
  'width',
  'height',
  'sql_table',
  'class',
  'sequence_diagram',
  'scenario',
  'steps',
]

/** The values D2 gives those keywords. */
const VALUES = [
  'rectangle',
  'square',
  'page',
  'parallelogram',
  'document',
  'cylinder',
  'queue',
  'package',
  'step',
  'callout',
  'stored_procedure',
  'person',
  'diamond',
  'oval',
  'circle',
  'hexagon',
  'cloud',
  'sequence',
  'class',
  'sql_table',
  'image',
  'text',
  'code',
  'right',
  'left',
  'up',
  'down',
  'bold',
  'italic',
  'underline',
  'filled',
  'multiple',
]

/** Connections: `->`, `<-`, `<->`, `--`, and the ones D2 spells with dots. */
const CONNECTION = /(?:<->|<-|->|--|<\.|\.>|\.\.)/

export default function d2Language(hljs) {
  return {
    name: 'D2',
    aliases: ['d2lang'],
    case_insensitive: false,
    keywords: { keyword: DECLARATIONS, built_in: VALUES, literal: ['true', 'false', 'null'] },
    contains: [
      hljs.COMMENT('#', '$'),
      hljs.QUOTE_STRING_MODE,
      hljs.C_NUMBER_MODE,
      { className: 'operator', begin: CONNECTION },
      // A connection label: `a -> b: |what|`, and D2's `|md|` blocks.
      { className: 'string', begin: /\|/, end: /\|/ },
      { className: 'punctuation', begin: /[{}[\]():;]/ },
    ],
  }
}
