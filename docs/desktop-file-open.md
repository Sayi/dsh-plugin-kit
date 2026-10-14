# OS-level "open with DeepSeek Harness": what this build supports

Read from the installed bundle
`/Applications/DeepSeek Harness.app` (desktop shell `@deepseek-ai/dsh-desktop`
0.2.1-alpha.2, Electron main `.asar-elect/lib/main.js` extracted from
`Contents/Resources/app.asar`). Line numbers are from that extracted file.

## Verdict

**Drag-and-drop into the window works from a plugin; the OS "open with" entry
cannot be built from a plugin at all in this build.** It needs three changes in
the packaged desktop shell, listed at the end. Phase 1 therefore ships the drop
entry only.

## Verified facts

| Fact | Evidence |
| --- | --- |
| The session UI is a Desktop-owned document at `dsh-app://app/` | `main.js:6969` `const SCHEME = "dsh-app"`, `main.js:12076` `const applicationUrl = \`${SCHEME}://app/\``, navigated at `main.js:12230/12254/12886` |
| The preload for that document exposes the real path of a dropped file | `preload-app.cjs:862` `exposeInMainWorld("__DSH_HOST_PATHS__", { pathFor: (file) => electron.webUtils.getPathForFile(file) })` — exposed unconditionally, not behind the `dsh-app:` gate used at `preload-app.cjs:876` |
| macOS file-open is **not** handled | no `open-file` listener anywhere in `main.js` (search over the whole file); no `will-finish-launching` |
| macOS declares **no** document types | `plutil -p Contents/Info.plist` shows `CFBundleURLTypes` with the `dsh` scheme only; no `CFBundleDocumentTypes`, no `UTExportedTypeDeclarations` |
| A second launch does not carry a path | `main.js:7619-7626` `claimDesktopSingleInstance(application, focusOwner)` → `application.on("second-instance", focusOwner)`; the callback is `main.js:13130` `() => { focusPrimaryWindow() }`, which ignores Electron's `argv` argument |
| Startup does not parse a file path | the only `process.argv` use is `main.js:12013` `process.platform === "win32" && process.argv.includes("--updated")` |
| The `dsh://` scheme is an activation link only | `main.js:13001` `app.setAsDefaultProtocolClient("dsh")`; `main.js:13002-13005` `app.on("open-url", …)` acts only when `url === "dsh://open"` (or `dsh://open/`) → `focusPrimaryWindow()` |
| The packaged app cannot be patched in place on macOS | `Info.plist` carries `ElectronAsarIntegrity` for `Resources/app.asar`; editing the archive invalidates that hash (and the code signature) |

## The upstream change (proposal, not present)

Three edits in the `dsh-desktop` app, in the style of the existing code:

1. **Associations** — in the electron-builder configuration used for the macOS and
   Windows artifacts:

   ```js
   fileAssociations: [
     { ext: ['md', 'markdown'], name: 'Markdown Document', role: 'Editor' },
     { ext: 'docx', name: 'Word Document', role: 'Viewer' },
   ]
   ```

2. **Carry the path in the main process** — next to the existing `open-url`
   handler (`main.js:13002`):

   ```js
   let pendingOpenFiles = []
   const deliverOpenFile = (path) => {
     pendingOpenFiles.push(path)
     const window = currentMainWindow()
     if (window === undefined) return            // window not up yet: keep it queued
     window.webContents.send(DESKTOP_IPC.openFile, pendingOpenFiles.splice(0))
     focusPrimaryWindow()
   }
   app.on('open-file', (event, path) => {        // macOS
     event.preventDefault()
     deliverOpenFile(path)
   })
   ```

   and extend both argv paths — the first launch (`process.argv`, e.g. by filtering
   for existing absolute paths with a known extension) and the second-instance
   callback at `main.js:13130`, whose signature becomes
   `(_event, argv) => { for (const p of filePathsFromArgv(argv)) deliverOpenFile(p); focusPrimaryWindow() }`.

   Flush `pendingOpenFiles` once the window reports itself ready (the same place
   that already tracks `enteredWorkspace`, `main.js:12996`).

3. **Reach the web client** — add the channel to `DESKTOP_IPC` and expose it in
   `preload-app.cjs` beside `__DSH_HOST_PATHS__` (`preload-app.cjs:862`), e.g.
   `exposeInMainWorld('__DSH_OPEN_FILES__', { subscribe })`. The client side then
   feeds the same pipeline this plugin already implements
   (`workspaces.create` → `uiWorkspace.openWorkspace` → `sidebarRight.openResource`),
   so **no new client handling is needed beyond a listener** — the plugin's
   `client.js` already exposes that pipeline for the drop and picker entries.

## Plugin-side workaround available today

`dsh://open` cannot carry a path, so the scheme is not usable as a file entry.
A plugin can still offer the *picker* entry (implemented in `client.js`: the
sidebar-foot action uses a hidden `<input type="file">`, whose `File` objects the
same `webUtils.getPathForFile` bridge resolves to absolute paths). That covers
"open a file without leaving DSH" but not "double-click a `.docx` in Finder".
