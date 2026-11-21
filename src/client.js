/**
 * Client face of `lx_dsh_peek` — the part that lives inside the official DSH
 * page and makes the desktop shell nicer to use:
 *
 * - **Session switching** (`⌘⇧]` / `⌘⇧[`): walks the sessions the sidebar
 *   currently shows, in the order it shows them, because that order is the
 *   reader's order (recency, manual drag order, pinned rows first, collapsed
 *   workspace groups hidden). The Host list order is only the fallback for a
 *   hidden sidebar.
 * - **Reasoning auto-expand**: the official Think rows start collapsed with
 *   their body unmounted, so this opens them as they appear. The mode comes
 *   from the Host as a `global` injection row.
 *
 * The Host face (`./index.js`) serves the peek page and injects the style and
 * the settings row. `package.json` declares this file through `dsh.client` and
 * `exports["./client"]`, so the client-module table serves it at runtime and no
 * build step is needed: the bundle is the plain registration call below.
 */

window.__ModuleLoader__.load({
  id: 'lx_dsh_peek',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    /** Client services this face reads before it may activate. */
    exports.inject = ['shortcuts', 'sessions', 'workspaces', 'uiWorkspace', 'locale']

    /** Locale namespace owned by this face. */
    const NS = 'lx-dsh-peek'

    const DICTIONARIES = {
      en: { next: 'Next session', previous: 'Previous session' },
      zh: { next: '下一个会话', previous: '上一个会话' },
    }

    const ALIASES = {
      next: ['next session', 'next conversation', 'switch to next session', '下一个会话', '切换下一个会话'],
      previous: ['previous session', 'previous conversation', 'switch to previous session', '上一个会话', '切换上一个会话'],
    }

    /** Sidebar row attribute carrying the Session id; one row per visible Session. */
    const SESSION_ROW = '[data-row-key^="session:"]'
    const SESSION_KEY = 'session:'
    /** The sidebar's scroll area; scoping keeps other lists with the same rows out. */
    const SIDEBAR_LIST = '[data-sidebar-list-area]'

    /** Official reasoning row and its clickable disclosure header. */
    const THINK_ROOT = '[data-variant="think"]'
    const THINK_HEADER = '[data-disclosure-row]'
    /** Safety valve: a pathological transcript never gets every row expanded. */
    const MAX_OPENS = 600
    const OPEN_BATCH = 20

    /**
     * Session ids the sidebar shows right now, top to bottom.
     * @returns visible Session ids in reader order; empty when the sidebar is absent.
     */
    function sidebarSessionIds() {
      const doc = globalThis.document
      if (doc === undefined || doc === null) return []
      const list = doc.querySelector(SIDEBAR_LIST) ?? doc
      const rows = list.querySelectorAll(SESSION_ROW)
      const ids = []
      const seen = new Set()
      for (const row of rows) {
        const key = row.getAttribute('data-row-key')
        if (typeof key !== 'string' || !key.startsWith(SESSION_KEY)) continue
        const id = key.slice(SESSION_KEY.length)
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
      return ids
    }

    /**
     * Session shown by the main view, or undefined when it shows none.
     * @param ctx - client context.
     * @returns the retained Session id selected by the main view.
     */
    function mainSessionId(ctx) {
      const list = ctx.sessions.list.getSnapshot()
      for (const id of list.ids) {
        const session = list.byId[id]
        if (session !== undefined && (session.retainedBy.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    /**
     * Host list order filtered the way the Workspace browser filters its flat
     * list: archived rows, subagent children, and every blank row except the
     * selected one are left out. This is the fallback when the sidebar is hidden.
     * @param ctx - client context.
     * @returns navigable Session ids, in Host order.
     */
    function orderedIds(ctx) {
      const list = ctx.sessions.list.getSnapshot()
      const archived = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds)
      const current = mainSessionId(ctx)
      return list.ids.filter((id) => {
        const session = list.byId[id]
        if (session === undefined) return false
        if (archived.has(id)) return false
        if (session.origin === 'subagent') return false
        return !(session.blank === true && id !== current)
      })
    }

    /**
     * Walk one list by one step, wrapping at both ends.
     * @param ids - ordered Session ids.
     * @param current - the Session the main view shows.
     * @param step - +1 or -1.
     * @returns the target id, or undefined when there is nowhere to move.
     */
    function stepList(ids, current, step) {
      if (ids.length < 2) return undefined
      const at = current === undefined ? -1 : ids.indexOf(current)
      if (at === -1) return ids[step > 0 ? 0 : ids.length - 1]
      const target = ids[(at + step + ids.length) % ids.length]
      return target === current ? undefined : target
    }

    /**
     * Resolve the Session to show after one shortcut step. The sidebar's own
     * order wins; when the current Session is hidden (collapsed workspace group)
     * the walk continues in Host order until it meets a visible row.
     * @param ctx - client context.
     * @param step - +1 for the next Session, -1 for the previous one.
     * @returns the target Session id, or undefined when there is nothing to move to.
     */
    function targetSessionId(ctx, step) {
      const current = mainSessionId(ctx)
      const visible = sidebarSessionIds()
      if (visible.length > 1 && (current === undefined || visible.includes(current))) {
        return stepList(visible, current, step)
      }
      const hostIds = orderedIds(ctx)
      if (visible.length > 0) {
        const at = current === undefined ? -1 : hostIds.indexOf(current)
        if (at === -1) return visible[step > 0 ? 0 : visible.length - 1]
        const count = hostIds.length
        for (let offset = 1; offset <= count; offset += 1) {
          const index = ((at + step * offset) % count + count) % count
          const candidate = hostIds[index]
          if (candidate !== undefined && candidate !== current && visible.includes(candidate)) return candidate
        }
      }
      return stepList(hostIds, current, step)
    }

    /**
     * Open collapsed Think rows as they appear, in the official page.
     * The reader's manual collapse is remembered so the scan never fights them.
     * @param mode - 'stream' opens the running row only, 'all' opens history too.
     * @returns a disposer that removes the observer and the click listener.
     */
    function installReasoningAutoExpand(mode) {
      if (mode !== 'stream' && mode !== 'all') return () => {}
      const doc = globalThis.document
      if (doc === undefined || doc === null) return () => {}

      /** Headers the reader collapsed; never reopened while they stay mounted. */
      const closedRows = new WeakSet()
      /** Text signatures of collapsed rows, so a remount does not reopen them. */
      const closedSignatures = new Set()
      const pending = new Set()
      let scheduled = false
      let opened = 0
      let capped = false

      const signatureOf = (root) => (root.textContent ?? '').trim().slice(0, 120)
      const headerOf = (root) => root.querySelector(THINK_HEADER)

      const shouldOpen = (root) => {
        if (root.getAttribute('data-expanded') !== null) return false
        if (mode === 'stream' && root.getAttribute('data-state') !== 'running') return false
        const header = headerOf(root)
        if (header === null || header === undefined) return false
        if (header.getAttribute('aria-expanded') !== 'false') return false
        if (closedRows.has(header)) return false
        const signature = signatureOf(root)
        return !(signature !== '' && closedSignatures.has(signature))
      }

      const openRoot = (root) => {
        if (!shouldOpen(root)) return
        if (opened >= MAX_OPENS) {
          if (!capped) {
            capped = true
            console.warn('[lx_dsh_peek] reasoning auto-expand stopped at ' + MAX_OPENS + ' rows')
          }
          return
        }
        headerOf(root).click()
        opened += 1
      }

      const flush = () => {
        scheduled = false
        let budget = OPEN_BATCH
        for (const root of pending) {
          pending.delete(root)
          openRoot(root)
          budget -= 1
          if (budget <= 0) break
        }
        if (pending.size > 0) schedule()
      }

      const schedule = () => {
        if (scheduled) return
        scheduled = true
        const next = globalThis.requestAnimationFrame ?? ((run) => setTimeout(run, 16))
        next(flush)
      }

      const queue = (root) => {
        pending.add(root)
        schedule()
      }

      const scan = (node) => {
        if (node === undefined || node === null || node.nodeType !== 1) return
        if (typeof node.matches === 'function' && node.matches(THINK_ROOT)) queue(node)
        if (typeof node.querySelectorAll === 'function') {
          for (const root of node.querySelectorAll(THINK_ROOT)) queue(root)
        }
      }

      // Capture-phase listener: a manual collapse marks the row before React
      // toggles it, and a manual open clears that mark again.
      const onClick = (event) => {
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        const header = target.closest(THINK_HEADER)
        if (header === null) return
        const root = header.closest(THINK_ROOT)
        if (root === null) return
        if (header.getAttribute('aria-expanded') === 'true') {
          closedRows.add(header)
          const signature = signatureOf(root)
          if (signature !== '') {
            closedSignatures.add(signature)
            if (closedSignatures.size > 400) closedSignatures.clear()
          }
        } else {
          closedRows.delete(header)
        }
      }
      doc.addEventListener('click', onClick, true)

      let observer
      const Observer = globalThis.MutationObserver
      if (typeof Observer === 'function') {
        observer = new Observer((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) scan(node)
          }
        })
        observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true })
      }
      scan(doc.documentElement)

      return () => {
        doc.removeEventListener('click', onClick, true)
        if (observer !== undefined) observer.disconnect()
      }
    }

    /**
     * Register one navigation command for the three Desktop profiles.
     * @param ctx - client context.
     * @param t - locale-bound translate function.
     * @param id - command id.
     * @param key - dictionary key and default label source.
     * @param code - physical key the command binds in every Desktop profile.
     * @param step - direction along the reader order.
     * @returns the registration disposer.
     */
    function register(ctx, t, id, key, code, step) {
      return ctx.shortcuts.register({
        id,
        label: () => t(key),
        aliases: ALIASES[key],
        defaults: {
          'desktop:macos': { code, modifiers: ['primary', 'shift'] },
          'desktop:windows': { code, modifiers: ['primary', 'shift'] },
          'desktop:linux': { code, modifiers: ['primary', 'shift'] },
        },
        regions: ['page', 'editable'],
        modals: ['sidebar'],
        resolve: (context) => {
          // Desktop bindings outrank modal controls, so keep a dialog in front
          // instead of navigating out from under it.
          if (context.modal !== null && context.modal !== 'sidebar') {
            return { status: 'blocked', reason: 'close-dialog' }
          }
          const target = targetSessionId(ctx, step)
          if (target === undefined) return { status: 'blocked', reason: 'no-session' }
          return { status: 'handled', run: () => { ctx.uiWorkspace.openSession(target) } }
        },
      })
    }

    /**
     * Activate the face: reasoning expansion on every official page, and the
     * Desktop-only navigation commands.
     * @param ctx - client context with the services named by `inject`.
     */
    exports.apply = (ctx) => {
      const settings = globalThis.__lxDshPeekUi ?? {}
      const expandReasoning = settings.expandReasoning ?? 'off'
      ctx.effect(() => installReasoningAutoExpand(expandReasoning), 'lx_dsh_peek: reasoning expansion')

      // The Electron shell is the only target for the keys: the client table
      // also loads this bundle in a plain browser page, where ⌘⇧[ / ⌘⇧] belong
      // to the browser and never reach the page.
      if (!('dshDesktop' in globalThis)) return
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'lx_dsh_peek: shortcut labels')
      ctx.effect(() => register(ctx, t, 'lxPeek.sessionNext', 'next', 'BracketRight', 1), 'lx_dsh_peek: next session')
      ctx.effect(() => register(ctx, t, 'lxPeek.sessionPrevious', 'previous', 'BracketLeft', -1), 'lx_dsh_peek: previous session')
    }

    return module.exports
  },
})
