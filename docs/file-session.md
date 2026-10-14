# dsh-file-session

> 「文件会话」插件的完整文档。仓库总览与安装方式见 [根 README](../README.md)。
> 这个插件本身就在仓库根目录（`index.js` / `client.js` / `cordis.patch.yml`）。


**One Session, one file.** The `文件会话` (file-session) Agent Preset for DeepSeek Harness.  
Its two actions are 「新建文件」 — create a file and focus on it — and 「选择文件」 —
pick an existing file and focus on it. In a blank Session the create action is not a button at
all: the row above the composer says what to type, and the Agent's first write becomes the file. A Session running the preset binds exactly one document  
and keeps it: the Agent may read anything, but it may only ever *write* that file, and once  
bound the binding cannot be switched or released.

```text
blank Session ── 在聊天输入框输入「新建文件」 ──┐
                 [ 选择文件 ] ────────────────┤──> the bound file
conversation ──[新建文件 |▾] [ 选择文件 ]──────┘   · retitles the Session
                                                        · opens the right Sidebar on it
                                                        · write/edit elsewhere is denied
                                                        · previewed by whichever plugin
                                                          claims its format
```

Three seams carry it, all of them DSH's own: an **Agent Preset** that owns the mode and  
its tool composition, a **tool guard** on the Session's Agent that refuses writes to any  
other path, and a **prompt section** that states the binding so the model plans inside  
the boundary instead of discovering it through denials. No new renderer was written —  
Markdown, Mermaid-as-text and Word already have Sidebar renderers.

The file is bound one of two ways, and neither can be undone:

| Entry            | What happens                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conversation** | You describe what you want; the file the turn produces becomes the bound file. A `write`/`edit` call binds immediately. A document the Agent builds with the shell — `bash` + python-docx, which is the *only* way a `.docx` can exist — is caught by the built-in workspace-change recorder, or, where that cannot help, by a directory watch on the Session's workspace. |
| **选择一个文件**       | A button in the Session's own entry row. Picking a file opens it in the right Sidebar and binds it.                                                                                                                                                                                                                                                                        |

Once bound, another file means another Session. There is no release button, and the  
Host refuses a second binding even if something asks for it directly.

> **Naming history.** The bundle has answered to `dsh-file-app`, `dsh-file-focus`,  
> `dsh-create-file`, and `dsh-file-focus` again, and is **`dsh-file-session`**; the mode it  
> installs has been 「文件专注」, 「创建文件」, 「文件聚焦」, and is now **「文件会话」** — one file,  
> one Session. The package, module id, routes, request header, seat ids, prompt-section name and  
> storage key all follow the current name, and the browser half reads every older  
> `localStorage` key (`dsh-file-focus:bindings`, `dsh-create-file:bindings`,  
> `dsh-file-app:bindings`), so no existing binding is lost.
>
> The **Preset id** changed with the mode name (`file-focus` → `create-file` → `file-focus` →  
> `file-session`). A Session that selected an older preset stores that older id, so re-select  
> 「文件会话」 in it once: the binding is keyed by Session and survives, and the file is untouched.

## Where it lives in the UI

One entry, registered in **three seats**, because the composer has three places a plugin can  
sit and each layout uses a different one:

| Seat       | Slot                         | Where it renders                                                                  |
| ---------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `hero`     | `conversation.input.dock`    | above the card, blank layout: the line saying what to type                        |
| `row`      | `conversation.input.left`    | inside the card's tool row, blank layout: the file picker                         |
| `composer` | `conversation.composer.dock` | below the card, once the Session has a conversation: the picker, and nothing else |

The composer dock **does** render in the blank layout — its owner is the resident composer bar,  
whose `variant` is `hero | composer` — so the picker can sit below the card there too. Exactly  
one seat renders for every layout state; which one is decided by **the layout's own question**,  
recomputed from the same stores the layout uses (`useSession`, `useSessions`, `useConversation`,  
with the layout's `conversationPhase` copied verbatim from `dsh-client-ui-conversation`):

```js
hero = sessionId === undefined ||
       conversationPhase(session, conversation) === 'blank' &&
       (session.openState === 'open' || summaryBlank === true)
```

Gating on anything else — an adjacent signal such as the list row's `blank` — lets the  
entry appear on the side the layout is *not* rendering, which is the chip "jump" this  
replaced. The invariant, covered by the smoke test across seven layout states, is that  
**exactly one seat renders, on the layout's side**:

```text
← the initial (hero) screen: the same two actions
[ 新建文件 |▾ ] [ 选择文件 ]

← once the conversation exists, below the composer card: the default action stays one
  click away and the caret holds the rest
[ 新建文件 |▾ ] [ 选择文件 ]
  ▾ 新建 Markdown 文档
    新建 Mermaid 图表
    新建 Word 文档
[ 📄 plan.md  已绑定 ]              ← bound (click to re-open the preview)
```

Outside a file-session Session the entry renders nothing at all.

「新建 Markdown」 and 「新建 Word」 write a **blank** file into the Session's workspace  
and bind it in one request; the name is the plugin's (`新建文档.md`, `新建文档.docx`,  
then `新建文档-2…` past whatever is already there). The Word entry copies a  
`assets/blank.docx` template that ships with the bundle — a `.docx` is a ZIP package,  
so a text write cannot produce one — built from python-docx's default template and  
verified structurally and through the bundled LibreOffice.

**A file never outlives its Session.** A Session that has not started a turn is `blank`,  
and the Harness hides blank Sessions from the workspace list unless one is selected  
(`dsh-client-ui-workspace/lib/client.js:983`), while `blank` flips only on a real  
`turn/start` (`dsh-api-session-controller/lib/index.js:1810`) — a title event does not  
count. So after binding a file into a blank Session, the browser half submits one queued  
turn through `ctx.sessions.binding(id).session.prompt([...], 'queue')`: it says what was  
created, and it makes the Session a real list member. The file is bound *before* that  
turn starts, so the Agent's first step already knows its one writable file — and a  
failure to start the turn is reported rather than swallowed, because the file exists  
either way.

Alignment: the composer dock centres its own entries, so the row there carries no box of  
its own; the input dock is full-width, so that registration reproduces the composer  
card's box (`width: calc(100% - 2 × --dsh-composer-side-clearance)`, `max-width: --dsh-composer-card-max-width`, `margin: 0 auto`) exactly as the shipped docks do.

The create writes go through the sandbox with an explicit per-call policy  
(`ctx.sandboxPolicy.resolve({ session })`, or the deployment policy with the Session's  
directory as its writable root). Omitting it is not "no policy": the enforcing backend  
falls back to a **deployment** writable root, which does not contain the Session's  
workspace, and the write is refused as `file access denied under workspace-write mode`.  
A `read-only` Session is refused up front instead.

The Session is **retitled to the file** the moment the binding appears, so the left  
sidebar row and the session header name the file (the header already shows the  
preset name beside the title, so one glance answers both *which file* and *which  
mode*). The rename goes through the Harness title service, so it is a durable,  
user-visible title event rather than plugin memory.

The Sidebar opens **by itself** the moment a binding appears: a file the Agent  
created in conversation is revealed as soon as it exists (~1 s after the write that  
bound it), a file you picked is revealed as you pick it, and a file you created with  
the buttons is revealed immediately. Only the transition opens a tab — a restored  
binding never fights tabs you closed yourself.

## Files

| File                            | Role                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                  | Bundle manifest: `dsh.bundle.patch` + `dsh.client` (`platform: web`, `immediately`, package load order)                                                                                                       |
| `cordis.patch.yml`              | Inserts the plugin row **and** the `file-session` Agent Preset                                                                                                                                                |
| `index.js`                      | Host half — binding map, bind-once / create / source / health routes, per-Agent write guard, prompt section, directory watch                                                                                  |
| `client.js`                     | Browser half — the two seat registrations, the create/pick actions, the binding chip, and the diagram tab type and body                                                                                       |
| `client.mermaid.js`             | Generated: the Mermaid renderer *and* highlighter as one self-contained lazy client chunk (5.0 MiB, committed so installing needs no build). Rebuild with `pnpm build:chunk`                                  |
| `build/mermaid-entry.mjs`       | What goes into that chunk: Mermaid configuration, `renderDiagram`, `parseDiagram`, `highlightDiagram`                                                                                                         |
| `build/mermaid-language.mjs`    | The Mermaid grammar for highlight.js: declarations, structure, arrows, comments                                                                                                                               |
| `build/build-chunk.mjs`         | esbuild wrapper that emits the chunk in the loader's envelope and bumps `client.js` so the revision follows                                                                                                   |
| `assets/blank.docx`             | The blank Word document 「新建 Word」 copies; made by python-docx's default template                                                                                                                              |
| `test/host-half.mjs`            | 31 assertions driving the real `apply()` against a fake Cordis context: the watch and its fallback, the write guard (including the delete-then-rebuild rule), both routes and the health report                                        |
| `test/client-half.mjs`          | 41 assertions rendering the real entry against a fake browser with a miniature React: the three seats, the two actions, the bind-once gating, the chip's one-line layout and the boot-safety guards                                  |
| `docs/research-client-api.md`   | The client APIs this plugin is built on, with `file:line` citations from the installed 0.2.1-alpha.2 build                                                                                                    |
| `docs/research-agent-writes.md` | How a client can observe Agent writes and reuse the preview's file watch (the auto-open path, not built yet)                                                                                                  |
| `docs/desktop-file-open.md`     | What the packaged desktop app does and does not support for OS-level "open with"                                                                                                                              |
| `.tools/asar-extract.mjs`       | Reads `app.asar` (list / cat / extract / offset→entry) so shipped packages can be inspected                                                                                                                   |

## The preset

`cordis.patch.yml` declares `file-session` with an explicit composition. A preset's  
`plugins` **is** the Agent's whole composition — the shipped `standard` preset lists  
all 21 of its rows — so the list is a deliberate copy of `standard` minus the rows  
that could write files behind the guard's back:

| Removed                                                  | Why                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `delegation`                                             | A subagent's writes carry the *child* session id, so the guard cannot attribute them to this Session |
| `planning`, `tool-schedule`, `command-goal`, `tool-goal` | Nothing a single-file editor needs                                                                   |


`tool-bash`, `tool-pwsh` and `tool-jobs` **stay**, because a `.docx` is a ZIP package:  
the Office pipeline has to execute `python-docx` and LibreOffice, and a  
conversational "create me a Word document" is impossible without them. Everything  
else (`persona`, `agent-instructions`, `time-context`, `tool-fs`, `tool-fs-search`,  
`skill-filesystem`, `tool-skill`, `compaction`, `tool-ask-user`, `tool-todo`,  
`tool-web`, `present`) is kept.

## How a file gets bound

Three signals feed one `bind()`, in this order of authority. The first one to  
produce a file wins, and a binding is never replaced.

| Signal                                                                              | Covers                                                 | Notes                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.guard` on `write`/`edit`                                                     | Text files the Agent writes                            | Synchronous, immediate, and binds *before* the write lands                                                                                                                                                                          |
| `ctx.workspaceChanges.summary(sessionId, event.seq)` on a `workspace/changes` event | Anything a turn changed, including shell-created files | Authoritative: it reports `binary` and added/deleted counts, so an office document beats a scratch note. **Needs a git repository**: the recorder cannot snapshot a plain directory and then lists only what the file tools changed |
| `fs.watch(cwd, {recursive:true})` scoped to one unbound focus Session               | Documents created by a shell command anywhere          | Collects candidates instead of binding eagerly; at `turn/end` it waits 1.5 s for the recorder to answer first, then binds an office document if it saw one, else the first document it saw                                          |

The watch exists because a `.docx` is a ZIP package: `python-docx` under `bash` is  
the only way to create one, and that write never passes through `write`/`edit`. It  
runs only while that Session has no binding, and stops at the first binding.

## How the lock works

```text
Host: bindings: Map<SessionId, {path, cwd, mode}>      // written once, never replaced
      directories: Map<SessionId, cwd>                 // from sessionController.inspect
      watchers:  Map<SessionId, {watcher, candidates}> // only while unbound

agent/created ──> agent.ctx.inject(['tools','systemPrompt'], scope => {
                    scope.tools.guard(exec => isFocus(agent) ? guardCall(agent.id, exec) : undefined)
                    scope.systemPrompt.section({ name, order: 9100,
                                                 text: () => isFocus(agent) ? rulesFor(agent.id) : '' })
                  })

guardCall: no binding yet  ──> bind this path (the Agent's first write) and allow
           bound, same path ──> allow
           bound, other     ──> deny with the reason the model reads
```

Browser half: `POST /dsh-file-session/target` binds; `GET ?sessionId=` reads. The route  
is the only way in, gated by a per-process nonce injected into the page (the web  
carrier has no server-wide auth, so every route owner brings its own policy).

Deliberate choices, each following the shipped guidance in `references/practices.md`  
of the plugin-development skill:

- **The weakest mechanisms that suffice**: `tools.guard()` can only deny, and no  
  `system-prompt/assemble` listener ever runs. Tool removal happens in the preset's  
  own composition, which is the declarative way to do it.
- **Per-Agent registration on `agent.ctx`**, disposed on `agent/disposed` — the same  
  shape as the shipped `dsh-file-reference-local`.
- **Both registrations self-gate at call time** through  
  `agentPresets.composedPreset(agent.ctx)`, so choosing the preset *after* the Agent  
  already exists still takes effect. No dependency on a preset-selection event.
- **Guards are synchronous**, so paths are compared with string work: relative  
  paths resolved against the Session's cached directory, case-folded on macOS and  
  Windows.
- **The browser keeps the durable copy** of the binding in `localStorage` and  
  re-states it when the Session is shown, so a Host restart loses nothing.
- **Hard lock for text, soft for containers**: `.md` `.markdown` `.mmd` `.mermaid`  
  `.txt` are enforced; other formats (e.g. `.docx`) only get the prompt rule,  
  because the Office pipeline legitimately writes conversion artifacts beside the  
  document — including the PDF the right Sidebar previews.

## Install / update

Installed into the `desktop` profile as a bundle (`dsh.profile.bundles` got  
`dsh-file-session`; the rows themselves come from this package's own `cordis.patch.yml`).

- **`client.js` changes reach a running page by themselves.** The client HMR receiver  
  re-materializes the browser half and runs its `apply` again; the desktop app has no refresh  
  button and needs none. The health stamp above reports which revision the page is on, so a  
  stale page is visible rather than guessed at. A full reload (`Cmd+R` in the app, or a  
  restart) is only needed to clear a registration an *older* revision left behind.
- **`index.js` or `cordis.patch.yml` changes need a Host restart**  
  (`install_bundle` reports `application: "restart-required"`).

Two cheap checks that the halves are live:

```bash
# Host half: an unknown path answers 404/405, this one answers 403 without the nonce.
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:52348/dsh-file-session/target
```

```text
Client half: Slots.listSubTree with root "conversation.composer.dock" lists
dsh-file-session.dock as an active occupant, and "conversation.input.dock" lists
dsh-file-session.hero. The diagram body appears under the type's id:
"sidebar.right.pane.tab" lists dsh-file-session/mermaid.
```

```bash
# The browser half also reports what it registered, because its console is not reachable
# from the Host side. The read is deliberately ungated and carries counts, a version stamp
# and an error *name* only — never a path, a binding or the nonce.
curl -s "$DSH_WEB_URL/dsh-file-session/health"
# {"ok":true,"bindings":1,"liveAgents":0,
#  "client":{"stamp":"…","injected":["slots","sessions","sidebarRight","sidebarRightTabs"],"seats":3,
#            "error":null}}
```

```bash
# The Host port changes when the app restarts; read it from the page URL or
# $DSH_WEB_URL rather than hard-coding it.
```

The lazy diagram chunk is not part of that combo: the browser derives  
`/plugins/dsh-file-session/client.mermaid.js?rev=<rev>` from the owner row, where `<rev>` is  
the owner artifact's revision — `sha1('plugin-artifact\0' + framed(mtimeMs, ctimeMs,
size))`, truncated to 12 hex digits. It is reachable without a page, which is how the  
chunk's serving was verified:

```bash
REV=$(node -e "const s=require('fs').statSync('client.js'),c=require('crypto').createHash('sha1');c.update('plugin-artifact');c.update('\0');for(const p of [String(s.mtimeMs),String(s.ctimeMs),String(s.size)])c.update(Buffer.byteLength(p)+':').update(p);process.stdout.write(c.digest('hex').slice(0,12))")
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "$DSH_WEB_URL/plugins/dsh-file-session/client.mermaid.js?rev=$REV"
# 200 5263873
```

## Tests

Both halves are covered without a running Harness — the host half against a fake Cordis  
context (including a fake sandbox that enforces containment, so an omitted policy is  
caught), the browser half against a fake browser with a stub React and the real module  
loader contract:

```bash
pnpm test        # or: node test/host-half.mjs && node test/client-half.mjs
```

What they pin down, and why each one exists:

| Assertion group                                                                                                                                            | The failure it prevents                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Guard: first write binds, later writes elsewhere are denied, reads never are                                                                               | The lock silently not applying                                                                                                           |
| Bind-once: same path idempotent, another path `409`, missing nonce `403`                                                                                   | A Session switching files, or anyone binding for it                                                                                      |
| Shell-created `.docx` binds through the watch, office beats a scratch note                                                                                 | The original bug: a `.docx` made by `python-docx` never binding                                                                          |
| Create passes a policy whose writable root is the Session cwd                                                                                              | `file access denied under workspace-write mode` on 新建                                                                                    |
| Create writes a blank file / a real ZIP template, and is refused once bound                                                                                | A broken or fake document                                                                                                                |
| Exactly one seat renders, on the layout's side, across seven layout states                                                                                 | The chip jumping between above and below the composer                                                                                    |
| Creating a file also starts the Session (queued, naming the file)                                                                                          | The file outliving a Session that never appeared in the list                                                                             |
| Both seats register; the hero layout is flat; four actions; no prefix label                                                                                | Regressions in the entry's shape                                                                                                         |
| The diagram type claims `*.mmd`/`*.mermaid` in the `extension` band and titles the tab by file name                                                        | The built-in preview taking the files back, or a tab with no name                                                                        |
| Both keys are declared; every declared injection resolves; an unsatisfied one keeps the entry inactive and the reader arriving activates it                | A missing declaration (throws `cannot get property … without inject` and stops the boot) or a declaration the composition cannot satisfy |
| The body reads through the injected reader, renders with the tab's color scheme, places the SVG, switches to 源码, and reports a parse error with its source | A tab that opens to "nothing can view this", a light-theme diagram on a dark page, or a dead end on invalid Mermaid                      |
| The shipped chunk registers itself for this bundle, exports both entry points, and holds no dynamic `import()`                                             | A chunk the loader cannot materialize, or one that would fetch a path the Host does not serve                                            |

## Previews are plugins

This bundle no longer renders anything. A preview is a **right-Sidebar tab type**, and the  
sidebar's registry is the seam: whichever plugin registers the extensions renders the file, and  
this plugin only opens the address. So the Mermaid preview moved out to  
[`packages/dsh-mermaid`](packages/dsh-mermaid/README.md), which is installable on its own and  
knows nothing about this one.

What that buys:

- this bundle has no 5 MiB chunk, no bundler toolchain and no dev dependencies — the plugin is  
  about binding one file again;
- a `.mmd` file is previewable in any Session, not only a file-session one;
- the renderer is replaceable: a different plugin can claim the two extensions, and a type in  
  the default `extension` band outranks the built-in `fallback` band  
  (`RANKS = { extension: 3, builtin: 2, fallback: 1 }`).

Without such a plugin the built-in Document Preview renders the bound file as text — the same  
fallback every other file gets — so the two bundles install independently. `新建 Mermaid`  
stays here on purpose: creating a `.mmd` is a file concern and needs no renderer.

## Known limitations

- The hard lock covers `write`/`edit`. `bash` stays in the preset (Office needs it),  
  so a shell redirect — `echo x > other.md`, `python -c "open(...)"` — is **not**  
  intercepted; the prompt forbids it and the binding is visible, but that is a  
  promise, not an enforcement. A format in soft mode (`.docx`) is prompt-level for  
  the same reason.
- One file per Session, forever: a mistaken binding is fixed by starting a new  
  Session, not by rebinding.
- The picker only accepts files inside the Session's own workspace (the file sandbox  
  would refuse writes elsewhere anyway): `.md` `.markdown` `.mmd` `.mermaid` `.txt`  
  `.docx` `.xlsx` `.pptx`.
- Where the workspace is **not a git repository**, the change recorder cannot  
  snapshot it, so a shell-created document is found only by the directory watch, and  
  only if it is a new file with one of the extensions above. An unusual flow (a  
  document written outside the Session's workspace, or a format not in that list)  
  still needs 「选择一个文件」.
- The directory watch prefers an office document over anything else it saw in the  
  turn, then the first document; a turn that creates two plain `.md` files binds the  
  first one.
- The browser half discovers a conversation-created binding by polling  
  `GET /dsh-file-session/target` every 1.5 s for up to 2.5 minutes while the Session has no  
  binding, then opens the Sidebar once for it.
- Only the displayed browser client keeps the durable copy; a Host restart before  
  the Session is shown again leaves it — and its binding — gone.
- The preset's composition is a **copy** of the shipped `standard` preset; revisit  
  it after a Harness upgrade.
- Visible strings are Chinese and not routed through the Client locale yet.
- The OS-level "open with" entry (right-click → open, double-click an associated  
  file) is **not** available from a plugin at all: this build of the desktop shell  
  registers no document types and has no `open-file` handler. See  
  `docs/desktop-file-open.md` for the exact upstream change.
