// One-shot workspace reorder. No favorites, pins, persistent state or row icons.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-workspace-move-top',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var MENU_ITEM = 'data-wshub-move-top'
    var API_PATH = 'api/plugins/wshub-workspace-move-top/move'
    // Menu copy follows the host UI language (navigator.language). Backend error
    // messages are shown verbatim; only our own prefix is localized.
    var LANGUAGE = (typeof navigator !== 'undefined' && navigator && navigator.language) || ''
    var LABELS = /^zh/i.test(LANGUAGE)
      ? { menu: '移到最上面', hint: '只调整一次顺序，之后仍可自由拖动', busy: '正在调整顺序…', done: '已移到最上面', failed: '调整失败：' }
      : { menu: 'Move to top', hint: 'Moves this workspace once; you can still drag afterwards.', busy: 'Moving to top…', done: 'Moved to top', failed: 'Move failed: ' }

    function apply(ctx) {
      ctx.effect(function () {
        var workspaceId = null
        var busy = false
        var observer = null
        var timer = null
        var buttons = new Set()

        function rowId(target) {
          var row = target && target.closest && target.closest('[data-row-key^="workspace:"]')
          if (!row) return null
          var key = row.getAttribute('data-row-key') || ''
          return key.slice(10) || null
        }

        // Capture the row whose native workspace action button opened this menu.
        function onPointerDown(event) {
          if (!(event.target instanceof Element)) return
          var button = event.target.closest('button[aria-label]')
          if (event.target.closest('[role="menu"]')) return
          if (!button || button.hasAttribute('aria-keyshortcuts')) {
            workspaceId = null
            return
          }
          var row = button.closest('[data-row-key^="workspace:"]')
          workspaceId = row && row.querySelector('button[aria-label]') === button ? rowId(button) : null
        }

        async function moveToTop(button) {
          var id = button.dataset.wshubWorkspaceId
          if (!id || busy) return
          busy = true
          button.disabled = true
          button.title = LABELS.busy
          try {
            var response = await fetch(API_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ workspaceId: id, action: 'move-to-top' }),
            })
            var result = await response.json().catch(function () { return null })
            if (!response.ok || !result || result.ok !== true) throw new Error((result && result.message) || ('HTTP ' + response.status))
            button.title = LABELS.done
            // Closing the native menu removes the extension row with it.
            var trigger = document.activeElement
            if (trigger && trigger.closest && trigger.closest('[data-row-key^="workspace:"]')) trigger.click()
            var event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
            document.dispatchEvent(event)
            // DOM teardown is authoritative; the Host publishes the new order.
          } catch (error) {
            button.disabled = false
            button.title = LABELS.failed + (error instanceof Error ? error.message : String(error))
            button.setAttribute('aria-label', button.title)
          } finally {
            busy = false
          }
        }

        function decorate() {
          observer.disconnect()
          try {
            var menus = document.querySelectorAll('[role="menu"][data-menu-material="translucent"]')
            for (var i = 0; i < menus.length; i++) {
              var menu = menus[i]
              if (!workspaceId || menu.querySelector('[' + MENU_ITEM + ']')) continue
              var viewport = menu.querySelector('[role="presentation"]')
              var template = viewport && viewport.querySelector('button[role="menuitem"]')
              if (!template) continue
              // Clone only native menu classes/row structure; do not copy its actions.
              var wrapper = template.parentElement.cloneNode(false)
              var button = template.cloneNode(false)
              button.setAttribute(MENU_ITEM, '1')
              button.dataset.wshubWorkspaceId = workspaceId
              button.removeAttribute('class')
              button.className = template.className
              button.setAttribute('aria-label', LABELS.menu)
              button.title = LABELS.hint
              var spans = template.querySelectorAll('span')
              if (spans[0]) {
                var icon = document.createElement('span')
                icon.className = spans[0].className
                icon.textContent = '↑'
                button.appendChild(icon)
              }
              var label = document.createElement('span')
              var labelTemplate = spans[1] || spans[0]
              if (labelTemplate) label.className = labelTemplate.className
              label.textContent = LABELS.menu
              button.appendChild(label)
              button.addEventListener('click', function (event) {
                event.preventDefault()
                event.stopPropagation()
                void moveToTop(event.currentTarget)
              })
              wrapper.appendChild(button)
              viewport.insertBefore(wrapper, viewport.firstChild)
              buttons.add(button)
            }
          } finally {
            observer.observe(document.documentElement, { childList: true, subtree: true })
          }
        }
        function schedule() {
          if (timer !== null) return
          timer = setTimeout(function () { timer = null; decorate() }, 40)
        }
        observer = new MutationObserver(schedule)
        observer.observe(document.documentElement, { childList: true, subtree: true })
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onPointerDown, true)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onPointerDown, true)
          observer.disconnect()
          if (timer !== null) clearTimeout(timer)
          buttons.forEach(function (button) { button.remove() })
          buttons.clear()
        }
      })
    }
    exports.apply = apply
    return module.exports
  },
})
