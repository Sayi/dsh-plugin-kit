/**
 * Browser half of the `dsh-file-session` bundle.
 *
 * One entry: the Session's own composer dock. In a Session running the
 * `file-session` Agent Preset it shows either
 *
 *   - 「选择一个文件」 — pick a file, which opens in the right Sidebar and becomes
 *     the Session's one bound file, or
 *   - the bound file itself, once it exists — whether the user picked it or the
 *     Agent created it in conversation.
 *
 * There is no way to switch or release: the Host refuses a second binding, and the
 * Agent's guard refuses writes to anything but the bound file. Another file means
 * another Session.
 *
 * The Host owns enforcement; this half owns the durable copy of the binding and
 * the visible state.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-session',
  factory(require) {
    const React = require('react')

    /** The Agent Preset this entry belongs to; declared in `cordis.patch.yml`. */
    const PRESET_ID = 'file-session'
    /** Files worth binding: kept in step with `DOCUMENT_EXTENSIONS` in `index.js`. */
    const SUPPORTED_EXTENSIONS = ['md', 'markdown', 'mmd', 'mermaid', 'txt', 'docx', 'xlsx', 'pptx']
    /** Where the binding lives between page loads, so a Host restart loses nothing. */
    const STORE_KEY = 'dsh-file-session:bindings'
    /** Every key this bundle answered to before it was renamed; read so no binding is lost. */
    const LEGACY_STORE_KEYS = [
      'dsh-file-focus:bindings',
      'dsh-create-file:bindings',
      'dsh-file-app:bindings',
    ]
    const DEFAULT_ROUTE = '/dsh-file-session/target'
    const DEFAULT_CREATE_ROUTE = '/dsh-file-session/create'
    const DEFAULT_HEALTH_ROUTE = '/dsh-file-session/health'
    /** The Mermaid extensions the 「新建」 action can produce; rendering them is a preview's job. */
    const MERMAID_EXTENSIONS = ['mmd', 'mermaid']
    /** Bumped whenever the browser half's wiring changes, so a stale page is recognisable. */
    const HEALTH_STAMP = '2026-10-13T22:56-pick-restored'
    /** How often, and how long, to wait for a file the Agent creates in conversation. */
    const REFRESH_MS = 1500
    const REFRESH_TRIES = 100
    /** The binding is recorded before the write that creates the file lands: give the file a moment. */
    const AUTO_OPEN_DELAY_MS = 700
    /** How long to wait for the right Sidebar to mount before giving up. */
    const MOUNT_ATTEMPTS = 60
    const MOUNT_INTERVAL_MS = 50
    const MOUNT_ERROR = /no session surface is mounted/
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
    /**
     * The services this half declares. Deliberately nothing else: a declared service is a
     * *hard* dependency of the entry's activation, and an unsatisfied one keeps the entry
     * inactive — which the desktop shell treats as a failed web boot. The diagram preview
     * therefore reads its file through this bundle's own Host route instead of injecting
     * the client's `remote.workspaceFiles`, so an optional feature cannot gate the boot.
     */
    const INJECT = ['slots', 'sessions', 'sidebarRight', 'sidebarRightTabs']

    // #region paths and addresses — browser-safe, POSIX and Windows spellings
    function isWindowsStylePath(value) {
      return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
    }

    function basenameOf(path) {
      const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
      return normalized.slice(normalized.lastIndexOf('/') + 1)
    }

    function extensionOf(path) {
      const name = basenameOf(path)
      const dot = name.lastIndexOf('.')
      return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
    }

    /** The same shape the Host compares, so both sides agree on "is this file inside the Session". */
    function comparable(path) {
      const unified = path.replace(/\\/g, '/')
      const absolute = isWindowsStylePath(unified) && !unified.startsWith('/') ? `/${unified}` : unified
      return absolute.replace(/\/+/g, '/').replace(/\/+$/, '')
    }

    function insideDirectory(path, directory) {
      const file = comparable(path)
      const root = comparable(directory)
      if (root === '') return false
      return file === root || file.startsWith(`${root}/`)
    }

    function resolveAgainst(path, directory) {
      const unified = path.replace(/\\/g, '/')
      if (unified.startsWith('/') || isWindowsStylePath(unified)) return unified
      if (directory === undefined) return undefined
      return `${comparable(directory)}/${unified}`
    }

    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
    const encodePath = (path) => path.split('/').map(encodeSegment).join('/')

    function sessionFileAddress(sessionId, path) {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
    }

    /** The address of a path as the caller holds it: inside the Session's root it goes relative. */
    function fileAddressFor(sessionId, cwd, path) {
      const normalized = path.replace(/\\/g, '/')
      if (!normalized.startsWith('/') && !isWindowsStylePath(normalized)) {
        return sessionFileAddress(sessionId, normalized)
      }
      const root = cwd === undefined ? '' : cwd.replace(/\\/g, '/').replace(/\/+$/, '')
      if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
      if (root !== '' && normalized.startsWith(`${root}/`)) {
        return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
      }
      return sessionFileAddress(sessionId, normalized)
    }
    // #endregion

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const messageOf = (error) => (error && error.message) || String(error)

    /** The absolute path of a picked file, when the desktop preload can supply one. */
    function pathOf(file) {
      const bridge = window.__DSH_HOST_PATHS__
      if (bridge !== undefined && typeof bridge.pathFor === 'function') {
        try {
          const path = bridge.pathFor(file)
          if (typeof path === 'string' && path !== '') return path
        } catch {
          /* fall through to the legacy Electron field */
        }
      }
      return typeof file.path === 'string' && file.path !== '' ? file.path : undefined
    }

    /** The Session's working directory, Agent Preset and blankness, as the client projection holds them. */
    function sessionRow(ctx, sessionId) {
      const sessions = ctx.get('sessions')
      const row = sessions === undefined ? undefined : sessions.list?.getSnapshot?.()?.byId?.[sessionId]
      if (row === undefined) return undefined
      return {
        cwd: typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined,
        blank: row.blank === true,
        preset:
          row.projectionValues !== undefined && typeof row.projectionValues.agentPreset === 'string'
            ? row.projectionValues.agentPreset
            : undefined,
      }
    }

    /** The Session on screen, for the component that does not receive one. */
    function displayedSessionId(ctx) {
      const uiSession = ctx.get('uiSession')
      const sessionId = uiSession === undefined ? undefined : uiSession.current?.value?.key
      return typeof sessionId === 'string' ? sessionId : undefined
    }

    // #region the binding: durable copy here, enforcement on the Host
    function readBindings() {
      try {
        let raw = window.localStorage.getItem(STORE_KEY)
        for (const legacy of LEGACY_STORE_KEYS) {
          if (raw !== null) break
          raw = window.localStorage.getItem(legacy)
        }
        const parsed = JSON.parse(raw ?? '{}')
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function persistBinding(sessionId, binding) {
      const next = readBindings()
      if (binding === undefined || binding === null) delete next[sessionId]
      else next[sessionId] = binding
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
      } catch {
        /* private mode: the Host copy still holds for this Host's lifetime */
      }
    }

    const readBinding = (sessionId) => {
      const stored = readBindings()[sessionId]
      return stored !== undefined && typeof stored.path === 'string' ? stored : undefined
    }

    /** The Host's per-process route and secret, injected into the page at boot. */
    function hostBridge() {
      const injected = window.__DSH_FILE_SESSION__
      if (injected === null || injected === undefined || typeof injected.nonce !== 'string') return undefined
      return {
        nonce: injected.nonce,
        route: typeof injected.route === 'string' ? injected.route : DEFAULT_ROUTE,
        createRoute: typeof injected.createRoute === 'string' ? injected.createRoute : DEFAULT_CREATE_ROUTE,
        healthRoute: DEFAULT_HEALTH_ROUTE,
      }
    }

    /**
     * Tell the Host what this half managed to register.
     *
     * The page console is not reachable from the Host side, so a registration that silently
     * does nothing — or throws inside a guard — is invisible without this. Only counts, the
     * stamp and an error name travel; the Host never learns a Session or a path from it.
     */
    function reportHealth(record) {
      const bridge = hostBridge()
      if (bridge === undefined) return
      const error = typeof record.error === 'string' ? record.error : ''
      try {
        void fetch(bridge.healthRoute, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-file-session': bridge.nonce },
          body: JSON.stringify({
            stamp: HEALTH_STAMP,
            injected: record.injected,
            seats: record.seats,
            diagramType: record.diagramType,
            diagramBody: record.diagramBody,
            error: error === '' ? undefined : error,
          }),
        }).catch(() => {})
      } catch {
        // Diagnostics must never be able to break the entry they describe.
      }
    }

    /** The Host's answer for one Session: its binding, and whether it is a focus Session. */
    async function fetchState(sessionId) {
      const bridge = hostBridge()
      if (bridge === undefined) return undefined
      try {
        const response = await fetch(`${bridge.route}?sessionId=${encodeURIComponent(sessionId)}`, {
          headers: { 'x-dsh-file-session': bridge.nonce },
        })
        if (!response.ok) return undefined
        const body = await response.json()
        if (body === null || typeof body !== 'object') return undefined
        return {
          target: body.target !== null && body.target !== undefined ? body.target : null,
          focus: body.focus === true,
        }
      } catch {
        return undefined
      }
    }

    /** Bind the Session to one file. The Host decides; a second, different file is refused. */
    async function postBinding(sessionId, binding) {
      const bridge = hostBridge()
      if (bridge === undefined) return { ok: false, error: '该入口需要在 DSH 桌面端中使用' }
      try {
        const response = await fetch(bridge.route, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-file-session': bridge.nonce },
          body: JSON.stringify({ sessionId, path: binding.path, cwd: binding.cwd }),
        })
        const body = await response.json().catch(() => undefined)
        if (response.ok && body !== undefined && body.ok === true) return { ok: true, target: body.target }
        return {
          ok: false,
          status: response.status,
          target: body !== undefined && body.target !== undefined && body.target !== null ? body.target : undefined,
          error: body !== undefined && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
        }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    }
    /**
     * Ask the Host to create one blank document (`kind` is `md` or `docx`) and bind
     * the Session to it. The name is the Host's to choose.
     */
    async function postCreate(sessionId, kind, cwd) {
      const bridge = hostBridge()
      if (bridge === undefined) return { ok: false, error: '该入口需要在 DSH 桌面端中使用' }
      try {
        const response = await fetch(bridge.createRoute, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-file-session': bridge.nonce },
          body: JSON.stringify({ sessionId, kind, cwd }),
        })
        const body = await response.json().catch(() => undefined)
        if (response.ok && body !== undefined && body.ok === true) return { ok: true, target: body.target }
        return {
          ok: false,
          status: response.status,
          target: body !== undefined && body.target !== undefined && body.target !== null ? body.target : undefined,
          error: body !== undefined && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
        }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    }

    // #endregion

    // #region the one action this half performs: reveal a file in the right Sidebar

    /**
     * Make a bound Session durable by starting its first turn.
     *
     * A Session that has never started a turn is `blank`, and the Harness hides blank
     * Sessions from the workspace list unless they are the selected one — so a file
     * created into a blank Session would outlive its Session as soon as the user walks
     * away. `blank` flips only on a real `turn/start`, so the honest fix is to say what
     * happened in the Session itself. The file is already bound before this runs, so the
     * Agent starts that turn already knowing its one writable file.
     */
    async function startSession(ctx, sessionId, text) {
      const sessions = ctx.get('sessions')
      const face = sessions === undefined ? undefined : sessions.binding?.(sessionId)?.session
      if (face === undefined || typeof face.prompt !== 'function') return false
      try {
        const result = await face.prompt([{ type: 'text', text }], 'queue')
        return result === undefined || result.ok !== false
      } catch (error) {
        console.warn('[dsh-file-session] could not start the Session', error)
        return false
      }
    }

    async function openResourceWhenMounted(ctx, address) {      for (let attempt = 0; attempt < MOUNT_ATTEMPTS; attempt += 1) {
        try {
          ctx.sidebarRight.openResource(address)
          return
        } catch (error) {
          if (!MOUNT_ERROR.test(messageOf(error))) throw error
          await delay(MOUNT_INTERVAL_MS)
        }
      }
      throw new Error('右侧栏未在预期时间内就绪')
    }
    // #endregion

    // #region view
    // The composer dock centres its entries itself (`._0NKbIW_dock` is a centred flex
    // row inside a side-padded root), so an entry there needs no box of its own.
    const INLINE_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      // The composer dock is one centred row shared with the usage meter, so this entry has to
      // shrink inside it rather than push: a chip that cannot shrink squeezes its own text into
      // two lines and stretches its neighbour.
      flex: '0 1 auto',
      flexWrap: 'nowrap',
      minWidth: 0,
      fontSize: '12px',
      lineHeight: '1.6',
      color: 'var(--dsw-alias-label-secondary, currentColor)',
    }

    // The input dock (hero/blank Sessions) is full-width, so an entry there has to
    // reproduce the composer card's box to line up with it — the same formula the
    // shipped docks (todo, goal, queue) use.
    const ROW_STYLE = {
      boxSizing: 'border-box',
      width:
        'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px))',
      maxWidth: 'var(--dsh-composer-card-max-width, 100%)',
      margin: '0 auto',
      // Match the card's own inner inset (`._0NKbIW_accessory`) so the label sits in
      // the same text column as the composer's content, not on the card's border.
      padding: '0 12px',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      fontSize: '12px',
      lineHeight: '1.6',
      color: 'var(--dsw-alias-label-secondary, currentColor)',
    }

    /** The blank layout's line of guidance: muted, centred over the composer it refers to. */
    const HERO_HINT_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-label-tertiary, currentColor)',
    }

    const CHIP_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      flex: '0 1 auto',
      minWidth: 0,
      maxWidth: '100%',
      padding: '2px 10px',
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
      borderRadius: '999px',
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
      // A chip is one line by definition; the file name is what gives way, not the wording.
      whiteSpace: 'nowrap',
    }

    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '26px',
      padding: '0 10px',
      border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
      borderRadius: '999px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, currentColor)',
      cursor: 'pointer',
      font: 'inherit',
    }

    const LINK_STYLE = {
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, currentColor)',
      cursor: 'pointer',
      font: 'inherit',
      fontWeight: 500,
      padding: '0 2px',
      // The name takes the room that is left and ellipsizes; it never claims a width of its own.
      flex: '0 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    const NOTICE_STYLE = { color: 'var(--dsw-alias-label-error, #d4380d)', minWidth: 0 }

    /** One pill-shaped action; the hero layout lays several of these out flat. */
    const actionButton = (key, label, onClick, disabled) =>
      React.createElement('button', { key, type: 'button', style: BUTTON_STYLE, disabled, onClick }, label)

    /**
     * The composer layout's phase, copied from `dsh-client-ui-conversation`'s own
     * helper, so this entry can ask the same question the layout asks itself.
     */
    function conversationPhase(session, conversation) {
      return conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
        ? 'active'
        : session.promptAttempted
          ? 'engaging'
          : 'blank'
    }

    function createFocusEntry(ctx) {
      return function FocusEntry(props) {
        const fromProps = props === null || props === undefined ? undefined : props.sessionId
        const sessionId = typeof fromProps === 'string' ? fromProps : displayedSessionId(ctx)
        const [row, setRow] = React.useState(() =>
          typeof sessionId === 'string' ? sessionRow(ctx, sessionId) : undefined,
        )
        const [binding, setBinding] = React.useState(() =>
          typeof sessionId === 'string' ? readBinding(sessionId) : undefined,
        )
        const [notice, setNotice] = React.useState(undefined)
        const [busy, setBusy] = React.useState(false)
        // The Host answers whether this Session is a focus Session too, so the entry does
        // not depend on this half reading the client projection correctly.
        const [hostFocus, setHostFocus] = React.useState(false)
        // `hero` above the card, `pick` below it in the blank layout, `composer` for a Session
        // that has a conversation. Anything unexpected falls back to the composer seat.
        const seat =
          props !== null && props !== undefined && typeof props.seat === 'string' ? props.seat : 'composer'
        // Which side of the composer this entry belongs on is the *layout's* decision:
        // the composer dock only exists in the composer layout, so an entry gated on a
        // neighbouring signal can appear on the side the layout is not rendering — the
        // jump this replaces. Ask the same stores the layout asks (both seats hand
        // `useSession`, `useSessions` and `useConversation` through standard props).
        const useSession = props === null || props === undefined ? undefined : props.useSession
        const useSessions = props === null || props === undefined ? undefined : props.useSessions
        const useConversation = props === null || props === undefined ? undefined : props.useConversation
        const layoutHooks =
          typeof useSession === 'function' && typeof useSessions === 'function' && typeof useConversation === 'function'
        const session = layoutHooks ? useSession((state) => state) : undefined
        const conversation = layoutHooks ? useConversation((state) => state) : undefined
        const summaryBlank = layoutHooks
          ? useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.blank))
          : undefined
        const layoutHero = layoutHooks
          ? sessionId === undefined ||
            (conversationPhase(session, conversation) === 'blank' &&
              (session?.openState === 'open' || summaryBlank === true))
          : undefined
        const blankRow = row !== undefined && row.blank
        /** The blank (hero) layout, derived the same way the layout itself derives it. */
        const inHero = layoutHero === undefined ? blankRow : layoutHero
        // Exactly one seat renders for every layout state: `hero` above the card, `pick` below
        // it in the same blank layout, and `composer` for a Session that has a conversation.
        const belongsHere = seat === 'composer' ? !inHero : inHero
        const input = React.useRef(null)
        // The latest row, for callbacks that outlive the render that created them.
        const rowRef = React.useRef(row)
        rowRef.current = row
        // What the Sidebar was last opened for, so each binding auto-opens exactly once
        // and a restored binding never fights the user's own tabs.
        const opened = React.useRef(typeof sessionId === 'string' ? readBinding(sessionId)?.path : undefined)
        const active = hostFocus || (row !== undefined && row.preset === PRESET_ID)

        const reveal = async (target) => {
          const cwd = target.cwd ?? (rowRef.current === undefined ? undefined : rowRef.current.cwd)
          const path = resolveAgainst(target.path, cwd)
          if (path === undefined || cwd === undefined) {
            setNotice('无法定位该文件：会话工作目录未知')
            return
          }
          try {
            await openResourceWhenMounted(ctx, fileAddressFor(sessionId, cwd, path))
            setNotice(undefined)
          } catch (error) {
            setNotice(messageOf(error))
          }
        }

        // Watch the two things that happen outside this component: the user chooses
        // the preset, and the Agent creates the file in conversation.
        React.useEffect(() => {
          if (typeof sessionId !== 'string') return undefined
          let cancelled = false
          let tries = 0
          let timer
          const tick = async () => {
            if (cancelled) return
            const next = sessionRow(ctx, sessionId)
            setRow(next)
            const state = await fetchState(sessionId)
            if (cancelled || state === undefined) return
            setHostFocus(state.focus || (next !== undefined && next.preset === PRESET_ID))
            if (state.target !== null) {
              persistBinding(sessionId, state.target)
              setBinding(state.target)
              // Bind-once: with a binding there is nothing left to watch.
              if (timer !== undefined) clearInterval(timer)
              // A file the Agent created in conversation: open it as soon as it exists.
              if (opened.current !== state.target.path) {
                opened.current = state.target.path
                await delay(AUTO_OPEN_DELAY_MS)
                if (!cancelled) await reveal(state.target)
              }
              return
            }
            const stored = readBinding(sessionId)
            if (stored !== undefined) {
              // The Host restarted and lost its map: state the binding again.
              const result = await postBinding(sessionId, stored)
              if (cancelled) return
              if (result.ok) {
                setBinding(result.target)
                if (timer !== undefined) clearInterval(timer)
                return
              }
              if (result.status === 409 && result.target !== undefined) {
                persistBinding(sessionId, result.target)
                setBinding(result.target)
                if (timer !== undefined) clearInterval(timer)
                return
              }
            }
            tries += 1
            if (tries > REFRESH_TRIES && timer !== undefined) clearInterval(timer)
          }
          timer = setInterval(tick, REFRESH_MS)
          tick()
          return () => {
            cancelled = true
            clearInterval(timer)
          }
        }, [sessionId])

        /**
         * Say in the Session what just happened, which is also what makes the Session a
         * real list member. A failure is reported, not swallowed: the file exists either
         * way, and the user needs to know its Session may not survive leaving it.
         */
        const announce = async (text) => {
          if (await startSession(ctx, sessionId, text)) return
          setNotice('文件已就绪，但这一轮没能开始：离开本会话后它可能不在列表里')
        }

        // Outside a focus Session this entry has nothing to say, and each seat owns one
        // half of the Session's life: the composer dock below the card once it has a
        // conversation, the input dock above it while the Session is still blank.
        if (typeof sessionId !== 'string' || !active) return null
        if (!belongsHere) return null

        const rowStyle = seat === 'composer' ? INLINE_ROW_STYLE : ROW_STYLE
        const noticeNode =
          notice === undefined ? null : React.createElement('span', { key: 'notice', style: NOTICE_STYLE }, notice)
        /**
         * Bind the Session to the file the user chose. A browser file input exposes no absolute
         * path, so the desktop preload is asked (`pathOf`); when it cannot answer, the pick is
         * impossible and the user is told rather than left with a silent no-op.
         */
        const pick = async (files) => {
          const file = files[0]
          if (file === undefined) return
          const path = pathOf(file)
          const cwd = rowRef.current === undefined ? undefined : rowRef.current.cwd
          if (path === undefined) {
            setNotice('无法取得该文件的路径：请在桌面端选择，或在输入框输入「新建文件」由我创建')
            return
          }
          setBusy(true)
          setNotice(undefined)
          try {
            const result = await postBinding(sessionId, { path, cwd })
            if (!result.ok) {
              setNotice(
                result.error === 'already-bound'
                  ? '本会话已绑定其他文件，不能再更换'
                  : `绑定失败：${result.error}`,
              )
              return
            }
            persistBinding(sessionId, result.target)
            setBinding(result.target)
            await reveal(result.target)
            await announce(`已选择文件 ${basenameOf(result.target.path)}，本会话现在只服务它。`)
          } finally {
            setBusy(false)
          }
        }

        /** The picker, wherever it is offered. */
        const picker = actionButton(
          'pick',
          '选择文件',
          busy
            ? undefined
            : () => {
                if (input.current !== null) input.current.click()
              },
          busy,
        )
        const fileInput = React.createElement('input', {
          key: 'input',
          ref: input,
          type: 'file',
          accept: SUPPORTED_EXTENSIONS.map((extension) => `.${extension}`).join(','),
          style: { display: 'none' },
          onChange: (event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            if (files.length > 0) pick(files)
          },
        })
        /** The bound state, wherever it is shown. */
        const chip = React.createElement(
          'span',
          { style: CHIP_STYLE, key: 'chip', title: `已绑定 ${binding?.path ?? ''}（不可切换）` },
          React.createElement(
            'button',
            { type: 'button', style: LINK_STYLE, onClick: () => reveal(binding) },
            `📄 ${basenameOf(binding?.path ?? '')}`,
          ),
        )

        // The blank layout is chat-first: creating the file is something the Agent can do, so
        // the row above the card says what to type instead of offering a button, and the only
        // control is the picker below it. The conversation layout keeps both controls.
        if (seat === 'hero') {
          return React.createElement(
            'div',
            { style: { ...rowStyle, justifyContent: 'center' } },
            binding !== undefined
              ? chip
              : React.createElement(
                  'span',
                  { key: 'hint', style: HERO_HINT_STYLE },
                  '在聊天输入框输入「新建文件」，我会创建并聚焦它',
                ),
            noticeNode,
          )
        }
        if (seat === 'row') {
          // The composer's own tool row, beside `+` and the permission control. This is the only
          // place inside the composer that the blank layout projects: the row *below* the card
          // belongs to the conversation layout, and the blank one shows no such row at all.
          if (binding !== undefined || !inHero) return null
          return React.createElement(
            'div',
            { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
            fileInput,
            picker,
            noticeNode,
          )
        }
        if (binding !== undefined) {
          return React.createElement('div', { style: rowStyle }, chip, noticeNode)
        }

        // A Session that has a conversation but no file yet: the only control is the picker.
        // Creating the file is the Agent's job — say 「新建文件」 and its first write becomes the
        // binding — so there is no create control in either layout, and nothing to open a menu.
        return React.createElement('div', { style: rowStyle }, fileInput, picker, noticeNode)
      }
    }



    return {
      inject: INJECT,
      apply(ctx) {
        // A plugin must not be able to keep the app from booting: an exception in `apply`
        // fails this entry's activation, and the desktop shell treats a failed web boot as
        // fatal. Everything below only registers capabilities, so a failure is reported and
        // the plugin stays inert instead of taking the application down with it.
        try {
        // Two seats, one entry, split by the Session's life. `conversation.composer.dock`
        // is the row **below** the composer card and only exists once a conversation
        // does; a blank Session renders `conversation.input.dock` instead, where the same
        // entry appears above the card so a fresh Session has its buttons too.
        let registrations = 0
        // Owned by this plugin's effects, like every other contribution here: a registration
        // held by anyone else outlives the instance that made it, and the next `apply` — an
        // HMR reload on a running desktop page — would then contribute a second copy.
        const register = (name, seat) =>
          ctx.effect(
            () =>
              ctx.slots.inject(name, () => {
                registrations += 1
                return ctx.slots.register(
                  {
                    name,
                    // One id per seat: two entries sharing an id would replace each other.
                    id: `dsh-file-session.${seat}`,
                    order: 30,
                    inject: (sessionId) => ({ sessionId, seat }),
                  },
                  createFocusEntry(ctx),
                )
              }),
            `dsh-file-session: ${seat} seat`,
          )
        register('conversation.composer.dock', 'composer')
        register('conversation.input.left', 'row')
        register('conversation.input.dock', 'hero')

        // The preview of whatever kind of file this Session bound is not this plugin's job: a
        // preview is a right-Sidebar tab type, and this bundle only opens the address. Install
        // a preview plugin (dsh-mermaid, say) and its renderer claims the file; without one the
        // built-in Document Preview renders it, which is the same fallback every other file
        // gets. That is why nothing here mentions a format.
        reportHealth({ injected: INJECT, seats: registrations })
        } catch (error) {
          console.warn('[dsh-file-session] the browser half could not be registered', error)
          reportHealth({
            injected: INJECT,
            seats: 0,
            error: error instanceof Error ? error.message || error.name : String(error),
          })
        }
      },
    }
  },
})
