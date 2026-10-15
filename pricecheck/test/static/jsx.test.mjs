import { describe as group, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { priceRepo } from '../../lib/static/measure.mjs'
import { readTemplate } from '../../lib/static/templates.mjs'

function repo(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-jsx-'))
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

const page = (body) =>
  `export default function Page({ isOpen, ready, ok, mode, items }: any) {\n  return (\n    <main>\n      ${body}\n    </main>\n  )\n}\n`
const priceOf = (body) => priceRepo({ root: repo({ 'src/Page.tsx': page(body) }), pages: ['src/Page.tsx'] }).pages[0]
const treeOf = (body) => readTemplate('Page.tsx', page(body))
const find = (node, tag) => {
  if (node.tag === tag) return node
  for (const c of node.children ?? []) {
    const hit = find(c, tag)
    if (hit) return hit
  }
  return undefined
}
const tagsOf = (node) => node.children.map((c) => (c.type === 'text' ? '#text' : c.tag))

const BIG = '<button>Open the big panel with several words</button>'
const SMALL = '<p>Hint</p>'

group('jsx conditional expressions', () => {
  test('a ternary prices only its dearer arm and keeps the condition', () => {
    const body = `{isOpen ? ${BIG} : ${SMALL}}`
    const node = find(treeOf(body).root, 'pc-if')
    expect(node.attrs.when).toEqual(['isOpen'])
    expect(tagsOf(node)).toEqual(['button', 'pc-else', 'p'])
    expect(priceOf(body).points).toBe(priceOf(BIG).points)
    expect(priceOf(body).points).toBeLessThan(priceOf(`${BIG}${SMALL}`).points)
  })

  test('a nested ternary is one pc-if with three branches and prices the dearest', () => {
    const body = `{mode === 'a' ? ${BIG} : mode === 'b' ? <p>Beta</p> : <span>Gamma</span>}`
    const node = find(treeOf(body).root, 'pc-if')
    expect(node.attrs.when).toEqual(["mode === 'a'", "mode === 'b'"])
    expect(tagsOf(node)).toEqual(['button', 'pc-else', 'p', 'pc-else', 'span'])
    expect(priceOf(body).points).toBe(priceOf(BIG).points)
  })

  test('a && with a JSX right side is a one-branch pc-if priced as shown', () => {
    const body = `{ready && ${BIG}}`
    const node = find(treeOf(body).root, 'pc-if')
    expect(node.attrs.when).toEqual(['ready'])
    expect(tagsOf(node)).toEqual(['button'])
    expect(priceOf(body).points).toBe(priceOf(BIG).points)
  })

  test('a null arm contributes nothing and a parenthesised JSX arm is an element', () => {
    const body = '{ok ? (<button>Retry the request</button>) : null}'
    const node = find(treeOf(body).root, 'pc-if')
    expect(node.attrs.when).toEqual(['ok'])
    expect(tagsOf(node)).toEqual(['button', 'pc-else'])
    expect(priceOf(body).points).toBe(priceOf('<button>Retry the request</button>').points)
  })

  test('a fragment arm is an element with no tag', () => {
    const node = find(treeOf('{ok ? <><button>Retry the request</button></> : <p>Hint</p>}').root, 'pc-if')
    expect(node.attrs.when).toEqual(['ok'])
    expect(node.children[0].tag).toBe('')
    expect(tagsOf(node).slice(1)).toEqual(['pc-else', 'p'])
  })

  test('JSX in an attribute value stays inside its tag', () => {
    const { root } = treeOf(`{isOpen ? <button icon={<i>x</i>}>Go</button> : null}`)
    expect(find(root, 'i')).toBeUndefined()
    expect(find(root, 'button').attrs.icon).toBe('{<i>x</i>}')
  })

  test('a ? and : inside a string arm do not split the expression', () => {
    const { root, exprs } = treeOf('<p>{isOpen ? <button>Close</button> : "Really? Yes: <no>"}</p>')
    expect(find(root, 'pc-if').attrs.when).toEqual(['isOpen'])
    expect(exprs).toContain('"Really? Yes: <no>"')
  })

  test('a ? and : inside JSX text do not split the expression', () => {
    const node = find(treeOf("{ok ? <p>Really? Don't stop</p> : <b>No</b>}").root, 'pc-if')
    expect(node.attrs.when).toEqual(['ok'])
    expect(tagsOf(node)).toEqual(['p', 'pc-else', 'b'])
  })

  test('a plain string containing < is not treated as markup', () => {
    const { exprs } = treeOf('<p>{"Are you sure? <b>"}</p>')
    expect(exprs).toContain('"Are you sure? <b>"')
  })

  test('.map lists keep their elements', () => {
    const { root } = treeOf('<ul>{items.map(item => <li key={item}>{item}</li>)}</ul>')
    expect(find(root, 'li')).toBeDefined()
  })

  test('a TypeScript cast in the condition is kept as the condition text', () => {
    const node = find(treeOf('{(items as string[]).length > 0 && <button>Clear all of them</button>}').root, 'pc-if')
    expect(node.attrs.when).toEqual(['(items as string[]).length > 0'])
  })

  test('a 1,500-line TSX file parses in a few milliseconds', () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `      <p>line ${i} {isOpen ? <b>a</b> : <i>b</i>}</p>`).join('\n')
    const src = `export default function Page({ isOpen }: any) {\n  return (\n    <main>\n${lines}\n    </main>\n  )\n}\n`
    const t0 = performance.now()
    readTemplate('Page.tsx', src)
    expect(performance.now() - t0).toBeLessThan(250)
  })
})
