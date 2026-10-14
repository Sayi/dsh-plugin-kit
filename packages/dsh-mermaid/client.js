/**
 * Browser half of the `dsh-mermaid` bundle.
 *
 * A preview plugin, and now a thin one: the chrome it shares with every other preview — header,
 * view dropdown, pan and zoom, code view, 「打开方式」, diagnostics — lives in `dsh-preview-kit`.
 * What is left here is what makes it Mermaid: the extensions it claims, the Host route it reads
 * through, the chunk it renders and highlights with, and how a source becomes an SVG.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mermaid',
  factory(require) {
    const React = require('react')
    /**
     * The shared chrome. A failed require here would fail this entry's activation, and the
     * desktop shell treats a failed web boot as fatal — so it is caught, and a missing kit
     * leaves the preview inert instead of taking the application down.
     */
    let kit
    try {
      kit = require('dsh-preview-kit')
    } catch (error) {
      console.warn('[dsh-mermaid] the preview kit could not be loaded', error)
    }

    /** The services this half uses; a preview declares as few as it can. */
    const INJECT = ['slots', 'sidebarRightTabs', 'remote', 'remote.session']
    /** This tab type's identity, used for both the type and its body registration. */
    const TYPE_ID = 'dsh-mermaid/diagram'
    /** The kind the type owns; nothing else registers it. */
    const KIND = 'dsh-mermaid-diagram'
    /** The chunk that carries Mermaid and the grammar, loaded when the first diagram opens. */
    const CHUNK = './client.mermaid.js'
    const DEFAULT_SOURCE_ROUTE = '/dsh-mermaid/source'
    const DEFAULT_DIAG_ROUTE = '/dsh-mermaid/diag'
    /** Diagram extensions this bundle previews. */
    const MERMAID_EXTENSIONS = ['mmd', 'mermaid']

    /** The shared chrome, and how to install it when it is missing. */
    const KIT_INSTALL_HINT = 'github:Sayi/dsh-plugin-kit#path:packages/dsh-preview-kit'

    /** The Session and path of a `dsh-resource://file/session/<id>/<path>` address. */
    function parseSessionAddress(address) {
      const head = 'dsh-resource://file/session/'
      if (typeof address !== 'string' || !address.startsWith(head)) return undefined
      const tail = address.slice(head.length).split(/[?#]/)[0]
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

    /** The Host's per-process route and secret, injected into the page at boot. */
    function hostBridge() {
      const injected = window.__DSH_MERMAID__
      if (injected === null || injected === undefined || typeof injected.nonce !== 'string') return undefined
      return {
        nonce: injected.nonce,
        header: 'x-dsh-mermaid',
        route: typeof injected.route === 'string' ? injected.route : DEFAULT_SOURCE_ROUTE,
        diagRoute: typeof injected.diagRoute === 'string' ? injected.diagRoute : DEFAULT_DIAG_ROUTE,
      }
    }

    /** Read one file's text through this bundle's own Host route. */
    async function readDiagramFile(file, signal) {
      const bridge = hostBridge()
      if (bridge === undefined) throw new Error('这个预览需要在 DSH 桌面端中使用')
      const query = new URLSearchParams({ sessionId: file.sessionId, path: file.path })
      const response = await fetch(`${bridge.route}?${query.toString()}`, {
        headers: { 'x-dsh-mermaid': bridge.nonce },
        signal,
      })
      const body = await response.json()
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      return {
        text: typeof body.text === 'string' ? body.text : '',
        path: typeof body.path === 'string' && body.path !== '' ? body.path : undefined,
      }
    }

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

    /** The Mermaid chunk, fetched once per page however many diagram tabs open. */
    let diagramChunk
    function loadDiagramChunk(require) {
      if (diagramChunk === undefined) diagramChunk = require.async(CHUNK)
      return diagramChunk
    }


    /** What this preview renders, handed to the kit's body factory. */
    const adapter = {
      read: (file, signal) => readDiagramFile(file, signal),
      load: () => loadDiagramChunk(require),
      /** Mermaid first refuses a source it cannot parse, then draws the one it can. */
      prepare: async (source, { scheme, chunk }) => {
        const invalid = await chunk.parseDiagram(source)
        if (invalid !== undefined) return { invalid }
        return { svg: await chunk.renderDiagram(source, scheme) }
      },
      highlight: (source, chunk) =>
        typeof chunk.highlightDiagram === 'function' ? chunk.highlightDiagram(source) : undefined,
      bridge: hostBridge,
      diagRoute: DEFAULT_DIAG_ROUTE,
    }

    return {
      inject: INJECT,
      apply(ctx) {
        if (kit === undefined) {
          // No kit, no preview — but silence is the wrong answer: register the type and a body
          // that names the missing package and how to install it.
          try {
            ctx.effect(
              () =>
                ctx.sidebarRightTabs.register({
                  id: TYPE_ID,
                  kind: KIND,
                  patterns: MERMAID_EXTENSIONS.map((extension) => `*.${extension}`),
                  canOpen: (address) => parseSessionAddress(address) !== undefined,
                  title: (address) => {
                    const file = parseSessionAddress(address)
                    return file === undefined ? '图表' : file.path.split('/').pop() ?? '图表'
                  },
                }),
              'dsh-mermaid: diagram type (kit missing)',
            )
            ctx.effect(
              () =>
                ctx.slots.inject('sidebar.right.pane.tab', () =>
                  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, () =>
                    React.createElement(
                      'div',
                      { style: { padding: '16px', fontSize: '13px', lineHeight: '20px' } },
                      '这个预览需要 dsh-preview-kit，但当前没有安装。先安装它，再重新打开这个标签：',
                      React.createElement(
                        'pre',
                        { style: { marginTop: '8px', whiteSpace: 'pre-wrap' } },
                        KIT_INSTALL_HINT,
                      ),
                    ),
                  ),
                ),
              'dsh-mermaid: diagram body (kit missing)',
            )
          } catch (error) {
            console.warn('[dsh-mermaid] the fallback could not be registered', error)
          }
          return
        }
        // A plugin must not be able to keep the app from booting: an exception in `apply` fails
        // this entry's activation, and the desktop shell treats a failed web boot as fatal.
        try {
          // Both registrations are owned by this plugin's own effects: a registration held by
          // anyone else outlives the instance that made it, and the next materialization — an
          // HMR reload on a running page — would then contribute a second copy and throw.
          ctx.effect(
            () =>
              ctx.sidebarRightTabs.register({
                id: TYPE_ID,
                kind: KIND,
                patterns: MERMAID_EXTENSIONS.map((extension) => `*.${extension}`),
                canOpen: (address) => kit.parseFileAddress(address) !== undefined,
                title: (address) => {
                  const file = kit.parseFileAddress(address)
                  return file === undefined ? '图表' : kit.basenameOf(file.path)
                },
              }),
            'dsh-mermaid: diagram type',
          )
          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.right.pane.tab', () =>
                ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, kit.createPreviewBody(ctx, adapter)),
              ),
            'dsh-mermaid: diagram body',
          )
        } catch (error) {
          console.warn('[dsh-mermaid] the preview could not be registered', error)
        }
      },
    }
  },
})
