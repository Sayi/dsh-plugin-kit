# Agent writes → live preview, and the Agent Preset — read-only reconnaissance

Target: **installed** DeepSeek Harness `0.2.1-alpha.2`, profile `desktop` (`/Users/sayi/.dsh/profiles/desktop`),
running as the shipped Web bundle.

Evidence base: packages extracted from
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` into `./.asar/` with `./.tools/asar-extract.mjs`.
All citations are `package-relative/path:line` under `.asar/dsh/node_modules/@deepseek-ai/` (the same convention as
[the earlier client-API recon](./research-client-api.md)). Nothing here was executed against a live GUI; every claim is
a reading of shipped code and its own README.

Mount status (checked in the shipped web composition `dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml`):
`workspace-files` `@deepseek-ai/dsh-api-workspace-files` (`:132`), `dsh-client-resources` (`:272`),
`ui-sidebar-right` (`:278`), `ui-sidebar-documentpreview` (`:287`), `ui-conversation` (`:321`),
`ui-deliverables` (`:347`), `ui-agent-preset` (`:411`), `workspace-changes` `@deepseek-ai/dsh-workspace-changes`
(`:352`), `agent-preset-registry` (`:574`). Everything named below is present in this profile's GUI.

---

## 1. `@deepseek-ai/dsh-client-ui-deliverables` — what a "deliverable" is

### What it does

It renders the **changed-files card** a finished turn ends with, plus cards for explicitly delivered files and
inline-code links in the closing prose; each entry opens a file (README.md:12). It is a UI package: it provides **no
Cordis service** — `grep -rn "reflect.provide" dsh-client-ui-deliverables/lib/*.js` returns nothing. Its client half
depends on `["slots","locale","uiConversation","remote","remote.session","sidebarRightTabs","sidebarRight","configForms"]`
(lib/client.js:2240-2249).

### What counts as a "deliverable"

Three disjoint sources (README.md:12, and the fold itself at lib/client.js:1160-1184):

| Source | Where it comes from | Files it contributes |
|---|---|---|
| **Produced** | successful first-party mutation calls, folded from session events | `write` (needs `args.content`), `edit` (needs `old_string`/`new_string`), and mutating `str_replace_editor` commands `create`/`str_replace`/`insert` — lib/client.js:1078-1107 |
| **Changed** | `workspace/changes` durable session event → `GET /api/changes.summary?sessionId&seq` (served by this package's own host half from `ctx.workspaceChanges.summary`, lib/index.js:169-184) | git work-tree diff at turn start vs turn end, plus whole-file captures of file-tool edits (`dsh-workspace-changes/README.md:10-12`; event appended at `dsh-workspace-changes/lib/index.js:871`) |
| **Presented** | `deliverables/presented` durable session event, appended by the `present` tool | exactly the `files: [{ path, description? }]` the model passed to `present` (`dsh-tool-present/lib/index.js:119-123`; validated at `dsh-client-ui-deliverables/lib/client.js:1171-1174`) |

The path for produced files is taken from the **recorded tool-result metadata**, not from arguments, when present:
`mutationResultPath(argumentPath, meta)` returns `meta.path` only if it is an absolute workspace path, else falls back
to an absolute argument path (lib/client.js:1113-1117). That metadata is the tool's `presentationMeta` output —
`dsh-tool-fs/lib/index.js:593-601` pins `{ operation, path, diffs }` for `write` (`:690` for `edit`) — which
`dsh-tools/lib/index.js:3552-3559` attaches to the result and `dsh-agent-loop/lib/index.js:697-706` writes into the
`tool/result` session event as `meta`.

### Does it auto-open a preview?

**No.** Every file opening in this package is behind a user gesture:

- the delivery/review card body action: `tab.actions.openResource(fileAddressFor(sessionId, cwd, file.path))`
  (lib/client.js:1966);
- the review tab: `ctx.sidebarRight.openResource(changesReviewAddress(coordinates), { params: { index } })`
  (lib/client.js:2295).

`grep -rn "openResource(" */lib/client.js` over all extracted packages returns only 5 call sites
(`ui-chat:13874-13875`, `ui-deliverables:1966,2295`, `ui-sidebar-files:650`, plus the definition in
`ui-sidebar-right:6385`) — **all are click-driven**. There is no auto-open anywhere in the shipped client.

Separately, `deliverables.file.actions` / `deliverables.review.file.actions` (README.md:39) are child slots of the
delivery cards whose shipped occupant is `ui-open-in-app`: they open the file **on the Host desktop** (native app),
not in the right Sidebar (`dsh-client-ui-open-in-app/README.md:50`).

### The exact API to learn "this session just wrote file X"

There is no deliverables service to subscribe to. The shipped consumer subscribes to the **Conversation event
Definitions registry**:

```js
ctx.uiConversation.events.register(deliverablesDefinition)   // lib/client.js:2268
```

Its `match(event)` also handles `tool/call`, `tool/result` (with `isAppendSurfaceEvent`), `workspace/changes`, and
`deliverables/presented` (lib/client.js:1162-1183). That registry is the sanctioned "tell me what this session is
doing" hook — see §2.

---

## 2. The Session event stream — what a client plugin can subscribe to

There are **two** client-side accessors. Both see the same durable `SessionEventLikeEntry` objects.

### 2a. Sanctioned and target-neutral: `ctx.uiConversation.events.register(definition)`

- Registry: `UiConversation.events`, "the single registry for event Definitions"; rejects duplicate `kind`s, preserves
  registration order, returns an idempotent disposer (`dsh-client-ui-conversation/README.md:30`; implementation
  `lib/client.js:3298-3318`).
- Each entry's outer `type` distinguishes durable from Client-only transient events; the inner `event` **always**
  exposes `type`, `seq`, `time`, `data` (`README.md:34`).
- Function-form Definitions "receive every event" (`README.md:38`) — the dispatcher falls back to iterating every
  registered definition when no type-routed table matches (`lib/client.js:2801-2802`, `3371-3373`).
- A Definition is `{ kind, match, start, update, ... }`: `match(event) → { id, role: 'start' | 'update' } | null`
  (a table form `match: { 'tool/call': handler, … }` is also accepted, `lib/client.js:3374-3383`).
- `ctx.uiConversation.binding(sessionId | binding)` returns the per-session binding used for folding. It throws
  `uiConversation.binding: unknown session` / `inactive session` unless the Session Controller binding is currently
  retained (`lib/client.js:3804-3808`).

**Are file writes observable? Yes.** The `write`/`edit` tool's target path is observable twice over:

- at call time: `event.type === "tool/call"`, data `{ turn, step, callId, name, arguments }` where `arguments` is the
  model's JSON string — the same shape deliverables parses with `mutationPath(name, argsRaw)`
  (`dsh-api-session-controller/lib/typert.host.js`, `SessionEventMap.tool__call`; deliverables
  `lib/client.js:1078-1107`);
- on settlement: `event.type === "tool/result"`, data `{ turn, step, message, error?, meta? }`
  (`SessionEventMap.tool__result`), and **`meta.path` is the canonical absolute path** as pinned by the tool's
  `presentationMeta` (`workspace-files/README`… see §1; `dsh-agent-loop/lib/index.js:697-706`). The Session Controller
  promises it is passed through untouched: "Tool arguments, result content, failures, and `tool/result.data.meta`
  pass through unchanged" (`dsh-api-session-controller/README.md:30`).

The `workspace/changes` event carries only `{ turn }` — emitted at `dsh-workspace-changes/lib/index.js:871`
(`session.append("workspace/changes", { turn: state.turn })`), validated client-side at
`dsh-client-ui-deliverables/lib/client.js:81-83`. The file list itself is Host-side and must be fetched (or
re-derived from tool events).

### 2b. Raw feed: the Session Controller binding's `eventSource`

`ctx.sessions.retain(target, { source, signal })` → `reference`; `await reference.ready` → the **binding**
(`dsh-api-session-controller/lib/types/client/sessions/service.js:188-203`, `94-138`). The binding is the literal
object `{ sessionId, session, eventSource, ctx }` (`service.js:478`), where `eventSource` is a
`MutableSessionEventSource` snapshot store (`lib/types/client/contract/events.js:41-120`):

```js
const ref = ctx.sessions.retain(sessionId, { source: 'target-lock', signal })
const binding = await ref.ready                     // { sessionId, session, eventSource, ctx }
const stop = binding.eventSource.subscribe(() => {
  const { change, entries, hasMore } = binding.eventSource.getSnapshot()
  // change: { kind:'append'|'prepend'|'replace'|'settle-assistant', entries }
  for (const entry of change.entries ?? []) {
    if (entry.type !== 'event') continue            // 'transient' for live assistant chunks
    if (entry.event.type === 'tool/call') { /* data.name, data.arguments */ }
    if (entry.event.type === 'tool/result') { /* data.meta?.path, data.message.source.callId */ }
  }
})
ref.release()                                       // or pass a signal
```

`change.kind === 'append'` carries exactly the new live entries (`contract/events.js:78-85`). Shipped precedent:
`dsh-client-ui-chat/lib/client.js:13707-13708` subscribes to `binding.eventSource`
(`{ change } = getSnapshot()`). Transient entries exist only for `assistant/live-chunk`
(`lib/types/client/sessions/assistant-stream.js:38-51`) — tool calls/results are durable.

Caveats (both verified, not inferred):

- `ctx.sessions.binding(id)` returns `undefined` unless the session is currently retained
  (`service.js:408-413`), because retention is reference-counted per source (`service.js:415-435`). A target-locked
  plugin should therefore **retain the session itself** for as long as it cares, rather than borrow.
- Retaining opens the session body: `retain` immediately attaches `session.open()` (tail page + follow stream,
  `service.js:196`). The list itself never does this (`README.md:34`).

### 2c. What is *not* available

- `ctx.uiSession` (`dsh-client-ui-session`) carries only React/slot adapters for lists, interaction state and
  per-session context (README.md:6) — no event feed.
- `ctx.sessionQuery.readEvent({ sessionId, seq, before, after }, signal)` exists, but it is a **Host** service
  (`dsh-session-query/lib/index.js:1042`, `:1210`). The client reaches it only through routes the Host half of
  ui-deliverables registers (`dsh-client-ui-deliverables/lib/index.js:113-121`, `169-184`); depending on those routes
  means depending on another UI package's private contract.
- `ctx.uiConversation.binding(id)` exposes only `{ snapshot, openTurn, target(target) }`
  (`dsh-client-ui-conversation/lib/client.js:3645-3679`) — **not** the raw feed. Use §2a or §2b.

---

## 3. File-change driven refresh — and how to reuse it to auto-OPEN

### The mechanism: a real Host filesystem watch, shared through `ctx.resources`

Not polling, and not a client store. The chain is:

1. `dsh-api-workspace-files` client half registers the `file` resource provider
   (`lib/types/client/index.js:4-20`; provider `lib/types/client/provider.js:9-...`), which calls
   `remote.workspaceFiles.changes(sessionId, path, signal)` — a **Remote ASTREAM** (`lib/index.js:523-525`).
2. The Host `WorkspaceChangeFeed` owns one `ctx.fs` watch per follower and yields
   `{ kind:'ready' }` then, per invalidation, `{ kind:'change', change: { absolutePath, version } }` or
   `{ absolutePath, absent: true }` (`lib/types/changes.js:94-110`; class head `lib/index.js:5-34`).
3. The browser `ChangeFeed` multiplexes those frames per session+path into per-address followers
   (`lib/types/client/change-feed.js`).
4. The document preview subscribes to the resulting resource and reloads on a version bump:
   `ResourceGroup.add(address)` does `source.subscribe(observe)` and calls `changed()` when the
   `live:<version>` key moves (`dsh-client-ui-sidebar-documentpreview/lib/client.js:1092-1117`); the effect
   `if (state?.autoRefresh && changed && …) reload()` then re-reads the file (`:722`, `:723-738`, `:741`).
   "Manual" is just that effect being gated on the `autoRefresh` preference.

### Reusing it

The resource layer is public and independent of any tab. From a client plugin (`inject: ['resources']`):

```js
const address = fileAddressFor(sessionId, cwd, targetPath)  // dsh-util-workspace-path/lib/index.js:169-176
ctx.resources.pin(address, signal)                          // keep the watch alive without a tab
const source = ctx.resources.source(address)                // { getSnapshot(), subscribe(listener) }
source.subscribe(() => {
  const { status, value } = source.getSnapshot()            // value: WorkspaceFileStat (has .version)
  // status 'live' with a new value.version  ⇒  the file was created or written
})
```

- `ctx.resources.pin(address, signal)` "keeps a resource open without subscribing, until `signal` aborts";
  `ctx.resources.source(address)` "is the bare observable behind the hook, for callers outside React"
  (`dsh-client-resources/README.md:64-66`; implementation `lib/client.js:58-68`). Subscribing alone also holds it.
- Subscribing is enough for the **create** case too: the provider keeps `current` undefined while the last stat
  failed and re-stats on the next notice, "a write can still bring the file live"
  (`dsh-api-workspace-files/lib/types/client/provider.js:19-46`).
- This is the signal to reuse for **auto-open**: on the first `live` frame for the pinned address, call
  `ctx.sidebarRight.openResource(address)`. `openResource(address, options?)` is the sidebar's navigation controller
  and is documented to be the only way in (`dsh-client-ui-sidebar-right/README.md:93`; definition
  `lib/client.js:6385`). It throws `sidebarRight: no session surface is mounted` while no session seat is mounted
  (`lib/client.js:6748`) — so an auto-open must be deferred/retried until the target session is on screen, exactly as
  the earlier recon flagged for post-switch opens.

---

## 4. Agent Preset, client side

### Read the preset a Session currently uses

`ctx.sessions.list` is a snapshot store; the preset is a **session projection**:

```js
const preset = ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset   // string | null
```

Shipped reader: `dsh-client-ui-agent-preset/lib/client.js:1002-1005` (`useSessions(state => state.byId[sessionId]
?.projectionValues?.agentPreset)`), helper `presetOf(session)` at `:2092-2095`. The wire types confirm the field:
`SessionProjectionMap.agentPreset: string | null` and `SessionSummary.projectionValues`
(`dsh-api-session-controller/lib/typert.host.js` generated declarations; projection attach at
`lib/types/client/sessions/manager.js:698-706`). The durable counterpart is the `agent-preset/selected` session event,
`{ agentPreset: string }` (`SessionEventMap`), appended by the registry
(`dsh-agent-preset-registry/lib/index.js:756`).

Caution: `dsh-client-ui-agent-preset`'s header label is **read-only by construction** — "a session's composition is
fixed once its conversation starts" (`lib/client.js:987-995`).

### SET it — two paths, both Host-enforced

**(a) At session creation (preferred).** The wire request accepts it:
`SessionCreateRequest { workspaceId?, cwd?, sessionId?, agentPreset? }` → `SessionCreateValue { sessionId, agentPreset? }`
(`dsh-api-session-controller/lib/typert.remote-client.js:215-225`). The Host applies it via
`agents.ensureSession(sessionId, cwd, explicitId, request.agentPreset)` and refuses if the persisted identity already
carries a different preset (`lib/types/commands.js:107-125`; `lib/types/agent.js:258-286`, `:388-400`).

> ⚠ **The client wrapper drops `agentPreset`.** `ctx.sessions.create(opts)` forwards only
> `workspaceId | cwd` and an optional `sessionId`: `shared = sessionId === undefined ? {} : { sessionId }`,
> `payload = workspaceId !== undefined ? { workspaceId, ...shared } : { ...(cwd === undefined ? {} : { cwd }), ...shared }`
> (`dsh-api-session-controller/lib/types/client/sessions/manager.js:443-448`). A plugin that needs the preset at
> creation must call the Remote itself (`ctx.remote.session.create({ workspaceId, agentPreset })`) — or create, then
> select before the first turn (path b).

**(b) After creation, before the first turn.** Remote `agentPresets.select(agentRef, agentPreset: string)`:

```js
const result = await ctx.remote.agentPresets.select(sessionId, presetId)   // { ok:true, value:string } | { ok:false, error }
```

Shipped caller: `dsh-client-ui-agent-preset/lib/client.js:2077` (result handling at `:2078-2082`), Remote signature at
`dsh-agent-preset-registry/lib/typert.remote-client.js:23-28`; host implementation `select(agent, agentPreset)`
(`lib/index.js:743-758`) which recomposes the agent and appends `agent-preset/selected`. It is locked once the session
has started: `boundary.openTurnStartSeq !== null || boundary.lastTurn > 0` →
`RemoteError('agent-preset/locked', 'This session has already started', { sessionId, agentPreset })`
(`lib/index.js:750-754`). The client additionally only attempts it for `session.blank === true`
(`dsh-client-ui-agent-preset/lib/client.js:2045-2058`).

Also on the same Remote namespace: `agentPresets.list()` → `{ presets: [{ id, isDefault, name?, description?, broken? }] }`
and `agentPresets.read(id)` → `{ agentPreset, content, name?, description? }`
(`dsh-agent-preset-registry/lib/typert.remote-client.js:4-21`; host `lib/index.js:570-591`). Service access from a
plugin is `ctx.remote.agentPresets`, which requires `remote.agentPresets` in the inject list
(`dsh-client-ui-agent-preset/lib/client.js:2255`).

There is **no** `ctx.agentPreset` service on the client — the only shipped object-layer API is the `AgentPresetSeat`
chip controller, which is package-private (a class inside the client bundle, `lib/client.js:1912-2091`). The Host
service is `ctx.get('agentPresets')` (`dsh-api-session-controller/lib/types/skill-catalog.js:153`, `189`).

### The hero slot

`conversation.hero.agentPreset` is a real slot: declared by ui-conversation as `kind: "single"`,
`scope: "session-maybe"` (`dsh-client-ui-conversation/lib/client.js:23027-23030`), rendered at `:21115`. It is
occupied by ui-agent-preset (`dsh-client-ui-agent-preset/lib/client.js:2399-2403`) with injected props
`{ hooks.agentPresetSeat, hooks.developerTools, load, select, dismissRefusal, introduced }` (`:2369-2385`).

**A second plugin cannot occupy it while ui-agent-preset is mounted**: single slots throw
`single slot "<name>" already has a registration …` (`dsh-client-ui-slots/lib/index.js:172`). To pick a preset for a
new session from a plugin, either (i) remove/replace ui-agent-preset in the composition, or (ii) skip the chip and set
the preset yourself (path (a) or (b) above).

---

## 5. Session creation fields

**Client service** (`ctx.sessions.create`):

```ts
create(opts?: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId }): Promise<SessionId>
// throws SessionCreateError({ error, sessionId }) on Host refusal
```
`dsh-api-session-controller/lib/types/client/sessions/service.js:312-325`; payload construction (which drops
`agentPreset`) `lib/types/client/sessions/manager.js:443-448`.

**Wire / Host create** (`session.create`):

```ts
SessionCreateRequest {
  workspaceId?: WorkspaceId   // or cwd, never both (gateway/bad-request)
  cwd?: string
  sessionId?: SessionId       // optional caller-owned/preallocated id (idempotent adopt)
  agentPreset?: string        // applied at creation; conflict → agent-preset/* error
}
→ SessionCreateValue { sessionId: SessionId; agentPreset?: string }
```
Schema `lib/typert.remote-client.js:214-225`; host `lib/types/commands.js:107-125`; the resolved preset is returned
only when configured. Errors the caller should expect: `workspace/not-found`, `session/workspace-attach-failed`,
`agent-preset/not-found` (`{ agentPreset, available }`), `agent-preset/invalid` (`{ agentPreset, reason }`),
`agent-preset/locked` (RemoteErrorDetailsMap, `lib/typert.host.js`).

Model/agent-related fields: **only `agentPreset`.** There is no model field at create; model selection is a separate
Remote (`session.selectModel`, `lib/typert.remote-client.js:1549-1569`, request type
`SessionSelectModelRequest`) whose current value is projected as `SessionProjectionMap.modelSelection`.
Fork (`ctx.sessions.fork`) and prompt do not take a preset either.

---

## 6. Unknowns (not verifiable from shipped code alone)

1. **Auto-open timing.** `ctx.sidebarRight.openResource` throws until a session surface is mounted
   (`dsh-client-ui-sidebar-right/lib/client.js:6748`). Whether a retry over `requestAnimationFrame`/microtasks is
   enough after the target session becomes current is **not** determinable statically (same open item as
   `research-client-api.md` §Unknowns 1).
2. **Definition side effects.** I verified every function-form Definition's `match` is called for every entry, and
   that `update` runs during assembly, but **not** whether calling `ctx.sidebarRight.openResource` from inside
   `update` is safe (assembly is not React render, but publication is synchronous inside a store notification). Not
   exercised.
3. **`retain` source key.** `retainedBy` is a record keyed by an opaque source string
   (`service.js:415-435`); shipped callers use `"mainView"`, `"sidebarView"`, `"commandCatalog"`,
   `"workspaceOperation"`. I did not find a declared union type, so an arbitrary key such as `"target-lock"` is
   almost certainly accepted but is **unverified** at runtime.
4. **`ctx.resources.pin` vs. existing holders.** I read that a second holder reuses the same record
   (`lib/client.js:58-76`), so pinning a file the preview already shows should share one Host watch. Not exercised.
5. **Workspace-root assumption for the pinned address.** `fileAddressFor(sessionId, cwd, path)` needs the Session's
   `cwd` (`ctx.sessions.list…byId[id].cwd`). Behaviour for targets outside `cwd` (absolute addresses are legal) was
   not exercised.
6. **`agentPresets.select` on a session that exists only as a placeholder.** The client-side blank test uses the
   local summary's `blank` flag (`summary.blank`), and the Host-side test uses the `turnBoundary` projection; I did
   not verify what happens when the Host has not yet materialised the projection for a just-created session.
7. **Whether removing `ui-agent-preset` from the composition is supported** for a profile-level patch (it is mounted
   by the shipped web patch at `dsh-web-app/cordis.patch.yml:411`) — not checked beyond that entry.
8. **`present` + auto-open.** `present` emits `deliverables/presented` with an ordered file list; whether a
   target-locked session should treat `present` (rather than the first write) as the open trigger is a product
   decision, not a code fact.

---

## How a target-locked session could auto-open its file

Two viable chains; (A) is the one the shipped code already demonstrates end to end, (B) is the cheapest.

### A. File-watch chain — reuse the preview's own signal (recommended)

```
plugin apply(ctx)                                   inject: ['resources','sessions','sidebarRight','remote']
└─ ctx.sessions.retain(sessionId, { source:'target-lock', signal })      service.js:188-203
   └─ await reference.ready → binding                                     service.js:94-138
      └─ address = fileAddressFor(sessionId, cwd, LOCKED_PATH)            dsh-util-workspace-path/lib/index.js:169-176
         ├─ ctx.resources.pin(address, signal)                            dsh-client-resources/lib/client.js:58
         └─ ctx.resources.source(address).subscribe(onFirstLive)          dsh-client-resources/lib/client.js:66
            └─ provider → remote.workspaceFiles.changes(sid, path, sig)   api-workspace-files/lib/types/client/provider.js:20
               └─ Host fs watch → {kind:'change', change:{absolutePath, version|absent}}   api-workspace-files/lib/types/changes.js:94-110
            └─ onFirstLive: ctx.sidebarRight.openResource(address)        sidebar-right/lib/client.js:6385
                                 (retry while it throws "no session surface is mounted", :6748)
```
Refresh afterwards is **free**: the same address stays pinned, so the preview's `ResourceGroup` sees the version bump
and auto-reloads (`sidebar-documentpreview/lib/client.js:1092-1117`, `:741`).

### B. Tool-event chain — open before the bytes exist

```
plugin apply(ctx)                                   inject: ['uiConversation','sessions','sidebarRight']
└─ ctx.uiConversation.events.register({
     kind: 'target-lock',                                    // unique; duplicates throw (client.js:3299)
     match: (e) =>
       e.type === 'tool/call'   && mutationPath(e.data.name, e.data.arguments) === LOCKED ? { id:'lock', role:'update' } :
       e.type === 'tool/result' && isAbsoluteWorkspacePath(e.data.meta?.path) && …          ? { id:'lock', role:'update' } : null,
     start:  () => ({}), update: (ctxState, m) => { /* open here */ return ctxState },
   })                                                        deliverables client.js:1160-1193 as the template
└─ ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, LOCKED))
```
This gives the path at `tool/call` time (`data.name` + `arguments` JSON) and the authoritative absolute path at
`tool/result` time (`data.meta.path`). It does **not** tell you the turn's git-level changed files — that is
`workspace/changes` + `GET /api/changes.summary?sessionId&seq` (`ui-deliverables/lib/index.js:169-184`), which is
per-turn, not per-write, and is better used to *verify* the lock after the turn.

### C. What does not exist yet

There is **no Host or client signal of the form "the agent wrote file X" delivered as a first-class event to
plugins** other than the session's own `tool/call` · `tool/result` · `workspace/changes` events, and no auto-open path
in the shipped client. A target-locked session must compose (i) a session event fold or raw `eventSource`
subscription, plus (ii) a pinned `file` resource watch, plus (iii) an explicit
`ctx.sidebarRight.openResource` with a retry until the surface is mounted. Nothing in the design needs a new Host
plugin; everything is reachable from one client plugin with the inject list
`['resources','sessions','sidebarRight','uiConversation','remote']`.

*(Optional, if the lock should also be enforced/selected rather than merely displayed: set the preset at creation via
`ctx.remote.session.create({ workspaceId, agentPreset })` — **not** `ctx.sessions.create`, which silently drops it
(`manager.js:443-448`) — or select it while the session is still blank via
`ctx.remote.agentPresets.select(sessionId, presetId)`.)*
