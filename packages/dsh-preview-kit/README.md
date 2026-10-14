# dsh-preview-kit

**The chrome every diagram-ish preview needs, extracted once.** `dsh-mermaid` grew a header row,
a view dropdown, a reload control, an 「打开方式」 menu, a pan/zoom surface, a highlighted code
view and a Host diagnostic route; this bundle is that, so the next preview is not a second copy of
it.

```text
dsh-mermaid ─┐
             ├─ require('dsh-preview-kit') ─→ createPreviewBody(ctx, adapter)
dsh-d2      ─┘                                   ↑ what to read, render and highlight
```

## What it owns

| Piece | Detail |
| --- | --- |
| Header | 38px row, path on the left, controls on the right, hairline under it |
| View dropdown | The Menu primitive's card and cells, copied on this bundle's class prefix |
| Reload | Re-reads the file on demand |
| 「打开方式」 | `remote.session.canOpenWorkspacePath` / `workspacePathApplications` / `openWorkspacePath`, falling back to the platform's installed-application list when the file's type is associated with nothing (`.mmd`), with the same icons the shipped control uses |
| Surface | Drag, `Shift`+wheel and arrow-key panning; wheel, pinch and `+`/`-` zoom; a ratio menu, 25%–400%, with 适应宽度 |
| Code view | The source, highlighted by the adapter's own grammar |
| Diagnostics | A one-shot report to the plugin's route: booleans and type names only, never a path or a secret |
| Addresses | `parseFileAddress`, `basenameOf` |

## What a preview supplies

```js
const kit = require('dsh-preview-kit')          // resolved by package name, like any bundle
kit.createPreviewBody(ctx, {
  read(file, signal),                            // → { text, path } through the plugin's own route
  load(),                                        // → the lazily fetched chunk
  prepare(source, { scheme, chunk }),            // → { svg } or { invalid }
  highlight(source, chunk),                      // → the code view's HTML, optional
  bridge(),                                      // → { nonce, route, diagRoute } from the page
  diagRoute,                                     // where the diagnostic report goes
})
```

The kit declares **no service and no file of its own**: that is what keeps a preview from being
able to hold up a boot. Its client module is also a valid, empty plugin, so it installs as an
ordinary bundle and can be required by name from a sibling.

## Files

| File | Role |
| --- | --- |
| `client.js` | The kit: styles, icons, the 「打开方式」 reader, the body factory, the address helpers |
| `index.js` | Host half, deliberately inert: a bundle row is imported on the Host too |
| `cordis.patch.yml` | One row: this bundle |
| `test/client-half.mjs` | 10 assertions on the contract a preview depends on |

## Test doubles: what three bugs taught

Every one of these shipped green, because the fake was more permissive than the platform. They are
worth writing down, because each cost a restart to find in the wild.

| The fake said | The platform said | What broke |
| --- | --- | --- |
| `useResource()` returns `{ absolutePath }` | the field is on the snapshot's `value` | the header actions never rendered |
| the tab face hands over `renderSlot` | a third-party body is **not** given it | the slot was never projected |
| `workspaceFiles.read(scope, path)` | `resolvePage(range)` reads `range.offset`, and the scope is an **object** carrying `workspaceRoot` — a Session id fails inside the filesystem backend | the preview showed a TypeError instead of a diagram |

So: fakes here throw when a required argument is missing, and model the shapes the platform
actually uses — a fake that accepts anything proves nothing. The other half of the lesson is the
diagnostic route: every one of these was found by reading `phase`/`hostPath`/`svgLength` from the
running page, not by guessing at the symptom.

The kit's *behaviour* is covered where it is used: `dsh-mermaid`'s 42 assertions drive the real
body this module builds, unchanged from before the extraction — which is what makes the
extraction safe to trust.
