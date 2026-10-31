import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The client bundle is a browser classic-script wrapper; run it under Node with
// a minimal fake DOM/fetch/timers so its behaviour is verified without any
// browser or new dependency.

const CLIENT_URL = new URL('../client/client.js', import.meta.url)
const MOVE_API = 'api/plugins/wshub-workspace-move-top/move'

// ---------------------------------------------------------------- //
// Minimal fake DOM
// ---------------------------------------------------------------- //

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.style = {}
    this.listeners = new Map()
    this.textContent = ''
    this.title = ''
    this.disabled = false
    this.draggable = false
    this.removed = false
    this.className = ''
    this.dataset = {}
    this.classList = { contains: () => false }
  }

  get parentElement() { return this.parentNode }
  get firstElementChild() { return this.children[0] || null }

  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector === '[data-row-key^="workspace:"]' && (node.getAttribute('data-row-key') || '').startsWith('workspace:')) return node
      if (selector === 'button[aria-label]' && node.tagName === 'BUTTON' && node.getAttribute('aria-label')) return node
      if (selector === '[role="menu"]' && node.getAttribute('role') === 'menu') return node
    }
    return null
  }

  cloneNode() {
    const clone = new FakeElement(this.tagName)
    clone.attributes = new Map(this.attributes)
    clone.className = this.className
    return clone
  }

  querySelector(selector) {
    if (selector === 'button[aria-label]') {
      for (const child of this.children) if (child.tagName === 'BUTTON' && child.getAttribute('aria-label')) return child
    }
    return this.querySelectorAll(selector)[0] || null
  }

  querySelectorAll(selector) {
    const matches = []
    const walk = (node) => {
      if (selector === 'button[role="menuitem"]' && node.tagName === 'BUTTON' && node.getAttribute('role') === 'menuitem') matches.push(node)
      if (selector === '[data-wshub-move-top]' && node.getAttribute('data-wshub-move-top')) matches.push(node)
      if (selector === '[role="presentation"]' && node.getAttribute('role') === 'presentation') matches.push(node)
      if (selector === 'span' && node.tagName === 'SPAN') matches.push(node)
      node.children.forEach(walk)
    }
    this.children.forEach(walk)
    return matches
  }

  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== fn))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  hasAttribute(name) { return this.attributes.has(name) }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child)
    const at = this.children.indexOf(before)
    this.children.splice(at < 0 ? this.children.length : at, 0, child)
    child.parentNode = this
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
    this.removed = true
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  dispatch(type, event = {}) {
    if (event.currentTarget === undefined) event.currentTarget = this
    const fns = this.listeners.get(type) || []
    for (const fn of [...fns]) fn.call(this, event)
  }

  get lastElementChild() {
    return this.children.length > 0 ? this.children[this.children.length - 1] : null
  }
}

function createDocument() {
  const html = new FakeElement('html')
  const body = new FakeElement('body')
  html.appendChild(body)
  const elements = [html, body]
  return Object.assign(body, {
    html,
    body,
    documentElement: html,
    dispatchEvent(event) { return this.dispatch(event.type, event) },
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll(selector) {
      if (selector === '[data-row-key^="workspace:"]') {
        return elements.filter((el) => (el.getAttribute('data-row-key') || '').startsWith('workspace:'))
      }
      if (selector === '[role="menu"][data-menu-material="translucent"]') return elements.filter((el) => el.getAttribute('role') === 'menu' && el.getAttribute('data-menu-material') === 'translucent')
      return []
    },
    register(el) {
      elements.push(el)
      return el
    },
  })
}

function makeRow(document, id) {
  const row = new FakeElement('div')
  row.setAttribute('role', 'treeitem')
  row.setAttribute('data-row-key', `workspace:${id}`)
  document.register(row)
  document.body.appendChild(row)
  return row
}

function openWorkspaceMenu(document, id) {
  const row = makeRow(document, id)
  const trigger = new FakeElement('button')
  trigger.setAttribute('aria-label', '工作区操作')
  row.appendChild(trigger)
  if (id) document.dispatch('pointerdown', { target: trigger })
  const menu = new FakeElement('div')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('data-menu-material', 'translucent')
  const material = new FakeElement('div')
  material.setAttribute('aria-hidden', 'true')
  menu.appendChild(material)
  const viewport = new FakeElement('div')
  viewport.setAttribute('role', 'presentation')
  const wrapper = new FakeElement('div')
  const native = new FakeElement('button')
  native.className = 'native-menu-item'
  native.setAttribute('role', 'menuitem')
  const icon = new FakeElement('span')
  icon.className = 'native-menu-icon'
  native.appendChild(icon)
  const label = new FakeElement('span')
  label.className = 'native-menu-label'
  native.appendChild(label)
  wrapper.appendChild(native)
  viewport.appendChild(wrapper)
  menu.appendChild(viewport)
  document.register(menu)
  document.body.appendChild(menu)
  FakeMutationObserver.instances[0].trigger()
  return menu
}

// ---------------------------------------------------------------- //
// Fake platform primitives
// ---------------------------------------------------------------- //

class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb
    this.connected = false
    this.target = null
    ;(FakeMutationObserver.instances ||= []).push(this)
  }
  observe(target, options) {
    this.target = target
    this.options = options
    this.connected = true
  }
  disconnect() {
    this.connected = false
  }
  trigger() {
    if (this.connected) this.cb([], this)
  }
}
FakeMutationObserver.instances = []

class FakeAbortController {
  constructor() {
    this.signal = { aborted: false, reason: undefined }
    this.aborted = false
    ;(FakeAbortController.instances ||= []).push(this)
  }
  abort(reason) {
    this.aborted = true
    this.signal.aborted = true
    this.signal.reason = reason
  }
}
FakeAbortController.instances = []

function createTimers() {
  let seq = 0
  const timers = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    pending() {
      return timers.size
    },
    flush() {
      const ids = [...timers.keys()]
      for (const id of ids) {
        const timer = timers.get(id)
        timers.delete(id)
        timer.fn()
      }
    },
  }
}

function createFetch() {
  const calls = []
  let handler = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, order: [], workspaces: [] }) })
  async function fetch(url, init) {
    calls.push({ url, init })
    return await handler(url, init)
  }
  return {
    fetch,
    calls,
    respond(fn) {
      handler = fn
    },
  }
}

// ---------------------------------------------------------------- //
// Bundle loader
// ---------------------------------------------------------------- //

function loadClient(deps) {
  const source = readFileSync(CLIENT_URL, 'utf8')
  const runner = new Function(
    'window',
    'document',
    'MutationObserver',
    'fetch',
    'setTimeout',
    'clearTimeout',
    'AbortController',
    source,
  )
  const registry = {}
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        registry[spec.id] = spec
      },
    },
  }
  runner(
    fakeWindow,
    deps.document,
    deps.MutationObserver,
    deps.fetch,
    deps.setTimeout,
    deps.clearTimeout,
    deps.AbortController,
  )
  const spec = registry['dsh-plugin-workspace-move-top']
  assert.ok(spec, 'bundle registers under the wrapper id dsh-plugin-workspace-move-top')
  const mod = spec.factory(function require() {
    throw new Error('client bundle must not require any module')
  })
  assert.equal(typeof mod.apply, 'function', 'bundle exports apply(ctx)')
  return mod
}

function createCtx() {
  const disposers = []
  return {
    disposers,
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
}

function mount(t, response, language = 'zh-CN') {
  Object.defineProperty(global, 'navigator', { value: { language }, configurable: true })
  global.Element = FakeElement
  global.KeyboardEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init) } }
  const document = createDocument()
  const timers = createTimers()
  const fakeFetch = createFetch()
  if (response) fakeFetch.respond(response)
  FakeMutationObserver.instances = []
  const mod = loadClient({ document, MutationObserver: FakeMutationObserver, fetch: fakeFetch.fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
  const ctx = createCtx()
  mod.apply(ctx)
  t.after(() => { ctx.disposers.forEach((dispose) => dispose()); delete global.Element; delete global.KeyboardEvent; delete global.navigator })
  return { document, timers, fakeFetch, ctx }
}

test('menu contains one native-styled move action and no star or initial read', async (t) => {
  const { document, timers, fakeFetch } = mount(t)
  const menu = openWorkspaceMenu(document, 'ws-1')
  timers.flush()
  assert.equal(menu.querySelectorAll('[data-wshub-move-top]').length, 1)
  assert.equal(menu.querySelector('[data-wshub-move-top]').className, 'native-menu-item')
  assert.equal(menu.querySelector('[data-wshub-move-top]').textContent, '')
  assert.equal(fakeFetch.calls.length, 0)
  timers.flush()
  assert.equal(menu.querySelectorAll('[data-wshub-move-top]').length, 1)
})

test('click sends only a one-shot exact-ID move command and handles failure honestly', async (t) => {
  let fail = true
  const { document, timers, fakeFetch } = mount(t, async (url, init) => {
    assert.equal(url, MOVE_API)
    assert.deepEqual(JSON.parse(init.body), { workspaceId: 'ws-1', action: 'move-to-top' })
    if (fail) return { ok: false, status: 500, json: async () => ({ ok: false, message: '写入失败' }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, action: 'move-to-top', moved: 1 }) }
  })
  const menu = openWorkspaceMenu(document, 'ws-1')
  timers.flush()
  const button = menu.querySelector('[data-wshub-move-top]')
  click(button)
  await settle()
  assert.equal(button.disabled, false)
  assert.match(button.title, /写入失败/)
  fail = false
  click(button)
  await settle()
  assert.equal(button.title, '已移到最上面')
  assert.equal(fakeFetch.calls.length, 2)
})

test('non-Chinese browser uses English menu and feedback labels', async (t) => {
  const { document, timers } = mount(t, undefined, 'en-US')
  const menu = openWorkspaceMenu(document, 'ws-1')
  timers.flush()
  const button = menu.querySelector('[data-wshub-move-top]')
  assert.equal(button.getAttribute('aria-label'), 'Move to top')
  assert.match(button.title, /drag afterwards/)
})

test('another menu does not inherit the prior workspace target', (t) => {
  const { document, timers } = mount(t)
  openWorkspaceMenu(document, 'ws-1')
  const plus = new FakeElement('button')
  plus.setAttribute('aria-label', '新建会话')
  plus.setAttribute('aria-keyshortcuts', 'Meta+N')
  document.body.appendChild(plus)
  document.dispatch('pointerdown', { target: plus })
  const sessionMenu = openWorkspaceMenu(document, null)
  timers.flush()
  assert.equal(sessionMenu.querySelector('[data-wshub-move-top]'), null)
})

test('unloading removes the extension and its native-menu event listeners', (t) => {
  const { document, timers, ctx } = mount(t)
  const menu = openWorkspaceMenu(document, 'ws-1')
  timers.flush()
  assert.ok(menu.querySelector('[data-wshub-move-top]'))
  ctx.disposers.forEach((dispose) => dispose())
  assert.equal(menu.querySelector('[data-wshub-move-top]'), null)
  assert.equal(FakeMutationObserver.instances[0].connected, false)
  assert.equal(timers.pending(), 0)
})

function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

function click(button) {
  let stopped = false
  let prevented = false
  button.dispatch('click', {
    preventDefault() {
      prevented = true
    },
    stopPropagation() {
      stopped = true
    },
  })
  return { stopped, prevented }
}
