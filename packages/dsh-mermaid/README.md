# dsh-mermaid

**Mermaid preview for DeepSeek Harness**, as a plugin of its own. It contributes one
right-Sidebar tab type for `*.mmd` and `*.mermaid` and the lazy chunk that renders and
highlights them. It binds nothing, guards nothing, and does not know which plugin opened the
file.

```text
any plugin ──openResource(dsh-resource://file/…)──▶ sidebar tab registry
                                                      ├── dsh-mermaid          *.mmd  *.mermaid
                                                      └── built-in preview     dsh-resource://file/**
```

## Why it is separate

A preview is a **tab type**, and the sidebar's registry is the seam: whoever registers the
patterns renders the file, and the file plugin only has to open the address. Keeping the
renderer inside `dsh-file-session` would have meant:

- a 5 MiB chunk, a bundler toolchain and three dev dependencies in a plugin about *binding one
  file*;
- `.mmd` files previewable only in Sessions that also happened to be file-session Sessions;
- no way to swap in a different renderer.

So this package owns the preview, and `dsh-file-session` no longer mentions a format. The two
are independent: install either alone. Without a preview plugin for those extensions the
built-in Document Preview renders the file as text — the same fallback every other file gets —
and this plugin can be replaced by registering the two extensions first, because a type in the
default `extension` band outranks the built-in `fallback` band
(`RANKS = { extension: 3, builtin: 2, fallback: 1 }`).

The `新建 Mermaid` action still lives in `dsh-file-session`: *creating* a `.mmd` is a file
concern and needs no renderer, which is the point of the split.

## What it does

- **One tab type** — `ctx.sidebarRightTabs.register({ id: 'dsh-mermaid/diagram', kind,
  patterns: ['*.mmd', '*.mermaid'], canOpen, title })`, and its body at
  `sidebar.right.pane.tab`. Both registrations sit inside this plugin's own `ctx.effect`, so a
  re-materialization (an HMR reload on a running page) disposes its predecessor instead of
  colliding with it.
- **Its own reader.** The body fetches the file's text from this bundle's Host route
  (`GET /dsh-mermaid/source`, nonce-gated, size-capped, contained in the Session's workspace).
  The alternative — injecting the client's `remote.workspaceFiles` — would make an optional
  preview a *hard* dependency of the entry's activation, and an unsatisfied one keeps the entry
  inactive, which the desktop shell treats as a failed web boot. The route resolves the
  workspace root itself and ignores anything the caller claims: containment checked against a
  caller-chosen root would prove nothing.
- **A view dropdown, pan and zoom.** `图表 ▾` switches between the rendered diagram and the
  file's highlighted source; the diagram pans by drag, `Shift`+wheel or the arrow keys, and
  zooms on the wheel, a trackpad pinch, `⌘`/`Ctrl`+wheel, `+`/`-`, or a ratio from the
  floating control (25%–400%, with 适应宽度). The chrome — a 38px header row, the path on the
  left, 28px tool buttons, the reload control, and the menu card — is copied from the built-in
  preview and the `Menu` primitive it renders, under this bundle's own class prefix on the same
  `--dsw-*` tokens, because `@deepseek-ai/dsh-client-ui-primitives` ships no runtime bundle to
  require.
- **Highlighted source.** Nothing shipped highlights Mermaid: Shiki — what the built-in code
  preview uses — has no Mermaid grammar, and the two npm packages that do are published at
  `0.0.0`. So `build/mermaid-language.mjs` is a compact grammar for highlight.js (declarations,
  structural keywords, arrows, strings, numbers, directives, comments) and
  `highlight.js/lib/core` rides inside the chunk the tab already fetches (+22 KiB).
- **One lazy chunk.** `client.mermaid.js` — Mermaid 12, highlight.js core and the grammar —
  is fetched by `require.async('./client.mermaid.js')` the first time a diagram tab mounts, and
  never appears in the startup bundle.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: the nonce/index injection, the Session cache and the source route |
| `client.js` | Browser half: the tab type, the body, the view dropdown, pan and zoom |
| `client.mermaid.js` | Generated: the renderer and highlighter as one self-contained lazy chunk (5160 KiB, committed so installing needs no build). Rebuild with `pnpm build:chunk` |
| `build/mermaid-entry.mjs` | What goes into that chunk: configuration, `renderDiagram`, `parseDiagram`, `highlightDiagram` |
| `build/mermaid-language.mjs` | The Mermaid grammar for highlight.js |
| `build/build-chunk.mjs` | esbuild wrapper emitting the loader's chunk envelope, then bumping `client.js` so the revision follows |
| `cordis.patch.yml` | One row: this bundle. No preset, no tools, no Agent behaviour |
| `test/host-half.mjs` | 8 assertions: the route, its nonce, its parameters, its fence and its failures |
| `test/client-half.mjs` | 37 assertions: the type, the body, the read, the two views, zoom and pan, the reload of a second apply, opening the file elsewhere, and the shipped chunk's grammar |

## Install

Installed from this directory as a bundle, in the same profile as any other:

```bash
# the profile gets `dsh-mermaid` in dsh.profile.bundles; the row comes from cordis.patch.yml
```

`index.js` or `cordis.patch.yml` changes need a Host restart; `client.js` changes reach a
running page by themselves (the client HMR receiver re-materializes the bundle). A rebuild of
the chunk alone also needs the page to remount the tab, because the browser memoizes the
chunk it already fetched.

## Tests

The suites below are written to fail when a fake is more permissive than the platform — see
[the kit's note on test doubles](../dsh-preview-kit/README.md#test-doubles-what-three-bugs-taught),
which is where this preview's own two mistakes are recorded.


```bash
pnpm test        # node test/host-half.mjs && node test/client-half.mjs
```

The grammar is driven for real: the chunk is materialized from the file that ships and asked
to highlight declarations, arrows, comments and strings, and to **escape markup in the source**
— the last one matters because the highlighted HTML is the one place this plugin injects.
