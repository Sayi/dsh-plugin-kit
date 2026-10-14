/**
 * The shared preview kit.
 *
 * A Diagram-ish preview needs the same things whatever it renders: a header row with the file's
 * path, a view dropdown, a reload control, an 「打开方式」 menu, a pan/zoom surface, a code view
 * with syntax colours, and a diagnostic route for the Host. `dsh-mermaid` grew all of that; this
 * bundle is that chrome, extracted, so the next preview does not become a second copy of it.
 *
 * The kit owns no Cordis service and no file of its own: the plugin passes an adapter — how to
 * read the source, how to turn it into an SVG, how to highlight it — and gets a tab body back.
 * The module is also a valid (empty) plugin, so it can be installed as an ordinary bundle and
 * required by name from a sibling client bundle.
 */
window.__ModuleLoader__.load({
  id: 'dsh-preview-kit',
  factory(require) {
    const React = require('react')

    /** The address scheme a sidebar preview is opened with; the kit parses it for every plugin. */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

    /** The lower-cased file name of a path. */
    function basenameOf(path) {
      const name = path.replace(/\\/g, '/')
      const cut = name.lastIndexOf('/')
      return cut < 0 ? name : name.slice(cut + 1)
    }

    const messageOf = (error) => (error && error.message) || String(error)

    /** The Session and path a `dsh-resource://file/...` address names, the inverse of `sessionFileAddress`. */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
      const rest = address.slice(FILE_ADDRESS_PREFIX.length).split(/[?#]/)[0]
      if (!rest.startsWith('session/')) return undefined
      const tail = rest.slice('session/'.length)
      const cut = tail.indexOf('/')
      if (cut < 0) return undefined
      return {
        sessionId: decodeURIComponent(tail.slice(0, cut)),
        path: tail
          .slice(cut + 1)
          .split('/')
          .map((segment) => decodeURIComponent(segment))
          .join('/'),
      }
    }

    /**
     * The active color scheme, read from the theme service and re-read on `theme/change`.
     *
     * The service owns the preference, the OS sensing and the change event, so this needs no
     * probing of painted tokens and no media-query listener of its own. `'default'` is
     * Mermaid's light theme; anything without a theme service renders light.
     */
    function useColorScheme(ctx) {
      const read = () => {
        try {
          return ctx.get('theme')?.getTheme?.().active?.colorScheme === 'dark' ? 'dark' : 'default'
        } catch {
          return 'default'
        }
      }
      const [scheme, setScheme] = React.useState(read)
      React.useEffect(() => {
        if (typeof ctx.on !== 'function') return undefined
        return ctx.on('theme/change', () => setScheme(read()))
      }, [])
      return scheme
    }

    /** One row of a menu; the same card and cells the Menu primitive draws. */
    const MENU_ITEM_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      width: '100%',
      minHeight: '34px',
      padding: '6px 8px',
      border: 'none',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'transparent',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, currentColor)',
      textAlign: 'left',
    }

    /**
     * Hover, focus, the menu card and the code palette cannot live in inline styles. The class
     * names are this bundle's own; the tokens are the application's, so both themes follow.
     */
    const MENU_CSS = `
.dsh-mermaid-menu { box-sizing:border-box; position:absolute; top:calc(100% + 4px); left:0; z-index:100; min-width:144px; max-width:360px; padding:4px; display:flex; flex-direction:column; border:0; border-radius:var(--dsw-radius-lg, 10px); background:var(--dsw-specific-menu, var(--dsw-alias-bg-base, #ffffff)); --dsw-elevation-stroke-color:var(--dsw-alias-border-l1); box-shadow:var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.18)); }
.dsh-mermaid-menu-end { left:auto; right:0; }
.dsh-mermaid-menu-up { top:auto; bottom:calc(100% + 4px); }
.dsh-mermaid-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }
.dsh-mermaid-menu-item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); outline: none; }
.dsh-mermaid-tool:hover, .dsh-mermaid-trigger:hover { color: var(--dsw-alias-label-primary, currentColor); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }
.dsh-mermaid-tool:focus-visible, .dsh-mermaid-trigger:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4a7dff)); outline-offset: -2px; }
.dsh-mermaid-surface { outline: none; }
.dsh-mermaid-surface:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4a7dff)); outline-offset: -2px; }
.dsh-mermaid-code .hljs-keyword { color: var(--dsw-alias-brand-primary, currentColor); font-weight: 500; }
.dsh-mermaid-code .hljs-built_in { color: var(--dsw-alias-state-business-primary, currentColor); }
.dsh-mermaid-code .hljs-string { color: var(--dsw-alias-state-success-primary, currentColor); }
.dsh-mermaid-code .hljs-number, .dsh-mermaid-code .hljs-literal { color: var(--dsw-alias-state-warn-primary, currentColor); }
.dsh-mermaid-code .hljs-comment, .dsh-mermaid-code .hljs-meta { color: var(--dsw-alias-label-tertiary, currentColor); }
.dsh-mermaid-code .hljs-operator { color: var(--dsw-alias-label-primary, currentColor); }
.dsh-mermaid-code .hljs-punctuation { color: var(--dsw-alias-label-secondary, currentColor); }
.dsh-mermaid-code .hljs-title, .dsh-mermaid-code .hljs-name, .dsh-mermaid-code .hljs-section { color: var(--dsw-alias-label-primary, currentColor); font-weight: 500; }
`

    // The header row and its controls are copies of the built-in preview's: a 38px row with a
    // hairline under it, the path on the left, and 28px tool buttons on the right.
    const HEADER_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      flex: 'none',
      boxSizing: 'border-box',
      height: '38px',
      padding: '0 6px 0 16px',
      borderBottom: '0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.2))',
    }
    const PATH_STYLE = {
      flex: '1',
      minWidth: 0,
      marginRight: '12px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      font: 'inherit',
      fontSize: '13px',
      color: 'var(--dsw-alias-label-tertiary, currentColor)',
    }
    const PATH_NAME_STYLE = { color: 'var(--dsw-alias-label-primary, currentColor)' }
    const TOOL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '28px',
      height: '28px',
      flex: 'none',
      padding: '6px',
      border: 'none',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, currentColor)',
      cursor: 'pointer',
      lineHeight: 1,
    }
    const TRIGGER_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '28px',
      maxWidth: '160px',
      flex: 'none',
      padding: '0 8px',
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, currentColor)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '12px',
    }
    const MENU_ROOT_STYLE = { position: 'relative', display: 'inline-flex' }
    const MENU_LABEL_STYLE = {
      flex: '1',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const MENU_CHECK_STYLE = { flex: 'none', width: '14px', height: '14px' }
    const DIAGRAM_VIEW_STYLE = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }
    const ZOOM_BAR_STYLE = {
      position: 'absolute',
      right: '12px',
      bottom: '12px',
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      padding: '2px',
      border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
      borderRadius: 'var(--dsw-radius-lg, 10px)',
      background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, #ffffff))',
      boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.18))',
    }
    const ZOOM_VALUE_STYLE = {
      minWidth: '44px',
      height: '26px',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-secondary, currentColor)',
      font: 'inherit',
      fontSize: '12px',
      fontVariantNumeric: 'tabular-nums',
    }
    const DIAGRAM_SURFACE_STYLE = {
      position: 'relative',
      flex: 1,
      minHeight: 0,
      overflow: 'hidden',
      cursor: 'grab',
      touchAction: 'none',
      userSelect: 'none',
    }
    /** Mermaid's own sizing is replaced so the transform is the only scaling in play. */
    const DIAGRAM_CANVAS_STYLE = {
      position: 'absolute',
      top: 0,
      left: 0,
      transformOrigin: '0 0',
      willChange: 'transform',
    }
    const DIAGRAM_NOTE_STYLE = {
      color: 'var(--dsw-alias-label-tertiary, currentColor)',
      fontSize: '13px',
      lineHeight: '20px',
      padding: '16px',
      textAlign: 'center',
    }
    const SOURCE_STYLE = {
      flex: 1,
      minHeight: 0,
      margin: 0,
      padding: '10px 12px',
      overflow: 'auto',
      color: 'var(--dsw-alias-label-secondary, currentColor)',
      font: 'var(--dsw-font-xs-13, 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace)',
      tabSize: 4,
      whiteSpace: 'pre',
    }
    const ERROR_SOURCE_STYLE = { ...SOURCE_STYLE, flex: 'none', maxHeight: '40vh', padding: '8px 10px' }
    /** Zoom limits, the same 25%–400% the built-in preview allows. */
    const ZOOM_MIN = 0.25
    const ZOOM_MAX = 4
    /** One step is a 25% increase and its exact inverse, so in-then-out returns to the start. */
    const ZOOM_IN_STEP = 1.25
    const ZOOM_OUT_STEP = 0.8

    /**
     * Where a file can be opened, read from the same Remote namespace the shipped
     * 「打开方式」 control uses (`remote.session.canOpenWorkspacePath` / `workspacePathApplications`
     * / `openWorkspacePath`). A third-party tab body is not handed the platform's own slot
     * renderer, so this reads the same Remote face directly instead of projecting a slot it
     * cannot reach. Every access is lazy: no Remote, or no answer, simply means no control.
     */
    function openTargets(ctx, absolutePath) {
      const remoteOf = () => {
        try {
          const remote = ctx.get('remote')
          const session = remote?.session
          return typeof session?.workspacePathApplications === 'function' ? session : undefined
        } catch {
          return undefined
        }
      }
      return {
        available: async () => {
          const session = remoteOf()
          if (session === undefined || typeof session.canOpenWorkspacePath !== 'function') return false
          try {
            const answer = await session.canOpenWorkspacePath()
            return answer?.ok === true && answer.value === true
          } catch {
            return false
          }
        },
        list: async (signal) => {
          const session = remoteOf()
          if (session === undefined) return undefined
          try {
            const answer = await session.workspacePathApplications({ path: absolutePath }, signal)
            if (answer?.ok !== true || !Array.isArray(answer.value)) return undefined
            // The same validation the shipped reader applies, so a malformed entry is dropped
            // rather than rendered as a blank row that opens nothing.
            const associated = answer.value.filter(
              (entry) =>
                entry !== null &&
                typeof entry === 'object' &&
                typeof entry.id === 'string' &&
                entry.id !== '' &&
                typeof entry.name === 'string',
            )
            // macOS answers per file type, and a type it associates with nothing — `.mmd` — gets
            // no rows at all. Fall back to the applications the platform knows are installed,
            // which is the same list its own editor shortcut offers.
            return associated.length > 0 ? associated : await installedApplications(signal)
          } catch {
            return undefined
          }
        },
        open: async (application) => {
          const session = remoteOf()
          if (session === undefined) return false
          try {
            const request =
              application === undefined
                ? { path: absolutePath, action: 'reveal' }
                : { path: absolutePath, application }
            const answer = await session.openWorkspacePath(request)
            return answer?.ok === true
          } catch {
            return false
          }
        },
      }
    }

    /**
     * The applications the platform knows are installed, as ids, in its own menu order — the
     * list its 「在编辑器中打开」 shortcut uses (`GET /open-in-app/apps`). Unlike the association
     * list, it does not depend on the file's type, so it is what a `.mmd` — a type macOS
     * associates with nothing — has left. Names come from a small table, the id otherwise.
     */
    const KNOWN_APP_NAMES = {
      cursor: 'Cursor',
      vscode: 'Visual Studio Code',
      vscodeinsiders: 'VS Code Insiders',
      windsurf: 'Windsurf',
      zed: 'Zed',
      sublimetext: 'Sublime Text',
      xcode: 'Xcode',
      androidstudio: 'Android Studio',
      textmate: 'TextMate',
    }

    async function installedApplications(signal) {
      try {
        const response = await fetch('/open-in-app/apps', { headers: { accept: 'application/json' }, signal })
        if (!response.ok) return undefined
        const payload = await response.json()
        if (!Array.isArray(payload?.apps)) return undefined
        return payload.apps
          .filter((id) => typeof id === 'string' && id !== '')
          .map((id, index) => ({ id, name: KNOWN_APP_NAMES[id] ?? id, default: index === 0 }))
      } catch {
        return undefined
      }
    }

    /**
     * The plugin's own Host header, as the adapter describes it.
     *
     * The chrome used to send one plugin's header for every plugin, which the other Host answered
     * with 403 — so its diagnostic reports were silently dropped. The header name is the plugin's,
     * and now comes from there.
     */
    const authHeader = (bridge) =>
      typeof bridge?.header === 'string' && bridge.header !== ''
        ? { [bridge.header]: bridge.nonce }
        : {}

    /** The icon cell of one application row: 14px, like the shipped control's. */
    const APP_ICON_STYLE = { width: '14px', height: '14px', flex: 'none', borderRadius: '3px', objectFit: 'contain' }

    /**
     * Where one application's icon comes from. The association list answers with its own icon — a
     * URL or data URI — while the installed list is ids only, and its icons come from the
     * platform's own route.
     */
    const appIcon = (app) =>
      app === undefined
        ? undefined
        : typeof app.icon === 'string' && app.icon !== ''
          ? app.icon
          : `/open-in-app/icon/${encodeURIComponent(app.id)}`

    /**
     * Where a file can be opened, read from the same Remote namespace the shipped
     * 「打开方式」 control uses (`remote.session.canOpenWorkspacePath` / `workspacePathApplications`
     * / `openWorkspacePath`). A third-party tab body is not handed the platform's own slot
     * renderer, so this reads the same Remote face directly instead of projecting a slot it
     * cannot reach. Every access is lazy: no Remote, or no answer, simply means no control.
     */
    function openTargets(ctx, absolutePath) {
      const remoteOf = () => {
        try {
          const remote = ctx.get('remote')
          const session = remote?.session
          return typeof session?.workspacePathApplications === 'function' ? session : undefined
        } catch {
          return undefined
        }
      }
      return {
        available: async () => {
          const session = remoteOf()
          if (session === undefined || typeof session.canOpenWorkspacePath !== 'function') return false
          try {
            const answer = await session.canOpenWorkspacePath()
            return answer?.ok === true && answer.value === true
          } catch {
            return false
          }
        },
        list: async (signal) => {
          const session = remoteOf()
          if (session === undefined) return undefined
          try {
            const answer = await session.workspacePathApplications({ path: absolutePath }, signal)
            if (answer?.ok !== true || !Array.isArray(answer.value)) return undefined
            // The same validation the shipped reader applies, so a malformed entry is dropped
            // rather than rendered as a blank row that opens nothing.
            const associated = answer.value.filter(
              (entry) =>
                entry !== null &&
                typeof entry === 'object' &&
                typeof entry.id === 'string' &&
                entry.id !== '' &&
                typeof entry.name === 'string',
            )
            // macOS answers per file type, and a type it associates with nothing — `.mmd` — gets
            // no rows at all. Fall back to the applications the platform knows are installed,
            // which is the same list its own editor shortcut offers.
            return associated.length > 0 ? associated : await installedApplications(signal)
          } catch {
            return undefined
          }
        },
        open: async (application) => {
          const session = remoteOf()
          if (session === undefined) return false
          try {
            const request =
              application === undefined
                ? { path: absolutePath, action: 'reveal' }
                : { path: absolutePath, application }
            const answer = await session.openWorkspacePath(request)
            return answer?.ok === true
          } catch {
            return false
          }
        },
      }
    }

    /**
     * The applications the platform knows are installed, as ids, in its own menu order — the
     * list its 「在编辑器中打开」 shortcut uses (`GET /open-in-app/apps`). Unlike the association
     * list, it does not depend on the file's type, so it is what a `.mmd` — a type macOS
     * associates with nothing — has left. Names come from a small table, the id otherwise.
     */
    /** The tick the Menu primitive draws on the active row. */
    const checkIcon = () =>
      React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: '14',
          height: '14',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: MENU_CHECK_STYLE,
        },
        React.createElement('path', { d: 'M3 8.5l3.2 3.2L13 5' }),
      )
    /** The reload control the preview's header carries, in the same 28px cell. */
    const reloadIcon = () =>
      React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: '15',
          height: '15',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
        React.createElement('path', { d: 'M13 2.5V5h-2.5' }),
      )

    /** Escaping for the code view when the chunk that highlights has not been loaded. */
    const escapeHtml = (text) =>
      text.replace(/[&<>]/g, (character) => (character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;'))

    /**
     * The body of one diagram tab: read the source, then show it either as the rendered
     * diagram — which pans and zooms — or as its own text, chosen from the same kind of
     * dropdown the Markdown renderer uses.
     */
    /**
     * Build one preview's tab body.
     *
     * @param ctx - the plugin's Cordis context.
     * @param adapter - what this preview renders:
     *   `read(file, signal)` answers the source and its Host path (through the plugin's own
     *   route), `load()` answers its lazily fetched chunk, `prepare(source, { scheme, chunk })`
     *   answers `{ svg }` or `{ invalid }`, `highlight(source, chunk)` answers the code view's
     *   HTML, `bridge()` answers the Host's nonce and routes, and `diagRoute` names its
     *   diagnostic endpoint.
     */
    function createPreviewBody(ctx, adapter) {
      return function DiagramBody(props) {
        // The tab record arrives through the slot's own hook, not as a prop: the injected face
        // hands over `useTabInfo`, and `{ sidebar, panel, tab }` comes from calling it. Reading
        // `props.tab` instead threw on the first render, and a render that throws renders an
        // empty pane with no message to act on.
        // `renderSlot` is the tab face's own slot renderer, and the shipped previews use it to
        // project the shared header controls — the 「打开方式」 menu among them — into their own
        // header. Rendering the slot rather than copying the control means this preview gets the
        // same one, from whoever registered it.
        const { useTabInfo, useResource, renderSlot } = props
        const tab = typeof useTabInfo === 'function' ? useTabInfo()?.tab : undefined
        const address = tab === undefined ? undefined : tab.contentId
        /** Parsed once, for the header and for the read. */
        const file = address === undefined ? undefined : parseFileAddress(address)
        // The file's observed version is how a Resource reports a change, and the revision
        // steps on every navigation: either one means the rendered diagram is stale.
        const stat = typeof useResource === 'function' && address !== undefined ? useResource(address) : undefined
        const version = stat?.version
        const revision = tab?.navigation?.revision
        const scheme = useColorScheme(ctx)
        const [mode, setMode] = React.useState('diagram')
        const [state, setState] = React.useState({ phase: 'loading' })
        const [reload, setReload] = React.useState(0)
        /** The absolute path this bundle's Host route resolved, when it answered. */
        const [hostPath, setHostPath] = React.useState(undefined)
        /**
         * The Host path the shared header actions act on. `useResource` hands back a snapshot:
         * the resource's own fields live under `value`, which is where the shipped preview reads
         * `absolutePath` from too (`useResource(tab.contentId).value?.absolutePath`).
         */
        const resourcePath = stat?.value?.absolutePath ?? stat?.absolutePath
        const absolutePath =
          (typeof resourcePath === 'string' && resourcePath !== '' ? resourcePath : undefined) ?? hostPath

        const [view, setView] = React.useState({ scale: 1, x: 0, y: 0 })
        const [zoomOpen, setZoomOpen] = React.useState(false)
        const [viewOpen, setViewOpen] = React.useState(false)
        const [openMenu, setOpenMenu] = React.useState(false)
        /** Where this file can be opened: the same question the shipped control asks. */
        const [openState, setOpenState] = React.useState({ phase: 'idle', apps: [] })
        const [natural, setNatural] = React.useState(undefined)

        React.useEffect(() => {
          if (absolutePath === undefined) {
            setOpenState({ phase: 'idle', apps: [] })
            return undefined
          }
          let cancelled = false
          const targets = openTargets(ctx, absolutePath)
          void (async () => {
            if (!(await targets.available())) {
              if (!cancelled) setOpenState({ phase: 'unavailable', apps: [] })
              return
            }
            if (cancelled) return
            setOpenState({ phase: 'loading', apps: [] })
            const apps = await targets.list(undefined)
            if (!cancelled) setOpenState({ apps: apps ?? [], phase: apps === undefined ? 'failed' : 'ready' })
          })()
          return () => {
            cancelled = true
          }
        }, [absolutePath])

        const surface = React.useRef(null)
        const canvas = React.useRef(null)
        /**
         * The canvas node, as state.
         *
         * Switching to the code view unmounts the surface, and switching back mounts a new node.
         * An effect whose dependencies are the source alone does not run again for that, so the
         * drawing was never re-fitted and the wheel listener was never re-attached to the node
         * that is actually on screen. Keeping the node in state makes "the canvas came back" a
         * dependency in its own right.
         */
        const [canvasNode, setCanvasNode] = React.useState(null)
        const bindCanvas = React.useCallback((node) => {
          canvas.current = node
          setCanvasNode(node)
        }, [])
        const drag = React.useRef(undefined)

        React.useEffect(() => {
          if (address === undefined) {
            setState({ phase: 'error', message: '这个标签没有可读的地址' })
            return undefined
          }
          if (file === undefined) {
            setState({ phase: 'error', message: '无法从标签地址解析出文件' })
            return undefined
          }
          let cancelled = false
          const run = async () => {
            try {
              setState({ phase: 'loading' })
              const read = await adapter.read(file, tab.signal)
              const source = read.text
              if (!cancelled) setHostPath(read.path)
              const chunk = await adapter.load()
              // Highlighting rides along in the chunk the diagram already loaded: same lazy
              // fetch, so the code view costs no second download.
              const highlight =
                typeof adapter.highlight === 'function' ? adapter.highlight(source, chunk) : undefined
              const outcome = await adapter.prepare(source, { scheme, chunk, signal: tab.signal })
              if (cancelled) return
              if (outcome.invalid !== undefined) {
                setState({ phase: 'invalid', message: outcome.invalid, source, highlight })
                return
              }
              setState({ phase: 'ready', source, highlight, svg: outcome.svg })
            } catch (error) {
              if (cancelled) return
              const message = messageOf(error)
              console.warn('[dsh-mermaid] the diagram could not be read', error)
              setState({ phase: 'error', message })
            }
          }
          void run()
          return () => {
            cancelled = true
          }
        }, [address, version, revision, scheme, reload])

        // Mermaid sizes its SVG for a document, not for a viewport that pans and zooms. Read
        // the drawing's own box once it exists, pin the canvas to it, and fit it to the pane.
        React.useEffect(() => {
          if (state.phase !== 'ready' || canvas.current === null) return
          const svg = canvas.current.querySelector('svg')
          if (svg === null) return
          svg.removeAttribute('style')
          const box = svg.viewBox === undefined ? undefined : svg.viewBox.baseVal
          const width = box !== undefined && box.width > 0 ? box.width : svg.getBoundingClientRect().width
          const height = box !== undefined && box.height > 0 ? box.height : svg.getBoundingClientRect().height
          if (!(width > 0) || !(height > 0)) return
          svg.setAttribute('width', String(width))
          svg.setAttribute('height', String(height))
          setNatural({ width, height })
          const pane = surface.current
          if (pane === null) return
          const scale = Math.min(
            ZOOM_MAX,
            Math.max(ZOOM_MIN, Math.min((pane.clientWidth - 24) / width, (pane.clientHeight - 24) / height)),
          )
          setView({
            scale,
            x: Math.max(12, (pane.clientWidth - width * scale) / 2),
            y: Math.max(12, (pane.clientHeight - height * scale) / 2),
          })
        }, [state.phase, state.svg, canvasNode])

        // A menu that ignores Escape or a click elsewhere is the classic plugin-UI bug.
        React.useEffect(() => {
          if (!viewOpen && !zoomOpen && !openMenu) return undefined
          const onPointerDown = (event) => {
            if (event.target instanceof Element && event.target.closest('[data-mermaid-menu]') !== null) return
            setViewOpen(false)
            setZoomOpen(false)
          }
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return
            setViewOpen(false)
            setZoomOpen(false)
            setOpenMenu(false)
          }
          document.addEventListener('pointerdown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [viewOpen, zoomOpen, openMenu])

        /** Zoom about a point in the pane, so the drawing stays under the pointer. */
        const zoomAt = (factor, pointX, pointY) => {
          setView((current) => {
            const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current.scale * factor))
            const ratio = scale / current.scale
            return { scale, x: pointX - (pointX - current.x) * ratio, y: pointY - (pointY - current.y) * ratio }
          })
        }
        const zoomCentre = (factor) => {
          const pane = surface.current
          zoomAt(factor, pane === null ? 0 : pane.clientWidth / 2, pane === null ? 0 : pane.clientHeight / 2)
        }
        const fitToPane = () => {
          const pane = surface.current
          if (pane === null || natural === undefined) return
          const scale = Math.min(
            ZOOM_MAX,
            Math.max(ZOOM_MIN, Math.min((pane.clientWidth - 24) / natural.width, (pane.clientHeight - 24) / natural.height)),
          )
          setView({
            scale,
            x: Math.max(12, (pane.clientWidth - natural.width * scale) / 2),
            y: Math.max(12, (pane.clientHeight - natural.height * scale) / 2),
          })
        }
        const onWheel = (event) => {
          const pane = surface.current
          const rect = pane === null ? undefined : pane.getBoundingClientRect()
          // A pinch arrives as a wheel event with ctrlKey set; a plain wheel zooms too, which
          // is what a viewer is expected to do. Shift turns the wheel into a pan, and the
          // pointer is the anchor either way.
          if (event.shiftKey) {
            event.preventDefault()
            setView((current) => ({ ...current, x: current.x - event.deltaY, y: current.y }))
            return
          }
          event.preventDefault()
          const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
          zoomAt(
            factor,
            rect === undefined ? 0 : event.clientX - rect.left,
            rect === undefined ? 0 : event.clientY - rect.top,
          )
        }
        const onPointerDown = (event) => {
          if (event.button !== 0) return
          // Clicking the drawing hands it focus, so the keyboard can drive the zoom next.
          event.currentTarget.focus?.()
          // A press is only a drag once the pointer moves: capturing here would retarget the
          // click this press produces to the surface, and every control inside it — the zoom
          // bar and its menus — would stop receiving clicks at all.
          drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, captured: false }
        }
        const onPointerMove = (event) => {
          const start = drag.current
          if (start === undefined) return
          const dx = event.clientX - start.x
          const dy = event.clientY - start.y
          if (!start.captured) {
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
            start.captured = true
            event.currentTarget.setPointerCapture?.(start.pointerId)
          }
          drag.current = { ...start, x: event.clientX, y: event.clientY }
          setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
        }
        const onPointerUp = (event) => {
          const start = drag.current
          drag.current = undefined
          if (start !== undefined && start.captured) event.currentTarget.releasePointerCapture?.(start.pointerId)
        }
        /** The keyboard's part of the same gesture set: step, fit, pan. */
        const onKeyDown = (event) => {
          const key = event.key
          if (key === '+' || key === '=') {
            event.preventDefault()
            zoomCentre(ZOOM_IN_STEP)
          } else if (key === '-' || key === '_') {
            event.preventDefault()
            zoomCentre(ZOOM_OUT_STEP)
          } else if (key === '0') {
            event.preventDefault()
            fitToPane()
          } else if (key.startsWith('Arrow')) {
            event.preventDefault()
            const step = event.shiftKey ? 80 : 24
            setView((current) => ({
              ...current,
              x: current.x + (key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0),
              y: current.y + (key === 'ArrowDown' ? step : key === 'ArrowUp' ? -step : 0),
            }))
          }
        }
        // The wheel listener is attached natively and non-passively on purpose: React's
        // synthetic `onWheel` is passive, so `preventDefault()` there cannot stop the browser's
        // own ⌘-wheel page zoom. Stopping propagation keeps the synthetic handler from applying
        // the same gesture twice.
        const wheelHandler = React.useRef(undefined)
        wheelHandler.current = onWheel
        React.useEffect(() => {
          const pane = surface.current
          if (pane === null) return undefined
          const handler = (event) => {
            wheelHandler.current(event)
            event.stopPropagation()
          }
          pane.addEventListener('wheel', handler, { passive: false })
          return () => pane.removeEventListener('wheel', handler)
        }, [state.phase, canvasNode])

        // What this preview can actually do, once per state change: the page's console is not
        // reachable from the Host, and "the control is missing" is otherwise indistinguishable
        // from "the face never handed over a slot renderer". Booleans and type names only.
        React.useEffect(() => {
          if (state.phase === 'loading') return
          const bridge = adapter.bridge()
          if (bridge === undefined) return
          void fetch(adapter.diagRoute ?? bridge.diagRoute, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeader(bridge) },
            body: JSON.stringify({
              renderSlot: typeof renderSlot,
              resourcePath: resourcePath === undefined ? 'no' : 'yes',
              hostPath: hostPath === undefined ? 'no' : 'yes',
              projected: absolutePath === undefined ? 'no' : 'yes',
              openWith: openState.phase,
              openApps: openState.apps.length,
              mode,
              canvas: canvasNode === null ? 'no' : 'yes',
              svgLength: typeof state.svg === 'string' ? state.svg.length : 0,
              scale: Math.round(view.scale * 100),
              natural: natural === undefined ? 'no' : 'yes',
              phase: state.phase,
            }),
          }).catch(() => {})
        }, [
          state.phase,
          hostPath,
          absolutePath,
          resourcePath,
          openState.phase,
          openState.apps.length,
          mode,
          canvasNode,
          state.svg,
          natural,
        ])

        /**
         * Report an uncaught error once, with its stack.
         *
         * A throw around a preview leaves no trace the Host can see: the page's console is not
         * reachable from here, and the platform's own error paths are outside this bundle. This
         * listener reports the message and the first frames, nothing else, to the plugin's
         * diagnostic route — the same route and the same discipline as the render report.
         */
        React.useEffect(() => {
          const bridge = adapter.bridge()
          if (bridge === undefined) return undefined
          const onError = (event) => {
            const error = event?.error
            void fetch(adapter.diagRoute ?? bridge.diagRoute, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...authHeader(bridge) },
              body: JSON.stringify({
                kind: 'uncaught',
                message: String(event?.message ?? error?.message ?? '').slice(0, 240),
                stack: String(error?.stack ?? '').split('\n').slice(0, 6).join(' | ').slice(0, 900),
              }),
            }).catch(() => {})
          }
          window.addEventListener('error', onError)
          return () => window.removeEventListener('error', onError)
        }, [])

        /** Open the file with one application, or reveal it. A failure is said, not swallowed. */
        const runOpen = async (application) => {
          setOpenMenu(false)
          const ok = await openTargets(ctx, absolutePath).open(application)
          if (!ok) setOpenState((current) => ({ ...current, failure: true }))
        }

        const viewItem = (key, label, active, onClick) =>
          React.createElement(
            'button',
            {
              key,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': active,
              className: 'dsh-mermaid-menu-item',
              style: MENU_ITEM_STYLE,
              onClick: () => {
                setViewOpen(false)
                onClick()
              },
            },
            React.createElement('span', { key: 'label', style: MENU_LABEL_STYLE }, label),
            active ? React.createElement(React.Fragment, { key: 'tick' }, checkIcon()) : null,
          )
        const zoomChoice = (choice) =>
          React.createElement(
            'button',
            {
              key: `zoom-${choice}`,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': Math.abs(view.scale - choice) < 0.001,
              className: 'dsh-mermaid-menu-item',
              style: MENU_ITEM_STYLE,
              onClick: () => {
                setZoomOpen(false)
                const pane = surface.current
                const pointX = pane === null ? 0 : pane.clientWidth / 2
                const pointY = pane === null ? 0 : pane.clientHeight / 2
                setView((current) => {
                  const ratio = choice / current.scale
                  return { scale: choice, x: pointX - (pointX - current.x) * ratio, y: pointY - (pointY - current.y) * ratio }
                })
              },
            },
            React.createElement('span', { key: 'label', style: MENU_LABEL_STYLE }, `${choice * 100}%`),
            Math.abs(view.scale - choice) < 0.001 ? React.createElement(React.Fragment, { key: 'tick' }, checkIcon()) : null,
          )

        const source = state.source
        const children = [
          React.createElement('style', { key: 'css' }, MENU_CSS),
          React.createElement(
            'div',
            { key: 'header', style: HEADER_STYLE },
            React.createElement(
              'span',
              { key: 'path', style: PATH_STYLE, title: file === undefined ? '' : file.path },
              React.createElement('span', { style: PATH_NAME_STYLE }, file === undefined ? '' : basenameOf(file.path)),
            ),
            React.createElement(
              'div',
              { key: 'view', style: MENU_ROOT_STYLE, 'data-mermaid-menu': true },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-mermaid-trigger',
                  style: TRIGGER_STYLE,
                  'aria-haspopup': 'menu',
                  'aria-expanded': viewOpen,
                  'aria-label': '选择查看方式',
                  title: '选择查看方式',
                  onClick: () => setViewOpen(!viewOpen),
                },
                React.createElement('span', { style: MENU_LABEL_STYLE }, mode === 'diagram' ? '图表' : '代码'),
                React.createElement('span', { 'aria-hidden': 'true', style: { fontSize: '10px' } }, '▾'),
              ),
              viewOpen
                ? React.createElement(
                    React.Fragment,
                    null,
                    React.createElement('style', { key: 'css' }, MENU_CSS),
                    React.createElement(
                      'div',
                      { key: 'menu', role: 'menu', className: 'dsh-mermaid-menu dsh-mermaid-menu-end' },
                      viewItem('view-diagram', '图表', mode === 'diagram', () => setMode('diagram')),
                      viewItem('view-code', '代码', mode === 'code', () => setMode('code')),
                    ),
                  )
                : null,
            ),
            React.createElement(
              'button',
              {
                key: 'reload',
                type: 'button',
                className: 'dsh-mermaid-tool',
                style: TOOL_STYLE,
                title: '重新读取文件',
                'aria-label': '重新读取文件',
                onClick: () => setReload((count) => count + 1),
              },
              reloadIcon(),
            ),
            // This preview's own 「打开方式」, asking the same Remote namespace the shipped one
            // does. It stands in for a slot a third-party tab body is not handed the renderer for.
            openState.phase === 'ready' || openState.phase === 'failed'
              ? React.createElement(
                  'div',
                  { key: 'open-with', style: MENU_ROOT_STYLE, 'data-mermaid-menu': true },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-mermaid-trigger',
                      style: TRIGGER_STYLE,
                      'aria-haspopup': 'menu',
                      'aria-expanded': openMenu,
                      'aria-label': '打开方式',
                      title: '打开方式',
                      onClick: () => setOpenMenu(!openMenu),
                    },
                    // The shipped control falls back to a single glyph when it has no icon, and
                    // a type with no associated application can leave it with no row at all.
                    appIcon(openState.apps.find((app) => app.default) ?? openState.apps[0]) === undefined
                      ? React.createElement('span', { key: 'icon', 'aria-hidden': 'true', style: { fontSize: '12px' } }, '↗')
                      : React.createElement('img', {
                          key: 'icon',
                          src: appIcon(openState.apps.find((app) => app.default) ?? openState.apps[0]),
                          alt: '',
                          style: APP_ICON_STYLE,
                        }),
                    React.createElement('span', { 'aria-hidden': 'true', style: { fontSize: '10px' } }, '▾'),
                  ),
                  openMenu
                    ? React.createElement(
                        React.Fragment,
                        null,
                        React.createElement('style', { key: 'css' }, MENU_CSS),
                        React.createElement(
                          'div',
                          { key: 'menu', role: 'menu', className: 'dsh-mermaid-menu dsh-mermaid-menu-end' },
                          ...openState.apps.map((app) =>
                            React.createElement(
                              'button',
                              {
                                key: `app-${app.id}`,
                                type: 'button',
                                role: 'menuitem',
                                className: 'dsh-mermaid-menu-item',
                                style: MENU_ITEM_STYLE,
                                onClick: () => void runOpen(app.id),
                              },
                              React.createElement('img', {
                                key: 'icon',
                                src: appIcon(app),
                                alt: '',
                                style: APP_ICON_STYLE,
                              }),
                              React.createElement(
                                'span',
                                { style: MENU_LABEL_STYLE },
                                app.default === true ? `${app.name}（默认）` : app.name,
                              ),
                            ),
                          ),
                          React.createElement(
                            'button',
                            {
                              key: 'reveal',
                              type: 'button',
                              role: 'menuitem',
                              className: 'dsh-mermaid-menu-item',
                              style: MENU_ITEM_STYLE,
                              onClick: () => void runOpen(undefined),
                            },
                            React.createElement('span', { style: MENU_LABEL_STYLE }, '显示文件位置'),
                          ),
                          openState.failure === true
                            ? React.createElement(
                                'button',
                                {
                                  key: 'failed',
                                  type: 'button',
                                  role: 'menuitem',
                                  disabled: true,
                                  className: 'dsh-mermaid-menu-item',
                                  style: { ...MENU_ITEM_STYLE, opacity: 0.5 },
                                },
                                React.createElement('span', { style: MENU_LABEL_STYLE }, '打开失败，请重试'),
                              )
                            : null,
                        ),
                      )
                    : null,
                )
              : null,
          ),
        ]
        if (mode === 'code') {
          // A failed read must say so here too: the code view is where a broken preview is
          // diagnosed, and a permanent "loading" note told the user nothing.
          children.push(
            source !== undefined
              ? React.createElement('pre', {
                  key: 'source',
                  className: 'dsh-mermaid-code',
                  style: SOURCE_STYLE,
                  dangerouslySetInnerHTML: { __html: state.highlight ?? escapeHtml(source) },
                })
              : React.createElement(
                  'div',
                  { key: 'note', style: DIAGRAM_NOTE_STYLE },
                  state.phase === 'error' ? state.message : '正在读取源码…',
                ),
          )
        } else if (state.phase === 'ready') {
          children.push(
            React.createElement(
              'div',
              {
                key: 'surface',
                ref: surface,
                tabIndex: 0,
                className: 'dsh-mermaid-surface',
                style: DIAGRAM_SURFACE_STYLE,
                onWheel,
                onKeyDown,
                onPointerDown,
                onPointerMove,
                onPointerUp,
                onPointerCancel: onPointerUp,
              },
              React.createElement('div', {
                key: 'canvas',
                ref: bindCanvas,
                style: {
                  ...DIAGRAM_CANVAS_STYLE,
                  // Whole pixels for the translation: zooming anchors on a pointer, which leaves
                  // fractional offsets that only make the DOM noisier to read.
                  transform: `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.scale})`,
                },
                // Mermaid sanitizes its own output (`securityLevel: 'strict'`).
                dangerouslySetInnerHTML: { __html: state.svg },
              }),
              React.createElement(
                'div',
                { key: 'zoom', style: ZOOM_BAR_STYLE, 'data-mermaid-menu': true },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-mermaid-tool',
                    style: { ...TOOL_STYLE, width: '26px', height: '26px' },
                    title: '缩小',
                    'aria-label': '缩小',
                    disabled: view.scale <= ZOOM_MIN,
                    onClick: () => zoomCentre(ZOOM_OUT_STEP),
                  },
                  '−',
                ),
                React.createElement(
                  'button',
                  {
                    key: 'zoom-value',
                    type: 'button',
                    title: '选择缩放比例',
                    'aria-label': '选择缩放比例',
                    'aria-haspopup': 'menu',
                    'aria-expanded': zoomOpen,
                    style: ZOOM_VALUE_STYLE,
                    onClick: () => setZoomOpen(!zoomOpen),
                  },
                  `${Math.round(view.scale * 100)}%`,
                ),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-mermaid-tool',
                    style: { ...TOOL_STYLE, width: '26px', height: '26px' },
                    title: '放大',
                    'aria-label': '放大',
                    disabled: view.scale >= ZOOM_MAX,
                    onClick: () => zoomCentre(ZOOM_IN_STEP),
                  },
                  '+',
                ),
                zoomOpen
                  ? React.createElement(
                      React.Fragment,
                      null,
                      React.createElement('style', { key: 'css' }, MENU_CSS),
                      React.createElement(
                        'div',
                        {
                          key: 'menu',
                          role: 'menu',
                          className: 'dsh-mermaid-menu dsh-mermaid-menu-end dsh-mermaid-menu-up',
                        },
                        ...[0.25, 0.5, 1, 1.5, 2].map(zoomChoice),
                        React.createElement(
                          'button',
                          {
                            key: 'fit',
                            type: 'button',
                            role: 'menuitem',
                            className: 'dsh-mermaid-menu-item',
                            style: MENU_ITEM_STYLE,
                            onClick: () => {
                              setZoomOpen(false)
                              fitToPane()
                            },
                          },
                          React.createElement('span', { key: 'label', style: MENU_LABEL_STYLE }, '适应宽度'),
                        ),
                      ),
                    )
                  : null,
              ),
            ),
          )
        } else if (state.phase === 'invalid') {
          children.push(
            React.createElement(
              'div',
              { key: 'invalid', style: DIAGRAM_NOTE_STYLE },
              React.createElement('div', null, `Mermaid 语法错误：${state.message}`),
              React.createElement('pre', {
                className: 'dsh-mermaid-code',
                style: ERROR_SOURCE_STYLE,
                dangerouslySetInnerHTML: { __html: state.highlight ?? escapeHtml(state.source ?? '') },
              }),
            ),
          )
        } else if (state.phase === 'error') {
          children.push(React.createElement('div', { key: 'error', style: DIAGRAM_NOTE_STYLE }, state.message))
        } else {
          children.push(React.createElement('div', { key: 'loading', style: DIAGRAM_NOTE_STYLE }, '正在渲染图表…'))
        }
        return React.createElement('div', { style: DIAGRAM_VIEW_STYLE }, children)
      }
    }

    return {
      /** Everything a preview plugin needs, in the order it usually wants it. */
      parseFileAddress,
      basenameOf,
      createPreviewBody,
      /** A plugin with nothing to register: this bundle exists to be required. */
      inject: [],
      apply() {},
    }
  },
})
