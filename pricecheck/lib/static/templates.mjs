// pricecheck/lib/static/templates.mjs - reads a page's markup (Vue SFC, Svelte, HTML, Astro, JSX/TSX) into a small tree.
// Expressions in text become placeholders (\u0001n\u0002) whose source is kept in `exprs`, so i18n can resolve them.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'pc-else'])
const RAW = new Set(['script', 'style'])
const SVELTE_BLOCK = { if: 'pc-if', await: 'pc-if', key: 'pc-if', each: 'pc-each' }
const RE_OPEN = /<([A-Za-z][\w.:-]*)/y
const RE_CLOSE = /<\/([A-Za-z][\w.:-]*)?\s*>/y
const RE_NAME = /[^\s=>/"'{]+/y
const RE_BARE = /[^\s>]+/y

const lineStarts = (src) => {
  const starts = [0]
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) starts.push(k + 1)
  return starts
}

function skipBalanced(src, j) {
  let depth = 0
  for (let k = j; k < src.length; k++) {
    const c = src[k]
    if (c === '"' || c === "'" || c === '`') {
      const e = src.indexOf(c, k + 1)
      if (e < 0) return src.length
      k = e
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return k + 1
  }
  return src.length
}

function readTag(src, j) {
  const attrs = {}
  for (;;) {
    while (j < src.length && /\s/.test(src[j])) j++
    if (j >= src.length) return { attrs, end: j, selfClosing: false }
    const c = src[j]
    if (c === '>') return { attrs, end: j + 1, selfClosing: false }
    if (src.startsWith('/>', j)) return { attrs, end: j + 2, selfClosing: true }
    if (c === '/') {
      j++
      continue
    }
    if (c === '{') {
      j = skipBalanced(src, j)
      attrs[`{spread${j}}`] = true
      continue
    }
    RE_NAME.lastIndex = j
    const m = RE_NAME.exec(src)
    if (!m) {
      j++
      continue
    }
    const name = m[0]
    j += name.length
    let k = j
    while (k < src.length && /\s/.test(src[k])) k++
    if (src[k] !== '=') {
      attrs[name] = true
      continue
    }
    k++
    while (k < src.length && /\s/.test(src[k])) k++
    const q = src[k]
    if (q === '"' || q === "'") {
      const e = src.indexOf(q, k + 1)
      const end = e < 0 ? src.length : e
      attrs[name] = src.slice(k + 1, end)
      j = end + 1
    } else if (q === '{') {
      const end = skipBalanced(src, k)
      attrs[name] = src.slice(k, end)
      j = end
    } else {
      RE_BARE.lastIndex = k
      const bm = RE_BARE.exec(src)
      attrs[name] = bm ? bm[0] : ''
      j = k + (bm ? bm[0].length : 0)
    }
  }
}

/** Parses src[from, to) into { root, exprs }. The root is a '#root' element; unclosed tags close with their parent. */
export function parseMarkup(src, mode = 'html', from = 0, to = src.length) {
  const starts = lineStarts(src)
  const lineOf = (pos) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const root = { type: 'el', tag: '#root', attrs: {}, children: [], line: 1 }
  const stack = [root]
  const exprs = []
  const top = () => stack[stack.length - 1]
  let buf = ''
  let bufAt = 0
  const emitText = () => {
    if (buf) top().children.push({ type: 'text', text: buf, line: lineOf(bufAt) })
    buf = ''
  }
  const addText = (s, at) => {
    if (!buf) bufAt = at
    buf += s
  }
  const holder = (expr, at) => {
    exprs.push(expr)
    addText(`\u0001${exprs.length - 1}\u0002`, at)
  }
  const openEl = (tag, attrs, at, push) => {
    emitText()
    const el = { type: 'el', tag, attrs, children: [], line: lineOf(at) }
    top().children.push(el)
    if (push) stack.push(el)
    return el
  }
  const closeTo = (tag) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag.toLowerCase() === tag) {
        emitText()
        stack.length = k
        return
      }
    }
  }

  let i = from
  while (i < to) {
    const c = src[i]
    if (c === '<' && i + 1 < to) {
      if (src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i + 4)
        i = e < 0 ? to : e + 3
        continue
      }
      if (src[i + 1] === '!' || src[i + 1] === '?') {
        const e = src.indexOf('>', i)
        i = e < 0 ? to : e + 1
        continue
      }
      RE_CLOSE.lastIndex = i
      const cm = RE_CLOSE.exec(src)
      if (cm && i < to) {
        closeTo((cm[1] ?? '').toLowerCase())
        i += cm[0].length
        continue
      }
      if (src.startsWith('<>', i)) {
        openEl('', {}, i, true)
        i += 2
        continue
      }
      RE_OPEN.lastIndex = i
      const om = RE_OPEN.exec(src)
      if (om) {
        const tag = om[1]
        const { attrs, end, selfClosing } = readTag(src, i + om[0].length)
        i = end
        const lower = tag.toLowerCase()
        if (RAW.has(lower)) {
          emitText()
          const close = src.toLowerCase().indexOf(`</${lower}`, i)
          i = close < 0 ? to : src.indexOf('>', close) + 1
          continue
        }
        openEl(tag, attrs, i, !selfClosing && !VOID.has(lower))
        continue
      }
    }
    if (c === '{' && mode === 'vue' && src.startsWith('{{', i)) {
      const e = src.indexOf('}}', i + 2)
      const end = e < 0 || e >= to ? to : e + 2
      holder(src.slice(i + 2, end - 2), i)
      i = end
      continue
    }
    if (c === '{' && mode === 'svelte') {
      const end = Math.min(skipBalanced(src, i), to)
      const body = src.slice(i + 1, end - 1).trim()
      if (body.startsWith('#')) {
        const kind = body.slice(1).split(/\s/)[0]
        const tag = SVELTE_BLOCK[kind]
        if (tag) openEl(tag, {}, i, true)
      } else if (body.startsWith(':')) {
        emitText()
        top().children.push({ type: 'el', tag: 'pc-else', attrs: {}, children: [], line: lineOf(i) })
      } else if (body.startsWith('/')) {
        const kind = body.slice(1).trim()
        if (SVELTE_BLOCK[kind]) closeTo(SVELTE_BLOCK[kind])
      } else holder(body, i)
      i = end
      continue
    }
    if (c === '{' && mode === 'jsx') {
      const end = Math.min(skipBalanced(src, i), to)
      const expr = src.slice(i + 1, end - 1)
      const lt = expr.indexOf('<')
      if (lt >= 0) i = i + 1 + lt
      else {
        holder(expr, i)
        i = end
      }
      continue
    }
    addText(c, i)
    i++
  }
  emitText()
  return { root, exprs }
}

function balancedParen(src, open) {
  let depth = 0
  for (let k = open; k < src.length; k++) {
    const c = src[k]
    if (c === '"' || c === "'" || c === '`') {
      const e = src.indexOf(c, k + 1)
      if (e < 0) return src.length
      k = e
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return k
  }
  return src.length
}

/** The markup range of a file: the template of an SFC, the JSX a component returns, the body of an HTML page. */
export function templateRange(file, src) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'vue') {
    const m = /^<template\b[^>]*>/m.exec(src)
    if (!m) return { mode: 'vue', from: 0, to: 0 }
    const close = src.lastIndexOf('</template>')
    return { mode: 'vue', from: m.index + m[0].length, to: close > m.index ? close : src.length }
  }
  if (ext === 'svelte') return { mode: 'svelte', from: 0, to: src.length }
  if (ext === 'tsx' || ext === 'jsx') {
    const m = /return\s*\(\s*(?=<)/.exec(src) ?? /=>\s*\(\s*(?=<)/.exec(src) ?? /return\s*(?=<)/.exec(src)
    if (!m) return { mode: 'jsx', from: 0, to: 0 }
    const start = m.index + m[0].length
    if (src[start - 1] === '(' || /\(\s*$/.test(m[0])) return { mode: 'jsx', from: start, to: balancedParen(src, m.index + m[0].indexOf('(')) }
    return { mode: 'jsx', from: start, to: src.length }
  }
  let from = 0
  if (ext === 'astro' && src.startsWith('---')) {
    const e = src.indexOf('---', 3)
    from = e < 0 ? 0 : e + 3
  }
  const body = /<body\b[^>]*>/i.exec(src)
  if (body && body.index >= from) {
    const close = src.toLowerCase().lastIndexOf('</body>')
    return { mode: 'html', from: body.index + body[0].length, to: close > body.index ? close : src.length }
  }
  return { mode: 'html', from, to: src.length }
}

/** A file's markup as { root, exprs, mode }, ready for measuring. */
export function readTemplate(file, src) {
  const { mode, from, to } = templateRange(file, src)
  return { mode, ...parseMarkup(src, mode, from, to) }
}
