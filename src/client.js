/**
 * Client face of `lx_dsh_peek`: on the official **desktop** UI, ⌘⇧] and ⌘⇧[
 * move the main view to the next or previous Session.
 *
 * The Host face (`./index.js`) serves the read-only LAN peek page and the
 * official-UI style overrides; nothing here depends on it. `package.json`
 * declares this file through `dsh.client` and `exports["./client"]`, so the
 * client-module table serves it at runtime and **no build step is needed**: the
 * bundle is the plain registration call below, and the page materializes the
 * factory through its CommonJS-style `require`.
 *
 * The keys are Desktop-only on purpose. A plain browser page consumes ⌘⇧[ and
 * ⌘⇧] itself (next/previous tab), so this face registers nothing when it is not
 * running inside the Electron shell.
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
     * Sessions the sidebar's default "Last updated" list shows, in Host list
     * order: archived rows, subagent children, and every blank row except the
     * selected one are left out, matching the Workspace browser's own membership.
     * @param ctx - client context.
     * @returns navigable Session ids, in list order.
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
     * Resolve the Session `step` rows away from the main view, wrapping at both ends.
     * @param ctx - client context.
     * @param step - +1 for the next Session, -1 for the previous one.
     * @returns the target Session id, or undefined when there is nothing to move to.
     */
    function targetSessionId(ctx, step) {
      const ids = orderedIds(ctx)
      if (ids.length < 2) return undefined
      const current = mainSessionId(ctx)
      const index = current === undefined ? -1 : ids.indexOf(current)
      if (index === -1) return ids[step > 0 ? 0 : ids.length - 1]
      const target = ids[(index + step + ids.length) % ids.length]
      return target === current ? undefined : target
    }

    /**
     * Register one navigation command for the three Desktop profiles.
     * @param ctx - client context.
     * @param t - locale-bound translate function.
     * @param id - command id.
     * @param key - dictionary key and default label source.
     * @param code - physical key the command binds in every Desktop profile.
     * @param step - direction along the list order.
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
          return { status: 'handled', run: () => { ctx.uiWorkspace.openSession(target); } }
        },
      })
    }

    /**
     * Activate the face: locale dictionaries, then the two navigation commands.
     * @param ctx - client context with the services named by `inject`.
     */
    exports.apply = (ctx) => {
      // The Electron shell is the only target: the client table also loads this
      // bundle in a plain browser page, where these keys never reach the page.
      if (!('dshDesktop' in globalThis)) return
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'lx_dsh_peek: shortcut labels')
      ctx.effect(() => register(ctx, t, 'lxPeek.sessionNext', 'next', 'BracketRight', 1), 'lx_dsh_peek: next session')
      ctx.effect(() => register(ctx, t, 'lxPeek.sessionPrevious', 'previous', 'BracketLeft', -1), 'lx_dsh_peek: previous session')
    }

    return module.exports
  },
})
