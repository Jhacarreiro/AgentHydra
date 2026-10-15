// pricecheck/lib/static/conditions.mjs - what the static measurer can know about a condition before the page runs.
// A v-if, v-show or JSX condition evaluates to true, false or null (unknown) against what is fixed at the call site:
// the literal props a caller passes, the props it leaves out (undefined, or their declared default), and the viewport
// the page is priced at (a desktop pass and a phone pass). Anything else stays unknown and keeps the worst case.

/** A value that is passed but cannot be known statically (a bound variable). */
export const UNKNOWN = Symbol('unknown')

// Names that say the page is laid out for a phone, or for a desktop.
const PHONE_FLAG = /^(is|show|use|on)?(mobile|phone|handset)(viewport|screen|layout|width|device|mode|view|ui)?$|^(is)?(narrow|small|compact)(viewport|screen|layout|width)$|^(xs|smAndDown|mdAndDown)$/i
const DESKTOP_FLAG = /^(is|show|use|on)?desktop(viewport|screen|layout|width|device|mode|view|ui)?$|^(is)?(wide|large|widescreen)(viewport|screen|layout|width)$|^(lgAndUp|xlAndUp|mdAndUp)$/i

export const camel = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

/** A literal written in an attribute value: true/false/null/undefined, a number or a quoted string; UNKNOWN otherwise. */
export function literal(raw) {
  let s = String(raw).trim()
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1).trim()
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === 'undefined') return undefined
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  const q = /^(['"`])([^'"`$]*)\1$/.exec(s)
  return q ? q[2] : UNKNOWN
}

const SKIP_ATTR = /^(@|v-on:|#|v-slot|\{|on[A-Z])/
const NOT_PROP = new Set(['class', 'className', 'style', 'key', 'ref', 'id', 'is'])
const IDENT_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/

/**
 * The props a component tag passes, as { name: value | UNKNOWN }: a static attribute is its string (true when it has
 * no value), a bound literal is its value, a bound name the caller itself knows is forwarded, anything else UNKNOWN.
 */
export function propsOf(attrs, known = () => UNKNOWN) {
  const env = {}
  for (const [k, v] of Object.entries(attrs)) {
    // A spread (`v-bind="obj"`, `{...rest}`) may pass any prop: no prop it could set reads as left out.
    if (k === 'v-bind' || k.startsWith('{spread')) {
      env['...'] = true
      continue
    }
    if (SKIP_ATTR.test(k) || (k.startsWith('v-') && !k.startsWith('v-bind:') && !k.startsWith('v-model'))) continue
    const vModel = /^v-model(?::([\w-]+))?$/.exec(k)
    if (vModel) {
      env[camel(vModel[1] ?? 'modelValue')] = UNKNOWN
      continue
    }
    const bound = k.startsWith(':') || k.startsWith('v-bind:') || (typeof v === 'string' && v.startsWith('{'))
    const name = camel(k.replace(/^(:|v-bind:)/, ''))
    if (NOT_PROP.has(name) || !/^[\w$]+$/.test(name)) continue
    if (!bound) env[name] = v === true ? true : v
    else {
      const lit = literal(v)
      const expr = String(v).trim().replace(/^\{([\s\S]*)\}$/, '$1').trim()
      env[name] = lit !== UNKNOWN ? lit : IDENT_PATH.test(expr) ? known(expr) : UNKNOWN
    }
  }
  return env
}

function splitTop(s, op) {
  const parts = []
  let depth = 0
  let last = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'" || c === '`') {
      const e = s.indexOf(c, i + 1)
      if (e < 0) return [s]
      i = e
    } else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (depth === 0 && s.startsWith(op, i)) {
      parts.push(s.slice(last, i))
      i += op.length - 1
      last = i + 1
    }
  }
  parts.push(s.slice(last))
  return parts
}

const wrapped = (s) => {
  if (!s.startsWith('(') || !s.endsWith(')')) return false
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0 && i < s.length - 1) return false
  }
  return true
}

const truth = (v) => (v === UNKNOWN ? null : Boolean(v))

/**
 * A condition's truth: true, false or null (unknown). `look(path)` gives what a name holds (UNKNOWN when it cannot be
 * known). Handles ||, &&, !, parentheses, === / !== / == / != against a literal, and bare names; the rest is unknown.
 */
export function evaluate(expr, look) {
  const s = String(expr ?? '').trim()
  if (!s) return null
  const ors = splitTop(s, '||')
  if (ors.length > 1) {
    let unknown = false
    for (const p of ors) {
      const v = evaluate(p, look)
      if (v === true) return true
      if (v === null) unknown = true
    }
    return unknown ? null : false
  }
  const ands = splitTop(s, '&&')
  if (ands.length > 1) {
    let unknown = false
    for (const p of ands) {
      const v = evaluate(p, look)
      if (v === false) return false
      if (v === null) unknown = true
    }
    return unknown ? null : true
  }
  if (s.startsWith('!') && !s.startsWith('!=')) {
    const v = evaluate(s.slice(1), look)
    return v === null ? null : !v
  }
  if (wrapped(s)) return evaluate(s.slice(1, -1), look)
  if (s === 'true') return true
  if (s === 'false') return false
  const cmp = /^(.+?)\s*(===|!==|==|!=)\s*(.+)$/.exec(s)
  if (cmp) {
    let [, left, op, right] = cmp
    if (literal(left) !== UNKNOWN && literal(right) === UNKNOWN) [left, right] = [right, left]
    const want = literal(right)
    if (want === UNKNOWN || !IDENT_PATH.test(left.trim())) return null
    const have = look(left.trim())
    if (have === UNKNOWN) return null
    const loose = op.length === 2
    const same = loose ? have == want || (have === undefined && want === null) : have === want
    return op.startsWith('!') ? !same : same
  }
  if (IDENT_PATH.test(s)) return truth(look(s))
  return null
}

/** Whether a name, by its last segment, is a phone-layout flag ('phone'), a desktop one ('desktop'), or neither. */
export function viewportFlag(path) {
  const last = path.split(/\??\./).pop()
  if (PHONE_FLAG.test(last)) return 'phone'
  if (DESKTOP_FLAG.test(last)) return 'desktop'
  return null
}

function topLevelKeys(body) {
  const keys = []
  let depth = 0
  let token = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '"' || c === "'" || c === '`') {
      const e = body.indexOf(c, i + 1)
      token += body.slice(i, e < 0 ? body.length : e + 1)
      i = e < 0 ? body.length : e
      continue
    }
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++
    else if (c === '}' || c === ')' || c === ']' || (c === '>' && body[i - 1] !== '=')) depth--
    else if (depth === 0 && (c === ',' || c === ';' || c === '\n')) {
      keys.push(token)
      token = ''
      continue
    }
    token += c
  }
  keys.push(token)
  return keys.map((t) => t.trim()).filter(Boolean)
}

function balancedFrom(src, open) {
  const pairs = { '{': '}', '(': ')', '<': '>' }
  const close = pairs[src[open]]
  let depth = 0
  for (let k = open; k < src.length; k++) {
    const c = src[k]
    if (c === '"' || c === "'" || c === '`') {
      const e = src.indexOf(c, k + 1)
      if (e < 0) return src.length
      k = e
    } else if (c === src[open]) depth++
    else if (c === close && !(close === '>' && src[k - 1] === '=') && --depth === 0) return k
  }
  return src.length
}

const keyName = (entry) => /^(?:readonly\s+)?['"]?([A-Za-z_$][\w$-]*)['"]?\s*\??\s*:/.exec(entry)?.[1] ?? /^([A-Za-z_$][\w$]*)\s*(?:,|$|\(|=)/.exec(entry)?.[1]

/** `{ a: 1, b: 'x' }` as { a: 1, b: 'x' }, values that are not literals UNKNOWN. */
function objectDefaults(body) {
  const out = {}
  for (const entry of topLevelKeys(body)) {
    const m = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*([\s\S]+)$/.exec(entry)
    if (m) out[m[1]] = literal(m[2])
  }
  return out
}

/**
 * The props a component declares, as Map name -> default (undefined when it has none, UNKNOWN when it is not a
 * literal), or null when the file declares none it can read. Vue defineProps (type literal, in-file interface/type,
 * runtime object or array), withDefaults, the options API `props:`, and a React function's destructured first parameter.
 */
export function declaredProps(src, file) {
  if (!src) return null
  const props = new Map()
  const vue = /\.vue$/.test(file)
  if (vue) {
    const typed = /defineProps\s*<\s*/.exec(src)
    if (typed) {
      const at = typed.index + typed[0].length
      let body = null
      if (src[at] === '{') body = src.slice(at + 1, balancedFrom(src, at))
      else {
        const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(at))?.[0]
        const decl = name && new RegExp(`(?:interface\\s+${name}\\b[^{]*|type\\s+${name}\\s*=\\s*)\\{`).exec(src)
        if (decl) {
          const open = decl.index + decl[0].length - 1
          body = src.slice(open + 1, balancedFrom(src, open))
        }
      }
      if (body === null) return null
      for (const entry of topLevelKeys(body)) {
        const k = keyName(entry)
        if (k) props.set(camel(k), undefined)
      }
      const wd = /withDefaults\s*\(\s*defineProps\s*<[\s\S]*?>\s*\(\s*\)\s*,\s*\{/.exec(src)
      if (wd) {
        const open = wd.index + wd[0].length - 1
        for (const [k, v] of Object.entries(objectDefaults(src.slice(open + 1, balancedFrom(src, open))))) if (props.has(k)) props.set(k, v)
      }
      return props
    }
    const runtime = /(?:defineProps\s*\(\s*|\bprops\s*:\s*)([{[])/.exec(src)
    if (!runtime) return null
    const open = runtime.index + runtime[0].length - 1
    if (runtime[1] === '[') {
      const end = src.indexOf(']', open)
      for (const m of src.slice(open, end).matchAll(/['"]([\w-]+)['"]/g)) props.set(camel(m[1]), undefined)
      return props
    }
    for (const entry of topLevelKeys(src.slice(open + 1, balancedFrom(src, open)))) {
      const m = /^['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*([\s\S]*)$/.exec(entry)
      if (!m) continue
      const dm = /\bdefault\s*:\s*([^,}]+)/.exec(m[2])
      props.set(camel(m[1]), dm ? literal(dm[1]) : /^Boolean\b|type\s*:\s*Boolean\b/.test(m[2].trim().replace(/^\{\s*/, '')) ? false : undefined)
    }
    return props
  }
  if (!/\.(tsx|jsx)$/.test(file)) return null
  const fn = /export\s+default\s+function\s*\w*\s*\(\s*\{|(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*(?::[^=]+)?=\s*(?:\w+\.)?(?:memo|forwardRef)?\(?\s*(?:function\s*\w*)?)\s*\(\s*\{/.exec(src)
  if (!fn) return null
  const open = fn.index + fn[0].length - 1
  for (const entry of topLevelKeys(src.slice(open + 1, balancedFrom(src, open)))) {
    const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*)?\s*(?:=\s*([\s\S]+))?$/.exec(entry)
    if (m && !entry.startsWith('...')) props.set(m[1], m[2] === undefined ? undefined : literal(m[2]))
  }
  return props
}

/**
 * Names a component's script derives from its props, as Map name -> the expression it stands for:
 * `computed(() => expr)` (or a body that only returns expr), `toRef(props, 'x')`, `props.x`, and
 * `const { x, y: z } = toRefs(props)`. A template condition on such a name reads through to the props.
 */
export function derivedNames(src) {
  const out = new Map()
  if (!src) return out
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*computed\s*(?:<[^>]*>)?\s*\(\s*\(\s*\)\s*=>\s*/g)) {
    const at = m.index + m[0].length
    let expr
    if (src[at] === '{') {
      const body = src.slice(at + 1, balancedFrom(src, at)).trim()
      const ret = /^return\s+([\s\S]+?);?$/.exec(body)
      if (!ret || /\breturn\b/.test(ret[1])) continue
      expr = ret[1]
    } else {
      const open = src.lastIndexOf('(', m.index + m[0].indexOf('=>'))
      const callOpen = src.indexOf('(', m.index + m[0].indexOf('computed'))
      const end = balancedFrom(src, callOpen)
      expr = src.slice(at, end).trim()
      if (open < 0) continue
    }
    if (expr && expr.length < 300) out.set(m[1], expr.replace(/;\s*$/, ''))
  }
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*toRef\(\s*props\s*,\s*['"]([\w$]+)['"]\s*\)/g)) out.set(m[1], m[2])
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*props\.([\w$]+)\s*[;\n]/g)) out.set(m[1], m[2])
  for (const m of src.matchAll(/(?:const|let)\s+\{([^}]*)\}\s*=\s*toRefs\(\s*props\s*\)/g)) {
    for (const part of m[1].split(',')) {
      const pm = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/.exec(part)
      if (pm) out.set(pm[2] ?? pm[1], pm[1])
    }
  }
  return out
}
