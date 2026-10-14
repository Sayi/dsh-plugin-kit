/**
 * Browser half of the `dsh-d2` bundle.
 *
 * A thin consumer of `dsh-preview-kit`, exactly like `dsh-mermaid`: the chrome — header, view
 * dropdown, pan and zoom, code view, 「打开方式」, diagnostics — comes from the kit, and what is
 * here is what makes this preview D2. That is not much, because D2 compiles on the **Host**,
 * through the `d2` CLI: the browser never parses the language, it asks this bundle's render route
 * for an SVG and shows it.
 *
 * What it does own is the D2 grammar in its lazy chunk, so the code view is readable.
 */
window.__ModuleLoader__.load({
  id: 'dsh-d2',
  factory(require) {
    const React = require('react')

    /**
     * The shared chrome. A failed require here would fail this entry's activation, and the desktop
     * shell treats a failed web boot as fatal — so it is caught, and a missing kit leaves the
     * preview inert instead of taking the application down.
     */
    let kit
    try {
      kit = require('dsh-preview-kit')
    } catch (error) {
      console.warn('[dsh-d2] the preview kit could not be loaded', error)
    }

    /** Only the services the kit asks for; the kit explains why that list is short. */
    const INJECT = ['slots', 'sidebarRightTabs', 'remote', 'remote.session']
    /** This tab type's identity, used for both the type and its body registration. */
    const TYPE_ID = 'dsh-d2/diagram'
    /** The kind the type owns; nothing else registers it. */
    const KIND = 'dsh-d2-diagram'
    /** The chunk that carries the D2 grammar, loaded when the first diagram opens. */
    const CHUNK = './client.d2.js'
    const DEFAULT_SOURCE_ROUTE = '/dsh-d2/source'
    const DEFAULT_RENDER_ROUTE = '/dsh-d2/render'
    const DEFAULT_DIAG_ROUTE = '/dsh-d2/diag'
    /** Diagram extensions this bundle previews. */
    const D2_EXTENSIONS = ['d2']

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

    /** The Host's per-process routes and secret, injected into the page at boot. */
    function hostBridge() {
      const injected = window.__DSH_D2__
      if (injected === null || injected === undefined || typeof injected.nonce !== 'string') return undefined
      return {
        nonce: injected.nonce,
        header: 'x-dsh-d2',
        route: typeof injected.route === 'string' ? injected.route : DEFAULT_SOURCE_ROUTE,
        renderRoute: typeof injected.renderRoute === 'string' ? injected.renderRoute : DEFAULT_RENDER_ROUTE,
        diagRoute: typeof injected.diagRoute === 'string' ? injected.diagRoute : DEFAULT_DIAG_ROUTE,
      }
    }

    /** Read one file's text through this bundle's own Host route. */
    async function readDiagramFile(file, signal) {
      const bridge = hostBridge()
      if (bridge === undefined) throw new Error('这个预览需要在 DSH 桌面端中使用')
      const query = new URLSearchParams({ sessionId: file.sessionId, path: file.path })
      const response = await fetch(`${bridge.route}?${query.toString()}`, {
        headers: { 'x-dsh-d2': bridge.nonce },
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

    /** Compile one source on the Host, where the `d2` CLI lives. */
    async function compile(source, signal) {
      const bridge = hostBridge()
      if (bridge === undefined) throw new Error('这个预览需要在 DSH 桌面端中使用')
      const response = await fetch(bridge.renderRoute, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-d2': bridge.nonce },
        body: JSON.stringify({ source }),
        signal,
      })
      const body = await response.json().catch(() => undefined)
      if (body === undefined) throw new Error(`HTTP ${response.status}`)
      if (body.ok === true && typeof body.svg === 'string') return body
      // The Host says which failure it was; a missing binary is the one a user can act on, and the
      // kit shows whatever message comes back.
      return {
        ok: false,
        message:
          typeof body.message === 'string' && body.message !== ''
            ? body.message
            : typeof body.error === 'string'
              ? body.error
              : `HTTP ${response.status}`,
      }
    }

    /** The chunk, fetched once per page however many diagram tabs open. */
    let diagramChunk
    function loadDiagramChunk(require) {
      if (diagramChunk === undefined) diagramChunk = require.async(CHUNK)
      return diagramChunk
    }

    /** What this preview renders, handed to the kit's body factory. */
    const adapter = {
      read: (file, signal) => readDiagramFile(file, signal),
      load: () => loadDiagramChunk(require),
      /**
       * D2 has no separate parse step to ask about: the compiler *is* the parser, so a failure
       * arrives as the CLI's own message — line and column included — and the kit shows it beside
       * the source.
       */
      prepare: async (source, { signal }) => {
        const compiled = await compile(source, signal)
        return compiled.ok === true ? { svg: compiled.svg } : { invalid: compiled.message }
      },
      highlight: (source, chunk) =>
        typeof chunk?.highlightDiagram === 'function' ? chunk.highlightDiagram(source) : undefined,
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
                  patterns: D2_EXTENSIONS.map((extension) => `*.${extension}`),
                  canOpen: (address) => parseSessionAddress(address) !== undefined,
                  title: (address) => {
                    const file = parseSessionAddress(address)
                    return file === undefined ? '图表' : file.path.split('/').pop() ?? '图表'
                  },
                }),
              'dsh-d2: diagram type (kit missing)',
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
              'dsh-d2: diagram body (kit missing)',
            )
          } catch (error) {
            console.warn('[dsh-d2] the fallback could not be registered', error)
          }
          return
        }
        // A plugin must not be able to keep the app from booting: an exception in `apply` fails
        // this entry's activation, and the desktop shell treats a failed web boot as fatal.
        try {
          // Both registrations are owned by this plugin's own effects: a registration held by
          // anyone else outlives the instance that made it, and the next materialization — an HMR
          // reload on a running page — would then contribute a second copy and throw.
          ctx.effect(
            () =>
              ctx.sidebarRightTabs.register({
                id: TYPE_ID,
                kind: KIND,
                patterns: D2_EXTENSIONS.map((extension) => `*.${extension}`),
                canOpen: (address) => kit.parseFileAddress(address) !== undefined,
                title: (address) => {
                  const file = kit.parseFileAddress(address)
                  return file === undefined ? '图表' : kit.basenameOf(file.path)
                },
              }),
            'dsh-d2: diagram type',
          )
          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.right.pane.tab', () =>
                ctx.slots.register(
                  { name: 'sidebar.right.pane.tab', key: TYPE_ID },
                  kit.createPreviewBody(ctx, adapter),
                ),
              ),
            'dsh-d2: diagram body',
          )
        } catch (error) {
          console.warn('[dsh-d2] the preview could not be registered', error)
        }
      },
    }
  },
})
