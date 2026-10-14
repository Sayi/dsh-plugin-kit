# DSH Web-client plugin APIs — read-only reconnaissance

Target: **installed** DeepSeek Harness `0.2.1-alpha.2`, profile `desktop` (`/Users/sayi/.dsh/profiles/desktop`).
Evidence base: packages extracted from `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` into `./.asar/`
(package-relative citations), the Electron preload at `./.asar-elect/lib/preload-app.cjs`, the installed plugin
`/Users/sayi/.dsh/profiles/desktop/node_modules/dsh-llm-xai-oauth/`, and the skill templates shipped at
`dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/`.

Every API below was grepped out of a shipped `lib/client.js` / `lib/index.js`. Anything I could not confirm is in
[Unknowns](#unknowns--must-verify-experimentally) — do not treat it as verified.

Bottom line for the plugin: the whole pipeline is reachable with **zero new registrations**. Drop → `fileAddressFor` →
`ctx.sidebarRight.openResource(address)` lands on the built-in `text` tab type, whose Markdown/DOCX renderers already exist.

---

## 1. `ctx.sidebarRight` — complete surface, `openResource`, callers

### Service identity

- Provided as the Cordis service `sidebarRight`: `dsh-client-ui-sidebar-right/lib/client.js:9115`
  (`ctx.reflect.provide("sidebarRight", controller)`), namespace constant `NS = "sidebarRight"` at
  `dsh-client-ui-sidebar-right/lib/client.js:9053`; the package's own `inject` list is
  `["slots","layout","locale","resources","sessions","uiSession","shortcuts"]` at `:9055-9063`.
- The controller class is `SidebarRightController`; its factory is `createSidebarRightController(...)` at `:6336`.

### Complete method list (verified member-by-member)

Controller (`SidebarRightController`), all synchronous:

| Method | Line | Notes |
| --- | --- | --- |
| `registerCloseHandler(kind, handler)` | `:6345` | returns an effect-scoped unregister callback |
| `tabDomain` (property) | `:6359` | the Tab domain object |
| `tabsIn(sessionId)` | `:6377` | committed tab records; `[]` before adoption |
| `openResource(address, options = {})` | `:6385` | **navigation controller** |
| `openTab(kind, options = {})` | `:6394` | page type by kind |
| `openResourceIn(sessionId, address, options = {})` | `:6406` | *not part of `ISidebarRight`* — Tab-domain path, silently no-ops |
| `openTabIn(sessionId, kind, options = {})` | `:6418` | same caveat |
| `close(tabId)` | `:6495` | |
| `active()` | `:6502` | active tab in the current pane |
| `isExpanded()` | `:6512` | |
| `toggleExpanded()` | `:6516` | |
| `focus(tabId)` | `:6528` | |
| `focusedTarget(element = document.activeElement)` | `:6538` | |
| `commandTarget(element = document.activeElement)` | `:6547` | |
| `openTabFromTarget(kind, target)` | `:6570` | |
| `canCloseTarget(target)` | `:6590` | |
| `closeTarget(target)` | `:6599` | |
| `isTargetCurrent(target)` | `:6616` | |
| `splitBlock(target)` | `:6631` | |
| `toggleFullscreen(target)` | `:6645` | |
| `split(paneId)` | `:6658` | |
| `float(tabId, rect)` | `:6680` | |
| `dock(paneId)` | `:6691` | |
| `screen()` | `:6720` | |
| `mountedSurface()` | `:6730` | |
| `canSplitPane(sessionId, paneId)` | `:6734` | |
| `actionsFor(sessionId)` | `:6742` | |
| `require()` | `:6745` | private precondition gate |

### `openResource(address, options = {})` — exact semantics

```js
// dsh-client-ui-sidebar-right/lib/client.js:6385
openResource(address, options = {}) {
  const { sessionId, actions } = this.require();
  this.placeResource(sessionId, actions, address, options);
}
// :6444
placeResource(sessionId, actions, address, options) {
  if (!address.startsWith(RESOURCE_SCHEME)) throw new Error(`sidebarRight: no registered tab type claims "${address}"`);
  this.place(sessionId, actions, this.tabs.claim(address, options.kind), address, options, options.params);
}
```

- `RESOURCE_SCHEME = "dsh-resource://"` — `:6327`.
- **Return value: `undefined`.** It is *not* a Promise; there is no cancellation token and no resolution to await.
  README:93 describes it as "one history entry" of synchronous steps.
- **Options actually read:** `options.kind` (`:6447`), `options.params` (`:6447`, forwarded to the Tab domain), and the
  placement keys `replaceTab`, `paneId`, `preferNewPane`, `revealIfOpened` — assembled by the `place` helper at `:6135-6140`
  and consumed by `place(...)` at `:6460`.
- **There is no `track`, `lifetime`, `fullscreen`, or `focus` option.** `track`/`lifetime` do not appear anywhere in the
  package's call signatures; tab lifetime is a property the **Tab domain** derives from how the tab was navigated to
  (README:12, README:93) and is not caller-settable via `openResource`. Fullscreen is a *separate* controller method
  (`toggleFullscreen(target)`, `:6645`), not an open option.
- **Preconditions / errors (both throw synchronously):**
  1. `require()` at `:6745-6753` throws `Error("sidebarRight: no session surface is mounted")` when the on-screen session
     (private `mounted` snapshot) is `undefined` or its store was never adopted. So `openResource` only works for the
     *currently on-screen* session; there is no `sessionId` parameter.
  2. `placeResource` throws `Error('sidebarRight: no registered tab type claims "<address>"')` when the address does not
     start with `dsh-resource://` **or** when no registered type claims it (`tabs.claim` returns `undefined`).
     An unknown `options.kind` also throws (`placeTab` at `:6450-6453`).
- Documented dedup/placement rules (README:93): an already-open resource tab with the same `(kind, contentId)` is
  **focused wherever it sits** unless `revealIfOpened: false`; otherwise the new tab lands in `options.replaceTab`'s pane,
  else `options.paneId`, else the active docked pane; and **the panel expands** ("content the user cannot see is not opened").
  `preferNewPane: true` additionally asks for a split (README:95, implementation `:6467-6470`).

### Built-in callers (the pattern to copy)

- File tree → open file: `dsh-client-ui-sidebar-files/lib/client.js:650`
  ```js
  onOpen: (path) => { tabActions.openResource(fileAddressFor(sessionId, state.root, path)); },
  ```
  Here `tabActions` is the Tab domain's own action face (`dsh-api-...` no: `:6162-6166`), not `ctx.sidebarRight`.
- Conversation file/link links: `dsh-client-ui-chat/lib/client.js:13874-13875`
  ```js
  if (options?.line === void 0) ctx.sidebarRight.openResource(url);
  else ctx.sidebarRight.openResource(url, { params: { line: options.line } });
  ```
  and a page open with `ctx.sidebarRight.openTab("browser", { params: { url } })` at `:13884`.
- In-package seat callers: `ctx.sidebarRight.commandTarget(element)` / `openTabFromTarget("files", target)` are used by
  `dsh-client-ui-sidebar-files/lib/client.js:982-990`.

---

## 2. File addresses, tab-type patterns, band precedence

### The real constructor

The helper is **`fileAddressFor`**, defined in `@deepseek-ai/dsh-util-workspace-path`:

```js
// dsh-util-workspace-path/lib/index.js:169
function fileAddressFor(sessionId, cwd, path) {
  const normalized = path.replace(/\\/g, "/");
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
  const root = cwd === void 0 ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
  if (root !== "" && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
  return sessionFileAddress(sessionId, normalized);
}
```

- Needs `sessionId`, the session's `cwd` (workspace root), and the file path. An **absolute path outside `cwd` is kept
  absolute** inside the address; inside `cwd` it is made relative.
- `sessionFileAddress(sessionId, path)` — `dsh-util-workspace-path/lib/index.js:28`:
  ```js
  const FILE_ADDRESS_PREFIX = "dsh-resource://file/";           // :9
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
  ```
  i.e. the address is **`dsh-resource://file/session/<sessionId>/<path>`** (segments `encodeURIComponent`-encoded,
  `:` left literal for Windows drives; leading `./` stripped; `\` normalised to `/`).
- Sibling exports: `absoluteFileAddress(path)` `:38`, `parseFileAddress(address)` `:50`, `resolveWorkspacePath(cwd, path)` `:106`,
  `relativizeToCwd(text, cwd)` `:183`.

### ⚠ It is NOT importable from a client plugin

`dsh-util-workspace-path/package.json` has **no `dsh.client` field** and ships only `lib/index.js` (no `lib/client.js`).
The client module system resolves a `require` only against "the platform seed table, memoized records, boot-graph rows,
and registered factories … anything else throws" (`dsh-client-modules/README.md:68`); only packages that declare
`dsh.client` become boot-graph rows. **So `require('@deepseek-ai/dsh-util-workspace-path')` will throw at runtime.**

That is exactly why the shipped packages *inline* it: `dsh-client-ui-sidebar-files/lib/client.js:378` (`sessionFileAddress`)
and `:410` (`fileAddressFor`) are inlined copies, used at `:650`. A third-party plugin must do the same — copy the ~20 lines
(pure string manipulation, no deps) or build the address string by hand.

### Tab type + band rules that make the built-in preview claim `.md` / `.docx`

The built-in preview registers as a **fallback** type:

- `dsh-client-ui-sidebar-documentpreview/README.md:31`: id `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`,
  **kind `text`, pattern `dsh-resource://file/**`, band `fallback`**; `canOpen` accepts **only Session addresses**
  (bare `absolute` addresses are not claimed); the whole address is the content identity.
- Registry contract `dsh-client-ui-sidebar-right/README.md:83`: `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`.
  A pattern containing `:` matches the whole URI (`dsh-resource://file/**`); a pattern without `:` matches the URI path at
  any depth, case-insensitively (`*.md`). A `kind` carries at most one `builtin` and one `extension` registration; **the
  extension band wins while present, the builtin resumes when it leaves.**
- Claiming is "best band wins": a narrower `*.png`-style type registered at `extension`/`builtin` takes those addresses,
  everything else falls to `text`.

Therefore an address produced by `fileAddressFor(sessionId, cwd, absPath)` is claimed by the built-in `text` tab with no
registration on our side, and its renderer dropdown resolves Markdown and DOCX:

- Markdown renderer: `dsh-client-ui-sidebar-documentpreview/lib/client.js:1674` (`extensions: ["md","markdown"]`),
  registered at `:1691`.
- Office (DOCX) renderer: `:6041` (`extensions: ["doc","docx","ppt","pptx"]`, id `.../office`).
- Text fallback: `:561-571`; `docx` is also listed as a known binary container at `:398`.

Capability to open in the right Sidebar is provided by the `text` **type**; the renderer choice is internal
(`ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority, title, loading, wrap? })`,
documentpreview README:35) and **does not change the navigation address** — so we never need to touch it.

---

## 3. Workspace resolution from the client

### Host side (not reachable from the browser)

`ctx.workspaceRegistry` is a **Host** service (`dsh-api-workspace-controller/lib/index.js:49,68,69`; registry entity
projection `workspaceView` at `:15-23`). The Host unary command is
`dsh-api-workspace-controller/lib/index.js:211`:

```js
create(request) {
  const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path);
  if (existing) return { workspace: workspaceView(existing), created: false };   // :214-217
  return { workspace: workspaceView(await this.ctx.workspaceRegistry.create(request.path)), created: true }; // :220
  // else throws RemoteError("workspace/invalid-path", ...)  :225
}
```

**Creation by path is idempotent** (resolve-then-create), and the response tells you which happened via `created`.

### Client service `ctx.workspaces` (the call chain to use)

- Provided as service `workspaces` — `dsh-api-workspace-controller/lib/client.js:389` (`super(ctx, "workspaces")`),
  constructor stores the remote-backed model as both `this.model` and `this.list` (`:390-393`).
- `ctx.workspaces.create(input)` — `:393-397`:
  ```js
  async create(input) {
    const result = await this.model.create(input);           // :394 -> ClientWorkspaceModel.create :51
    if (!result.ok) throw new WorkspaceCreateError(result.error);   // :395
    return result.value.workspace;                           // :396  (the `created` flag is dropped)
  }
  ```
  Full chain: `ctx.workspaces.create` → `ClientWorkspaceModel.create` (`:51-56`, also merges the row into the local
  snapshot) → `ctx.remote.workspace.create` → API Gateway → Host `WorkspaceCommands.create` → `ctx.workspaceRegistry`.
- **Input shape** (generated codec `dsh-api-workspace-controller/lib/typert.remote-client.js:40-42`): `{ path: string }`
  — an **existing absolute directory** ("existing absolute path to adopt", `client.js:47`).
- **Identity returned** (`typert.remote-client.js:44-55`, `index.js:15-23`):
  `{ workspaceId, path, title, sessionIds, createdAt, updatedAt }`. The Remote wire value is `{ workspace, created }`,
  but the client service **returns only `workspace`** — if you need the `created` flag you must use
  `result.value.created` from the lower-level model, which is not part of the public service.
- Errors: `WorkspaceCreateError` (`invalid-path`, …), thrown by the service.
- `ctx.workspaces.list` is a snapshot store: `getSnapshot()` → `{ phase, items, archivedSessionIds, pinnedSessionIds, order }`
  (host feed at `index.js:68-69`; consumed in `dsh-client-ui-workspace/lib/client.js:1481`).

### Can a raw Host Service be reached from a client plugin?

**No.** Client plugin code runs in the browser; Host services are only surfaced through the Typert Gateway as generated
`ctx.remote.<namespace>` child services — `dsh-api-gateway/README.md:52` ("Each namespace is a traced `remote.<namespace>`
child Service"), with cancellation/stream rules at `:33,:35`. The workspace-controller client half declares exactly that:
`inject: ["remote", "remote.workspace"]` (`dsh-api-workspace-controller/lib/client.js:445`), instantiated at `:451`.
There is **no import** that gives you the Host service in the browser. Use `ctx.workspaces` (above), which wraps it.

### `ctx.uiWorkspace` methods (dsh-client-ui-workspace)

Service constructed with `super(ctx, "uiWorkspace")` — `dsh-client-ui-workspace/lib/client.js:1396`.

| Method | Line | Behaviour / preconditions |
| --- | --- | --- |
| `connectWorkspace(workspaceId)` | `:1415` | `connectBlank(workspaceId, true)` — reuse a blank session or create one; returns a promise of the session id |
| `connectBlank(workspaceId, reuse)` | `:1418` | **throws** `uiWorkspace.connectWorkspace: unknown workspace <id>` if the id is not in the local snapshot (`:1419`) |
| `openSession(target)` | `:1449` | synchronous; `replaceMain(target, lifetime.signal, "reveal")` |
| `openWorkspace(workspaceId, beforeOpen?)` | `:1452` | `openWorkspaceSession(workspaceId, beforeOpen, true)` |
| `openWorkspaceSession(workspaceId, beforeOpen, reuse)` | `:1455` | awaits `connectBlank`; on abort/failure notifies `createFailed`; then `replaceMain(sessionId, navigation, "reveal", beforeOpen)` |
| `forkSession(sessionId, onCreated?, options?)` | `:1470` | does **not** navigate |
| `startSession(workspaceId?, options?)` | `:1478` | fire-and-forget; optional `prompt` / `clearPreviousDraft` (README:92) |

README:72 adds the preconditions: `openWorkspace(id, beforeOpen?)` "opens a Workspace blank only if no later navigation has
superseded the request" — i.e. navigation is cancellation-aware and a superseded request silently does not commit;
`openSession` returns the main area to Conversation **without waiting for `reference.ready`**.

Practical consequence for our plugin: `openWorkspace` reuses an existing blank session in that workspace (`reuseOrCreateBlank`,
`:1435`) and will **switch sessions even when the current session is already in that workspace**. Guard on the current
session's `cwd` first (see §4) and only call `openWorkspace` when it differs.

---

## 4. Sessions: ensuring an active session and learning its id

- **There is no `ctx.sessions.activeSessionId`.** A grep for `activeSessionId` across
  `dsh-api-session-controller/lib/client.js` (166k lines of bundle) returns **zero** hits. `ctx.sessions` is provided at
  `dsh-api-session-controller/lib/client.js:3835` (`rootCtx.reflect.provide("sessions", this, void 0)`).
- **The on-screen (main) session id** is `ctx.uiSession.current`:
  - `dsh-client-ui-session/lib/client.js:798` `super(ctx, "uiSession")`; `:801` `this.current = createBindingSource(this.absent.value)`;
    `:802-806` the renderer adapter exposes `current`.
  - `createBindingSource(value)` — `:1050-1062` — returns `{ value, getSnapshot(), subscribe(listener) }`.
  - The binding's **`key` is the session id**: `:1025` `key: binding.sessionId` (the absent binding has `key: undefined`, `:1043`).
  - Shipped usage proves the read pattern: `:916` `const currentId = this.current.value.key;` and
    `dsh-client-ui-sidebar-right/lib/client.js:9076` uses `ctx.uiSession.adapter.current`
    (`getSnapshot().key` + `subscribe`).
  - So: `const sessionId = ctx.uiSession.current.value?.key;` (subscribe to `.subscribe` if you need to re-run).
- **Session create:** `ctx.sessions.create(opts)` → `Promise<sessionId>`, throws `SessionCreateError` —
  `dsh-api-session-controller/lib/client.js:3967-3973`; `opts` = target workspace or directory (+ optional preallocated id).
  Shipped caller: `dsh-client-ui-workspace/lib/client.js:1463` `this.sessions.create({ workspaceId })`.
- **Session cwd** (needed by `fileAddressFor`): `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd` — same store used by
  `dsh-client-ui-workspace/lib/client.js:1482` and by the composer at `dsh-client-ui-conversation/lib/client.js:23219`.

Recommended order: read `uiSession.current.value.key` → if its `cwd === ws.path` keep it; otherwise
`await ctx.uiWorkspace.openWorkspace(ws.workspaceId)` → re-read `uiSession.current.value.key` and its `cwd`.

---

## 5. Drop handling conflicts — what already listens

**Yes, something already listens globally, and it is the composer's attachment intake.**

`dsh-client-ui-attachment/lib/client.js`:

```js
function installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive) {   // :539
  ...
  document.addEventListener("dragenter", onDragEnter);   // :578
  document.addEventListener("dragover",  onDragOver);    // :579
  document.addEventListener("dragleave", onDragLeave);   // :580
  document.addEventListener("drop",      onDrop);        // :581
  window.addEventListener("dragend", reset);             // :582
  return () => { ...removeEventListener... };             // :583-592
}
```

- Installed per mounted composer from an effect: `:621-623` (`(0, react.useEffect)(() => installDocumentDropEvents(...))`).
- `onDrop` — `:568-576`: `preventDefault()` whenever `dataTransfer.types.includes("Files")` (`fileTransfer`, `:540-544`),
  `reset()`, and **only if `canAcceptDrop`** does it call `onAddFiles(files, droppedDirectories(...))`.
- The listener is on **`document`**, for **the whole page** — it is not scoped to the composer's box. `canAcceptDrop` is
  per-composer enablement, not per-region.
- Downstream consequence: for a real local path, the conversation's `addFiles`
  (`dsh-client-ui-conversation/lib/client.js:23201-23260`) turns the file into an **`@relative/path` mention chip**
  (path obtained via the host bridge, `:23203` `const bridge = hostPathBridge();` and `:23215` `const path = bridge?.pathFor(file) ?? "";`), and images become uploads.
- Other `drop`/`dragover` listeners exist but are scoped/editor-internal: `dsh-client-ui-conversation/lib/client.js:10139`
  (`["dragover", Pn]`) and `:10144` (`["drop", Pn]`) are Lexical/React-registered handlers, not window-level.
- `dsh-client-file-upload` has **no** drop handling at all (grep for `drop`/`dragover`/`DataTransfer` returns nothing) —
  it is the upload transport (`ctx.fileUpload.upload(sessionId, body, name, signal, onProgress)`, README:28).

**Can a plugin safely add its own window listener? Yes, with two rules.**

1. Register in the **capture** phase on `window` (`addEventListener("drop", h, true)`). Because the attachment listener is
   registered on `document` in the **bubble** phase, your capture handler runs first; calling `event.stopPropagation()`
   there prevents the event from ever reaching `document`, so the composer does **not** also ingest the file.
2. Only stop propagation when you actually claim the drop, and stay off the composer's territory. The composer root is
   marked: `dsh-client-ui-conversation/lib/client.js:21151-21158` renders
   `<div className=...composerSeat data-composer-seat="" data-conversation-region="composer">` (also
   `data-composer-input` at `:21401`, `data-conversation-composer-overlay` at `:20629`). So:
   `if (event.target.closest('[data-conversation-region="composer"]')) return;` — let the composer have it.

Also: never `preventDefault()` on `dragover` globally in a way that changes `dropEffect` for the composer, and own the
listeners through `ctx.effect(() => { add; return () => remove; })` so plugin unload removes them (skill
`references/ui-plugin.md:13`).

---

## 6. Client-plugin entry contract (`platform: web`)

### `package.json` `dsh` fields

`dsh.client` is validated by `parseDshClient` — `dsh-client-modules/lib/index.js:60-75`:

- `platform: string` — **required** (`:62`).
- `inject?: string[]` (`:63`) — boot-graph ordering (packages whose client bundle must be registered first).
- `external?: string[]` (`:64`) — non-baseline module requests; each names a boot-graph row, or `<pkg>/client` aliases the
  bare package (`:91-99`), and a row must not name its own package (`:426-428`).
- `immediately?: boolean` (`:68`) — must be a boolean.

### `exports["./client"]` is mandatory

- `dsh-client-modules/lib/index.js:719`: `if (clientRel === void 0) throw new Error(\`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle\`)`.
- Resolution accepts a string or a one-level conditional object with a string `default` — `:170-180`.
- The host serves it at **`/plugins/<id>/client.js`** (`:204`), with a sibling `.map` when available (`:293`).
- The `dsh.client` declaration of a package is only scanned for **enabled Loader entries** — so the bundle must be inserted
  as a row (see §7).

### `client.js` module format (no bundler required)

The shipped bundles and the skill template use the same hand-written wrapper:

```js
// dsh-client-ui-sidebar-files/lib/client.js:1
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-sidebar-files",   // MUST equal the package name
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    let react = require("react");
    ...
    return module.exports;
  }
});
```

The skill's decoration template is the same shape but returns the plugin object directly
(`templates/decoration/client.js`):

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    ...
    return { inject: ['slots'], apply(ctx) { ... } };
  },
});
```

- **Entry contract** = a factory returning a Cordis plugin object `{ inject?: string[], apply(ctx), name?, Config? }`.
  `Config`/`name` are **not** required — the decoration template and its host half declare none.
- **Lazy-CJS:** executing the bundle only registers the factory; every module-body side effect (CSS injection included)
  happens at materialization (`factory(require)` → exports, memoized) — `dsh-client-modules/README.md:68`. Keep the factory
  side-effect-free and do all work inside `apply` (`references/ui-plugin.md:13`).
- Require cycles throw (`README.md:68`). Only baseline modules (`react`, `react/jsx-runtime`) and packages that are
  boot-graph rows resolve; anything else throws (`README.md:68`).
- **Do not import Harness client packages.** The skill's verification reference requires that a client plugin
  "imports no Harness Client package such as `@deepseek-ai/dsh-client-ui-primitives`"
  (`references/verification.md`). Use injected services (`ctx.sidebarRight`, `ctx.workspaces`, `ctx.sessions`,
  `ctx.uiSession`, `ctx.uiWorkspace`) and `require('react')` only.

### Slots

- `ctx.slots.register(options, Component)` — `dsh-client-ui-slots/lib/index.js:163`; returns a disposer.
  `options` = `{ name, id? , key?, priority?, children?, inject?, store?, registrant? }`; the kind (`single`, `list`,
  `keyed`, `chain`) determines which identifying field is required (`dsh-client-ui-slots/README.md:28,34`).
- `ctx.slots.inject(slotName, () => ctx.slots.register({...}, Component))` — the standard "wait for the parent declaration"
  form, used by the shipped sidebar: `dsh-client-ui-sidebar-right/lib/client.js:9241` (guide body) and `:9258` (title).
  The callback may also be a generator (`:9179`).
- **Right-sidebar tab body slot name: `sidebar.right.pane.tab`**, **keyed by the tab type's `id`**. Related seats seen in
  the shipped client: `sidebar.right.pane.tab.title`, `sidebar.right.toggle`, `sidebar.right.tab.document`,
  `sidebar.right.tab.document.actions`, `sidebar.right.tab.document.unpreviewable`, `sidebar.right.tab.guide`,
  `sidebar.right.tab.files.actions`, `sidebar.right.tab.menu.item`.
- **Our plugin registers no slot** — the built-in type supplies the body.
- Every registration must be owned by an effect (`ctx.effect` / `ctx.slots.inject` returns the disposer), not by the factory.

---

## Minimal, correct `apply(ctx)` sketch

This is the whole pipeline. It uses only APIs verified above; the only copied code is the inlined address helper (§2).

```js
// client.js (inside factory: return { inject: [...], apply(ctx) {...} })
const FILE_ADDRESS_PREFIX = "dsh-resource://file/";
const enc = (s) => encodeURIComponent(s).replace(/%3A/gi, ":");           // util-workspace-path:11
const isAbs = (p) => p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p) || p.startsWith("\\\\"); // :89,97
function sessionFileAddress(sessionId, path) {                            // :28
  const n = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return `${FILE_ADDRESS_PREFIX}session/${enc(sessionId)}/${n.split("/").map(enc).join("/")}`;
}
function fileAddressFor(sessionId, cwd, path) {                           // :169
  const n = path.replace(/\\/g, "/");
  if (!isAbs(n)) return sessionFileAddress(sessionId, n);
  const root = cwd === undefined ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "" && n === root) return sessionFileAddress(sessionId, "");
  if (root !== "" && n.startsWith(root + "/")) return sessionFileAddress(sessionId, n.slice(root.length + 1));
  return sessionFileAddress(sessionId, n);
}

const inject = ['sidebarRight', 'workspaces', 'uiWorkspace', 'uiSession', 'sessions'];

function apply(ctx) {
  ctx.effect(() => {
    const onDrop = (event) => {
      const dt = event.dataTransfer;
      if (!dt || !dt.types.includes('Files')) return;
      const file = dt.files && dt.files[0];
      const bridge = window.__DSH_HOST_PATHS__;                 // Electron only (preload-app.cjs:862)
      if (!file || !bridge) return;
      const absPath = bridge.pathFor(file);
      if (!absPath) return;
      // Never steal a drop aimed at the composer (ui-conversation:21157).
      if (event.target instanceof Element && event.target.closest('[data-conversation-region="composer"]')) return;

      event.preventDefault();
      event.stopPropagation();                                  // pre-empt the document-level attachment intake

      const dir = absPath.slice(0, absPath.lastIndexOf('/')) || '/';
      void (async () => {
        const ws = await ctx.workspaces.create({ path: dir });   // idempotent resolve-or-create
        const current = ctx.uiSession.current.value?.key;        // ui-session:1025
        const cwd = current === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[current]?.cwd;
        if (cwd !== ws.path) await ctx.uiWorkspace.openWorkspace(ws.workspaceId);
        const sessionId = ctx.uiSession.current.value?.key;
        const root = sessionId === undefined ? ws.path
          : ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd ?? ws.path;
        if (sessionId === undefined) return;
        ctx.sidebarRight.openResource(fileAddressFor(sessionId, root, absPath)); // throws if no surface mounted
      })().catch(() => { /* surface a notice in the real plugin */ });
    };
    window.addEventListener('drop', onDrop, true);               // capture: must beat document bubble
    return () => window.removeEventListener('drop', onDrop, true);
  }, 'dsh-file-session: global file drop');
}
```

Notes baked into the sketch: capture phase + `stopPropagation` is what keeps the composer's intake from double-handling;
`openResource` is synchronous and can throw (`sidebarRight: no session surface is mounted`) if it runs before the session
seat has mounted — see Unknowns.

---

## 7. Bundle skeleton

Modelled on the skill's decoration template (the only shipped *client* template) plus the patch-row shape used by
`dsh-llm-xai-oauth`.

### File tree

```
dsh-file-session/                          # the plugin package directory (installed by plugin_manager)
├── package.json
├── cordis.patch.yml
├── index.js                           # HOST half — required: the loader imports the row's package main
├── client.js                          # CLIENT half — plain JS, no build step
└── README.md                          # optional
```

(`dsh-llm-xai-oauth` uses `lib/index.js` + `"files": ["lib", ...]`; a flat `index.js`/`client.js` at the package root is
equally valid — the only hard requirements are `exports["./client"]` and the `dsh.bundle.patch` / `dsh.client` fields.)

### `package.json`

```json
{
  "name": "dsh-file-session",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-api-workspace-controller",
        "@deepseek-ai/dsh-client-ui-workspace",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-api-session-controller"
      ]
    }
  }
}
```

- `dsh.bundle.patch` mirrors `dsh-llm-xai-oauth/package.json` (`"bundle": { "patch": "./cordis.patch.yml" }`).
- `dsh.client.inject` lists the boot-graph rows whose services we inject; each of the five declares
  `dsh.client.platform: "web"` in the shipped tree, so they are valid graph rows.
- `immediately` is optional (`dsh-client-modules/lib/index.js:68`); omit it for a lazy drop handler — the factory only
  registers and `apply` runs at materialization.
- **No `Config` schema is needed.** Neither the decoration template nor its host half declares one; config would only be
  required if `cordis.patch.yml` passed a `config:` block that the host validates.

### `index.js` (host half)

```js
/** Host half of the file-drop bundle; the Client module owns all behaviour. */
export function apply() {}
```

(Skill template `templates/decoration/index.js`. A row named after the package is imported by the Loader, so the package
main must exist even when the host half is empty.)

### `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-file-session
      name: dsh-file-session
```

Two hard rules, confirmed against the installed profile:
- New rows **must** be wrapped in `insert:` — the profile's own patch says so verbatim
  (`/Users/sayi/.dsh/profiles/desktop/cordis.patch.yml`: "新增条目必须包在 `insert:` 里；直接写 `- id:` 会被当成对已有条目的 patch 而报 not found"),
  and `dsh-llm-xai-oauth/cordis.patch.yml` uses exactly this shape.
- Do **not** hand-edit `/Users/sayi/.dsh/profiles/desktop/package.json` or `cordis.patch.yml`. Install with
  `plugin_manager` `action: install_bundle` and the absolute package directory as `target` — that tool performs the
  profile `package.json` dependency + bundles[] edit and the patch insertion (skill `cordis-plugin-development`, SKILL.md).

### Build / runtime resolution

- **Plain ESM `client.js` is acceptable — no bundler step.** The decoration template ships a hand-written file calling
  `window.__ModuleLoader__.load({ id, factory })`; the host serves it verbatim at `/plugins/dsh-file-session/client.js`.
  A build is only needed if you author TypeScript or split the source into relative `import()` chunks (which compile to
  `require.async("./client.<name>.js")` and need the deployment's Client build tooling — `references/ui-plugin.md:9`,
  `dsh-client-modules/README.md:36`).
- **What `@deepseek-ai/*` imports resolve to at runtime:** nothing you can rely on. Resolution order is
  platform seed table → memoized records → boot-graph rows → registered factories, and "anything else throws"
  (`dsh-client-modules/README.md:68`). Concretely: `require('react')` / `require('react/jsx-runtime')` work (baseline);
  `require('@deepseek-ai/dsh-util-workspace-path')` **throws** (no `dsh.client`); a package that *does* declare
  `dsh.client` resolves via its `<pkg>/client` subpath (`dsh-client-modules/lib/index.js:91-99`) if the row is enabled.
  The intended style is nevertheless to **not require Harness packages at all** and to use `ctx.*` services
  (`references/verification.md`).

---

## Unknowns / must verify experimentally

1. **`openResource` immediately after a workspace switch.** `openResource` throws
   `sidebarRight: no session surface is mounted` (`dsh-client-ui-sidebar-right/lib/client.js:6745-6753`) until the
   on-screen session's store is adopted and its seat has reported a mount. `uiWorkspace.openWorkspace` commits the main
   reference synchronously but the React seat mount is asynchronous. **Unverified:** whether a single
   `await openWorkspace(...)` is enough, or whether the call must be retried over a frame/microtask. The sketch above
   will need a retry wrapper (or `openResourceIn`, which silently no-ops instead of throwing but is documented as
   *not part of `ISidebarRight`*).
2. **`ctx.workspaces.create({ path })` for a directory outside the workspace root / permission failures.** The host throws
   `RemoteError("workspace/invalid-path", …)` (`dsh-api-workspace-controller/lib/index.js:225`); the full set of failure
   codes and the exact `WorkspaceCreateError` surface were not enumerated.
3. **`ctx.workspaces.create` returns no `created` flag.** The service drops `result.value.created`
   (`dsh-api-workspace-controller/lib/client.js:396`). If the plugin needs to distinguish "created" from "adopted"
   (e.g. to decide whether to focus), that information is **not** available through the public client service — verify by
   reading `ctx.workspaces.list.getSnapshot()` before/after instead.
4. **`window.__DSH_HOST_PATHS__` availability.** It is exposed by the Electron preload
   (`./.asar-elect/lib/preload-app.cjs:862`, `{ pathFor: (file) => electron.webUtils.getPathForFile(file) }`). It exists
   in the desktop app's window; in a plain browser tab (if the GUI is ever opened outside Electron) it is `undefined`.
   **Unverified:** whether the `desktop` profile's Web GUI served at `http://127.0.0.1:58975` is always the Electron
   webview with the preload bridge present, or can also be opened bridge-less.
5. **`file` → path semantics for directories.** `webUtils.getPathForFile` returns `""` for items the shell cannot
   resolve (the shipped composer treats `path === ""` as a failure, `dsh-client-ui-conversation/lib/client.js:23214-23216`;
   directory drops additionally require Electron, `:23214`).
6. **Composer pre-emption is inferred, not documented.** The claim that a capture-phase `window` listener +
   `stopPropagation()` reliably suppresses the attachment intake rests on reading
   `document.addEventListener("drop", onDrop)` (`dsh-client-ui-attachment/lib/client.js:581`) and standard DOM
   propagation. **Verify in the running GUI** that dropping onto the composer still produces an `@path` chip while dropping
   elsewhere opens the preview, in both orders.
7. **`data-conversation-region="composer"` is a private marker.** It is present at
   `dsh-client-ui-conversation/lib/client.js:21157`, but it is not documented in any README and could change without notice;
   treat it as a best-effort selector and degrade safely (if it disappears, do *not* claim the drop).
8. **Which session `openResource` acts on when several panes/mounted surfaces exist.** `require()` uses a single private
   `mounted` snapshot (`:6747`); the multi-pane/pop-out interaction was not traced.
9. **Tab `lifetime`/`track`.** No such caller options exist on `openResource` (verified by reading `:6135-6140`, `:6444-6475`);
   the README describes lifetime as something the Tab domain derives. If the plugin needs a tab to outlive navigation, the
   mechanism was **not** identified.
10. **Slot/props for a future tab body.** If we ever need our own tab type, the body slot name is `sidebar.right.pane.tab`
    keyed by the type id (`dsh-client-ui-sidebar-right/lib/client.js:9241`), and its props/session scope were not fully
    enumerated — inspect `Slots.listSubTree` before relying on it (`references/ui-plugin.md:11`).
11. **`ctx.sessions.create` option schema.** Only `{ workspaceId }` usage was observed
    (`dsh-client-ui-workspace/lib/client.js:1463`); the accepted "directory target" alternative mentioned in the docstring
    (`dsh-api-session-controller/lib/client.js:3963`) was not resolved to an exact field name.
