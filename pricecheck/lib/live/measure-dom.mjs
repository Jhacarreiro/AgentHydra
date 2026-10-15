// Runs inside the page (serialised with toString), so it must not close over anything outside its body.
export function measureInPage(options = {}) {
  const rootPrefix = String(options.root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const tally = new Map()
  const add = (unit, file, n = 1) => {
    if (!(n > 0)) return
    const key = unit + '\u0000' + file
    tally.set(key, (tally.get(key) ?? 0) + n)
  }

  const clean = (raw) => {
    let file = String(raw).replace(/\\/g, '/')
    if (rootPrefix && file.startsWith(rootPrefix + '/')) file = file.slice(rootPrefix.length + 1)
    return file
  }

  const ownerOf = (el) => {
    const vue3 = el.__vueParentComponent?.type
    if (vue3) return clean(vue3.__file || vue3.__name || vue3.name || 'anonymous')
    const vue2 = el.__vue__?.$options
    if (vue2) return clean(vue2.__file || vue2.name || vue2._componentTag || 'anonymous')
    const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
    if (fiberKey) {
      for (let f = el[fiberKey]; f; f = f.return) {
        if (typeof f.type === 'function') {
          const src = f._debugSource?.fileName
          return clean(src || f.type.displayName || f.type.name || 'anonymous')
        }
      }
    }
    const svelte = el.__svelte_meta?.loc?.file
    if (svelte) return clean(svelte)
    const angular = window.ng?.getOwningComponent?.(el)
    if (angular) return clean(angular.constructor?.name || 'anonymous')
    return null
  }

  const fileOf = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const owner = ownerOf(n)
      if (owner) return owner
    }
    return '(page)'
  }

  const shown = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
      if (n.getAttribute('aria-hidden') === 'true' || n.inert) return false
    }
    return true
  }

  const visible = (selector) => [...document.querySelectorAll(selector)].filter(shown)

  const controls = visible(
    'a[href], button, input[type=button], input[type=submit], input[type=reset], input[type=checkbox], ' +
      '[role=button], [role=link], [role=tab], [role=switch], [role=checkbox], [role=menuitem]',
  )
  for (const el of controls) add('control', fileOf(el))

  const fields = visible(
    'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox])' +
      ':not([type=radio]):not([type=image]), textarea, select, [contenteditable=true]',
  )
  for (const el of fields) add('field', fileOf(el))

  for (const select of visible('select')) {
    if (select.options.length > 1) add('choice', fileOf(select), select.options.length - 1)
  }
  const radioGroups = new Map()
  for (const radio of visible('input[type=radio]')) {
    const key = radio.name || radio
    radioGroups.set(key, [...(radioGroups.get(key) ?? []), radio])
  }
  for (const group of radioGroups.values()) {
    if (group.length > 1) add('choice', fileOf(group[0]), group.length - 1)
  }
  for (const list of visible('[role=listbox], [role=menu], [role=radiogroup]')) {
    const items = [...list.children].filter((c) => shown(c) && /^(option|menuitemradio|radio)$/.test(c.getAttribute('role') ?? ''))
    if (items.length > 1) add('choice', fileOf(list), items.length - 1)
  }

  const media = visible('img, svg, video, canvas')
  for (const el of media) add('media', fileOf(el))

  const featureSet = new Set(visible('section, article, [role=article], [role=region][aria-label], [class~=card], [class~=tile]'))
  for (const el of featureSet) {
    let nested = false
    for (let p = el.parentElement; p && !nested; p = p.parentElement) nested = featureSet.has(p)
    if (!nested) add('feature', fileOf(el))
  }

  for (const el of visible('[data-product], [data-pricecheck=product]')) add('product', fileOf(el))

  const interruptionSet = new Set(
    visible('dialog[open], [role=dialog], [role=alertdialog], [role=alert], [role=status]').concat(
      [...document.querySelectorAll('[id], [class]')].filter((el) => {
        const tag = `${el.id} ${el.className?.baseVal ?? el.className ?? ''}`
        return /cookie|consent|toast|banner/i.test(tag) && getComputedStyle(el).position === 'fixed' && shown(el)
      }),
    ),
  )
  for (const el of interruptionSet) {
    let nested = false
    for (let p = el.parentElement; p && !nested; p = p.parentElement) nested = interruptionSet.has(p)
    if (!nested) add('interruption', fileOf(el))
  }

  // Motion is what keeps moving on its own: a loop, or an animation of 3 s or more. A shorter one is the page
  // arriving (an entrance slide or fade), which the wait already prices.
  const movers = new Set()
  for (const anim of document.getAnimations()) {
    const target = anim.effect?.target
    const timing = anim.effect?.getComputedTiming()
    const lasting = timing && (timing.iterations === Number.POSITIVE_INFINITY || timing.endTime >= 3000)
    if (anim.playState === 'running' && lasting && target && shown(target)) movers.add(target)
  }
  for (const el of movers) add('motion', fileOf(el))

  const screens = Math.max(1, Math.ceil(document.documentElement.scrollHeight / innerHeight))
  add('screen', '(page)', screens)

  const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const docLang = (document.documentElement.lang || '').toLowerCase().split('-')[0]
  const wordsByFile = new Map()
  const colors = new Set()
  const sizes = new Set()
  for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
    const parent = node.parentElement
    if (!parent || parent.closest('head, title, script, style, noscript, template, select, option, [aria-hidden=true]')) continue
    const lang = (parent.closest('[lang]')?.getAttribute('lang') || '').toLowerCase().split('-')[0]
    if (docLang && lang && lang !== docLang) continue
    const words = node.textContent.trim().split(/\s+/).filter(Boolean).length
    if (!words || parent.getClientRects().length === 0 || parent.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) === false) continue
    if (!shown(parent)) continue
    const file = fileOf(parent)
    wordsByFile.set(file, (wordsByFile.get(file) ?? 0) + words)
    const cs = getComputedStyle(parent)
    colors.add(cs.color)
    sizes.add(cs.fontSize)
  }
  for (const [file, n] of wordsByFile) add('word', file, n)

  for (const el of [document.documentElement, ...document.body.querySelectorAll('*')]) {
    if (!shown(el)) continue
    const bg = getComputedStyle(el).backgroundColor
    if (bg && bg !== 'transparent' && !/,\s*0\)$/.test(bg)) colors.add(bg)
  }
  add('color', '(page)', colors.size)
  add('type', '(page)', sizes.size)

  const nav = performance.getEntriesByType('navigation')[0]
  const readyMs = nav ? nav.loadEventEnd || nav.domContentLoadedEventEnd : performance.now()
  add('wait', '(page)', Math.ceil(readyMs / 100))

  const items = [...tally].map(([key, count]) => {
    const [unit, file] = key.split('\u0000')
    return { unit, file, count }
  })
  return { viewport: { width: innerWidth, height: innerHeight }, items, timing: { readyMs: Math.round(readyMs) } }
}
