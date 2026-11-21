import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

// The client face is the bundle the page's module table materializes: it calls
// window.__ModuleLoader__.load({ id, factory }) and hands back a Cordis plugin
// ({ inject, apply }). These tests run that bundle in a VM whose global object
// stands in for the page, then drive the registered commands against fake
// Session, Workspace and DOM services.

/** Values created inside the VM realm carry that realm's prototypes; compare them by value. */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** One SessionSummary-shaped row; the main-view Session carries the reference. */
function session(id, over = {}) {
  return {
    id,
    title: id,
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: 0,
    retainedBy: {},
    ...over,
  }
}

/**
 * Minimal page document whose sidebar renders one Session row per id.
 * @param ids - Session ids in sidebar order.
 */
function sidebarDocument(ids) {
  const rows = ids.map((id) => ({
    getAttribute: (name) => (name === 'data-row-key' ? 'session:' + id : null),
  }))
  const list = { querySelectorAll: () => rows }
  return {
    querySelector: (selector) => (selector === '[data-sidebar-list-area]' ? list : null),
    querySelectorAll: () => [],
  }
}

/**
 * One fake Think disclosure row: a root carrying the data attributes and a
 * header that counts clicks.
 * @param options - running state, text, and whether it starts expanded.
 */
function thinkRow({ running = false, text = 'reasoning', expanded = false } = {}) {
  const attributes = {}
  if (expanded) attributes['data-expanded'] = ''
  let clicks = 0
  const header = {
    getAttribute: (name) => (name === 'aria-expanded' ? String(attributes['data-expanded'] !== undefined) : null),
    click() {
      clicks += 1
      attributes['data-expanded'] = ''
    },
    closest: (selector) => (selector === '[data-variant="think"]' ? root : null),
    querySelector: () => null,
  }
  const root = {
    nodeType: 1,
    textContent: text,
    attributes,
    getAttribute(name) {
      if (name in attributes) return attributes[name]
      return name === 'data-state' ? (running ? 'running' : 'ok') : null
    },
    querySelector: (selector) => (selector === '[data-disclosure-row]' ? header : null),
    querySelectorAll: () => [],
    matches: (selector) => selector === '[data-variant="think"]',
  }
  return { root, header, attributes, clicks: () => clicks }
}

/**
 * Page document carrying reasoning rows plus the hooks the face installs.
 * @param rows - thinkRow() results.
 */
function expansionDocument(rows) {
  const roots = rows.map((row) => row.root)
  const listeners = []
  const document = {
    documentElement: { nodeType: 1, querySelectorAll: () => roots, matches: () => false },
    body: {},
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === '[data-variant="think"]' ? roots : []),
    addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture }),
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex((entry) => entry.handler === handler)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  return { document, listeners }
}

/** Load the bundle and keep the sandbox so tests can reach injected globals. */
function loadFace({ desktop = true, ui, document } = {}) {
  const sandbox = { console }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = {
    load(row) {
      sandbox.row = row
    },
  }
  if (desktop) sandbox.dshDesktop = { protocolVersion: 1 }
  if (ui !== undefined) sandbox.__lxDshPeekUi = ui
  if (document !== undefined) {
    sandbox.document = document
    sandbox.requestAnimationFrame = (run) => run()
    sandbox.MutationObserver = class {
      constructor(callback) {
        this.callback = callback
        sandbox.observer = this
      }

      observe() {}

      disconnect() {}
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'src/client.js' })
  assert.ok(sandbox.row, 'the bundle registers itself with the module table')
  return sandbox
}

/** Fake client context: only the five injected services, with mutable snapshots. */
function createContext(initial = []) {
  const state = { sessions: initial, archived: [] }
  const commands = new Map()
  const opened = []
  const ctx = {
    effect(execute) {
      const dispose = execute()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register() {
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    shortcuts: {
      register(command) {
        commands.set(command.id, command)
        return () => commands.delete(command.id)
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({
          ids: state.sessions.map((row) => row.id),
          byId: Object.fromEntries(state.sessions.map((row) => [row.id, row])),
          phase: 'ready',
        }),
      },
    },
    workspaces: {
      list: {
        getSnapshot: () => ({ items: [], archivedSessionIds: state.archived, pinnedSessionIds: [], state: 'idle' }),
      },
    },
    uiWorkspace: {
      openSession(id) {
        opened.push(id)
      },
    },
  }
  return { ctx, commands, opened, state }
}

/** Activate the face against a context and return its command map, sandbox, and DOM. */
function activate(options, sessions) {
  const sandbox = loadFace(options)
  const fake = createContext(sessions)
  sandbox.row.factory(() => {
    throw new Error('the client face requires no other module')
  }).apply(fake.ctx)
  return { ...fake, sandbox }
}

/** Resolve one registered command as a keyboard press with no dialog in front. */
function press(fake, id) {
  const command = fake.commands.get(id)
  assert.ok(command, `command ${id} is registered`)
  return command.resolve({ source: 'keyboard', region: 'page', modal: null, target: null })
}

test('manifest declares the client face the module table can serve', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  // The bundle requires no other module, so it declares no module-graph edges;
  // the services it reads are named by its Cordis inject export instead.
  assert.equal(pkg.dsh.client.inject, undefined)
  const entry = pkg.exports['./client']
  const file = typeof entry === 'string' ? entry : entry.default
  assert.ok(existsSync(join(root, file)), `${file} exists`)
  const sandbox = loadFace()
  assert.equal(sandbox.row.id, pkg.name, 'the bundle id is the package name the Loader row resolves')
  assert.equal(typeof sandbox.row.factory, 'function')
})

test('registers next and previous Session on the Desktop profiles only', () => {
  const { commands } = activate({ desktop: true }, [session('a', { retainedBy: { mainView: 1 } })])
  assert.deepEqual([...commands.keys()].sort(), ['lxPeek.sessionNext', 'lxPeek.sessionPrevious'])

  for (const [id, code] of [['lxPeek.sessionNext', 'BracketRight'], ['lxPeek.sessionPrevious', 'BracketLeft']]) {
    const command = commands.get(id)
    assert.match(id, /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/, 'the id matches the service id pattern')
    assert.deepEqual(Object.keys(command.defaults).sort(), ['desktop:linux', 'desktop:macos', 'desktop:windows'])
    for (const profile of Object.keys(command.defaults)) {
      assert.deepEqual(plain(command.defaults[profile]), { code, modifiers: ['primary', 'shift'] })
    }
    assert.deepEqual(plain(command.regions), ['page', 'editable'])
    assert.deepEqual(plain(command.modals), ['sidebar'])
    assert.equal(typeof command.label(), 'string')
  }
})

test('registers nothing in a plain browser page', () => {
  const { commands } = activate({ desktop: false }, [session('a', { retainedBy: { mainView: 1 } })])
  assert.equal(commands.size, 0)
})

test('walks the Host list order when the sidebar is absent', () => {
  const fake = activate({ desktop: true }, [
    session('a'),
    session('b', { retainedBy: { mainView: 1 } }),
    session('c'),
  ])

  press(fake, 'lxPeek.sessionNext').run()
  assert.deepEqual(fake.opened, ['c'], 'next moves one row down')
  press(fake, 'lxPeek.sessionPrevious').run()
  assert.deepEqual(fake.opened, ['c', 'a'], 'previous moves one row up from the still-current b')

  fake.state.sessions = [session('a'), session('b'), session('c', { retainedBy: { mainView: 1 } })]
  press(fake, 'lxPeek.sessionNext').run()
  assert.deepEqual(fake.opened, ['c', 'a', 'a'], 'next wraps from the last Session to the first')

  fake.state.sessions = [session('a', { retainedBy: { mainView: 1 } }), session('b'), session('c')]
  press(fake, 'lxPeek.sessionPrevious').run()
  assert.deepEqual(fake.opened, ['c', 'a', 'a', 'c'], 'previous wraps from the first Session to the last')
})

test('follows the sidebar order, which is the reader order', () => {
  // Host order is recency; the sidebar shows manual/pinned order instead.
  const fake = activate(
    { desktop: true, document: sidebarDocument(['d', 'b', 'a', 'c']) },
    [session('a'), session('b', { retainedBy: { mainView: 1 } }), session('c'), session('d')],
  )

  press(fake, 'lxPeek.sessionNext').run()
  assert.deepEqual(fake.opened, ['a'], 'next is the row below in the sidebar, not the next-newest Session')
  press(fake, 'lxPeek.sessionPrevious').run()
  assert.deepEqual(fake.opened, ['a', 'd'], 'previous is the row above, wrapping at the top')
})

test('walks only the rows the sidebar shows when groups are collapsed', () => {
  const fake = activate(
    { desktop: true, document: sidebarDocument(['a', 'c']) },
    [session('a'), session('b', { retainedBy: { mainView: 1 } }), session('c')],
  )

  press(fake, 'lxPeek.sessionNext').run()
  assert.deepEqual(fake.opened, ['c'], 'the hidden b is not a target; the nearest visible row below is c')
})

test('skips archived rows, subagent children and unselected blanks', () => {
  const fake = activate({ desktop: true }, [
    session('a', { retainedBy: { mainView: 1 } }),
    session('archived'),
    session('child', { origin: 'subagent', parentId: 'a' }),
    session('other-blank', { blank: true }),
    session('z'),
  ])
  fake.state.archived = ['archived']

  press(fake, 'lxPeek.sessionNext').run()
  assert.deepEqual(fake.opened, ['z'], 'the archived, subagent and unselected blank rows are not targets')
})

test('keeps the selected blank navigable', () => {
  const fake = activate({ desktop: true }, [
    session('blank', { blank: true, retainedBy: { mainView: 1 } }),
    session('a'),
  ])

  press(fake, 'lxPeek.sessionNext').run()
  assert.deepEqual(fake.opened, ['a'], 'a selected blank stays in the order so the key leaves it')
})

test('keeps a dialog in front of the navigation', () => {
  const { commands, opened } = activate({ desktop: true }, [session('a', { retainedBy: { mainView: 1 } }), session('b')])
  const command = commands.get('lxPeek.sessionNext')

  assert.deepEqual(plain(command.resolve({ region: 'page', modal: 'settings', target: null })), {
    status: 'blocked',
    reason: 'close-dialog',
  })
  assert.equal(command.resolve({ region: 'page', modal: 'sidebar', target: null }).status, 'handled')
  assert.deepEqual(opened, [], 'resolving alone does not navigate')
})

test('blocks when there is no other Session to show', () => {
  const single = activate({ desktop: true }, [session('only', { retainedBy: { mainView: 1 } })])
  assert.deepEqual(plain(press(single, 'lxPeek.sessionNext')), { status: 'blocked', reason: 'no-session' })
  assert.deepEqual(single.opened, [])

  const empty = activate({ desktop: true }, [])
  assert.deepEqual(plain(press(empty, 'lxPeek.sessionPrevious')), { status: 'blocked', reason: 'no-session' })
})

test('starts at either end when no Session is retained by the main view', () => {
  const fake = activate({ desktop: true }, [session('a'), session('b')])
  press(fake, 'lxPeek.sessionNext').run()
  press(fake, 'lxPeek.sessionPrevious').run()
  assert.deepEqual(fake.opened, ['a', 'b'])
})

test('opens collapsed reasoning rows by default', () => {
  const running = thinkRow({ running: true, text: 'live reasoning' })
  const settled = thinkRow({ text: 'earlier reasoning' })
  const dom = expansionDocument([running, settled])
  activate(
    { desktop: true, ui: { expandReasoning: 'all' }, document: dom.document },
    [session('a', { retainedBy: { mainView: 1 } })],
  )

  assert.equal(running.clicks(), 1, 'the running reasoning row opens')
  assert.equal(settled.clicks(), 1, 'history opens too in "all" mode')
})

test('opens only the running reasoning row in stream mode', () => {
  const running = thinkRow({ running: true, text: 'live' })
  const settled = thinkRow({ text: 'old' })
  const dom = expansionDocument([running, settled])
  activate(
    { desktop: true, ui: { expandReasoning: 'stream' }, document: dom.document },
    [session('a', { retainedBy: { mainView: 1 } })],
  )

  assert.equal(running.clicks(), 1)
  assert.equal(settled.clicks(), 0, 'history stays closed')
})

test('leaves reasoning alone when expansion is off', () => {
  const row = thinkRow({ text: 'reasoning' })
  const dom = expansionDocument([row])
  activate(
    { desktop: true, ui: { expandReasoning: 'off' }, document: dom.document },
    [session('a', { retainedBy: { mainView: 1 } })],
  )

  assert.equal(row.clicks(), 0)
})

test('opens reasoning rows that stream in later', () => {
  const noise = thinkRow({ text: 'existing' })
  const dom = expansionDocument([])
  const { sandbox } = activate(
    { desktop: true, ui: { expandReasoning: 'all' }, document: dom.document },
    [session('a', { retainedBy: { mainView: 1 } })],
  )
  assert.equal(noise.clicks(), 0)

  const later = thinkRow({ running: true, text: 'streaming now' })
  sandbox.observer.callback([{ addedNodes: [later.root] }])
  assert.equal(later.clicks(), 1, 'an added reasoning row is opened')
})

test('never reopens a reasoning row the reader collapsed', () => {
  const row = thinkRow({ text: 'reasoning' })
  const dom = expansionDocument([row])
  const { sandbox } = activate(
    { desktop: true, ui: { expandReasoning: 'all' }, document: dom.document },
    [session('a', { retainedBy: { mainView: 1 } })],
  )
  assert.equal(row.clicks(), 1, 'opened once on activation')

  const click = dom.listeners.find((entry) => entry.type === 'click' && entry.capture)
  assert.ok(click, 'the face listens for manual disclosures')
  // Before React toggles it, the header still reports the open state.
  click.handler({ target: { closest: (selector) => (selector === '[data-disclosure-row]' ? row.header : null) } })
  delete row.attributes['data-expanded']

  sandbox.observer.callback([{ addedNodes: [row.root] }])
  assert.equal(row.clicks(), 1, 'the scan leaves the reader-collapsed row alone')
})
