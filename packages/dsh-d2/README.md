# dsh-d2

**D2 (d2lang) preview for DeepSeek Harness**, as a plugin of its own: one right-Sidebar tab type for
`*.d2`, and the chunk that highlights it for the code view. It binds nothing, guards nothing, and
does not know which plugin opened the file.

```text
any plugin ──openResource(dsh-resource://file/…)──▶ sidebar tab registry
                                                      ├── dsh-d2      *.d2
                                                      ├── dsh-mermaid *.mmd *.mermaid
                                                      └── built-in    dsh-resource://file/**
```

## How it renders: the CLI, on the Host

D2 compiles through the `d2` CLI, which is the real implementation — same grammar, same layout
engines, the same errors carrying line and column — instead of a second implementation inside a
browser bundle. So the Host half owns both halves of the job:

| Route | What it does |
| --- | --- |
| `GET /dsh-d2/source` | The file's text and the absolute path this Host resolved, fenced to the Session's workspace |
| `POST /dsh-d2/render` | Compiles one source with `d2 --timeout=20 -` (source on stdin, SVG on stdout) |
| `GET/POST /dsh-d2/diag` | The browser half's one-shot report: booleans and type names only |

Two details the CLI decides, both measured rather than assumed: it prints a *success* line to
stderr, so the **exit code** is what tells success from failure; and a compile error comes back as
its own message with line and column, which the preview shows beside the source.

The binary is `d2` on `PATH`, or `DSH_D2_BIN` when a deployment keeps it elsewhere. When it is
missing the preview says so — `未找到 d2 可执行文件（d2）。安装 D2 后即可预览，例如：brew install d2`
— rather than showing a blank pane; the built-in text preview still renders the file.

## What it does not own

The chrome — header row, view dropdown, reload, pan and zoom, highlighted code view, 「打开方式」
menu, diagnostics — lives in [`dsh-preview-kit`](../dsh-preview-kit/README.md), which this bundle
requires by name. What is left here is what makes it D2: the extension it claims, its read route,
its compile route, and the grammar in its chunk (22 KiB: highlight.js core plus the D2 grammar).

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: the nonce/index injection, the Session cache, the source and render routes, diagnostics |
| `client.js` | Browser half: the tab type and an adapter for the kit (read, compile, highlight) |
| `client.d2.js` | Generated: highlight.js core and the D2 grammar as one self-contained lazy chunk. Rebuild with `pnpm build:chunk` |
| `build/d2-entry.mjs` | What goes into that chunk: `highlightDiagram` |
| `build/d2-language.mjs` | The D2 grammar for highlight.js |
| `build/build-chunk.mjs` | esbuild wrapper emitting the loader's chunk envelope, then bumping `client.js` so the revision follows |
| `cordis.patch.yml` | One row: this bundle |
| `test/host-half.mjs` | 22 assertions, including a **real** compile through the CLI, the missing-binary message, the platform reader and its fallback |
| `test/client-half.mjs` | 24 assertions: the type, the Host compile, a compile error in the view, the code view, the round trip back to the diagram, and the missing-kit fallback |

## Install

Installed from this directory as a bundle, like any other. `index.js` or `cordis.patch.yml`
changes need a Host restart; `client.js` changes reach a running page by themselves.

## Tests

The suites below are written to fail when a fake is more permissive than the platform — see
[the kit's note on test doubles](../dsh-preview-kit/README.md#test-doubles-what-three-bugs-taught),
which is where this preview's own two mistakes are recorded.


```bash
pnpm test        # node test/host-half.mjs && node test/client-half.mjs
```

The Host suite drives the **installed `d2`** rather than a stub of it: a preview whose point is
using the real compiler should be tested against the real compiler.
