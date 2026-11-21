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
// Session and Workspace services.

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

/** Load the bundle and return the registration row it pushes plus its plugin exports. */
function loadFace({ desktop = true } = {}) {
  const sandbox = { console }
  sandbox.window = sandbox
  sandbox.__ModuleLoader__ = {
    load(row) {
      sandbox.row = row
    },
  }
  if (desktop) sandbox.dshDesktop = { protocolVersion: 1 }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'src/client.js' })
  assert.ok(sandbox.row, 'the bundle registers itself with the module table')
  return sandbox.row
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

/** Activate the face against a context and return its command map. */
function activate(options, sessions) {
  const row = loadFace(options)
  const fake = createContext(sessions)
  row.factory(() => {
    throw new Error('the client face requires no other module')
  }).apply(fake.ctx)
  return fake
}

/** Resolve one registered command as a keyboard press with no dialog in front. */
function press(fake, id) {
  const command = fake.commands.get(id)
  assert.ok(command, `command ${id} is registered`)
  return command.resolve({ source: 'keyboard', region: 'page', modal: null, target: null })
}

test('manifest declares the client face the module table can serve', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  // The bundle requires no other module, so it declares no module-graph edges
  // the services it reads are named by its Cordis inject export instead.
  assert.equal(pkg.dsh.client.inject, undefined)
  const entry = pkg.exports['./client']
  const file = typeof entry === 'string' ? entry : entry.default
  assert.ok(existsSync(join(root, file)), `${file} exists`)
  const row = loadFace()
  assert.equal(row.id, pkg.name, 'the bundle id is the package name the Loader row resolves')
  assert.equal(typeof row.factory, 'function')
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

test('walks the Host list order and wraps at both ends', () => {
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
  const fake = activate({ desktop: true }, [session('a', { retainedBy: { mainView: 1 } }), session('b')])
  const command = fake.commands.get('lxPeek.sessionNext')

  assert.deepEqual(plain(command.resolve({ region: 'page', modal: 'settings', target: null })), {
    status: 'blocked',
    reason: 'close-dialog',
  })
  assert.equal(command.resolve({ region: 'page', modal: 'sidebar', target: null }).status, 'handled')
  assert.deepEqual(fake.opened, [], 'resolving alone does not navigate')
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
