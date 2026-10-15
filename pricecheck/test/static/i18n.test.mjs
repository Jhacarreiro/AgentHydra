import { describe as group, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeI18n } from '../../lib/static/i18n.mjs'

function repo(tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-i18n-'))
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

const call = (i18n, expr, from) => i18n.text(expr, from)

group('json catalogs', () => {
  test('a root en.json keys by its dotted path, as before', () => {
    const i18n = makeI18n(repo({ 'locales/en.json': '{ "signin": { "help": "Need a hand? Read the guide." } }' }))
    expect(call(i18n, "$t('signin.help')")).toBe('Need a hand? Read the guide.')
  })

  test('an en folder under a nested messages folder namespaces its files by path', () => {
    const i18n = makeI18n(repo({
      'services/app/web/src/i18n/messages/en-US/common.json': '{ "hello": "Hello there" }',
      'services/app/web/src/i18n/messages/fr-FR/common.json': '{ "hello": "Bonjour" }',
    }))
    expect(call(i18n, "t('common.hello')")).toBe('Hello there')
    expect(i18n.keyText('common.hello')).toBe('Hello there')
  })

  test('a non-English catalog is never read', () => {
    const i18n = makeI18n(repo({ 'locales/fr/common.json': '{ "hello": "Bonjour" }' }))
    expect(call(i18n, "t('common.hello')")).toBe(null)
  })

  test('a test file under a catalog folder is skipped', () => {
    const i18n = makeI18n(repo({ 'locales/en/common.test.json': '{ "hello": "Hello there" }' }))
    expect(call(i18n, "t('common.hello')")).toBe(null)
  })
})

group('module catalogs', () => {
  const module = [
    '// A catalog for the host screens.',
    'export const hostMessages = {',
    '  backendUnavailableBanner: "The backend is down for {count} hosts", // trailing comment',
    "  'quoted-key': `Back tick text`,",
    '  nested: { k2: \'Nested words here\', },',
    '  "dotted": "Says \\"hi\\" twice",',
    '  withTemplate: `Hello ${name}`,',
    '  spread: { ...others },',
    '} as const',
    '',
  ].join('\n')

  test('a TS module keys its strings by the file path and by the bare leaf key', () => {
    const i18n = makeI18n(repo({ 'packages/pkg/src/i18n/messages/en-US/workspace/host.ts': module }))
    expect(call(i18n, "t('workspace.host.nested.k2')")).toBe('Nested words here')
    expect(call(i18n, "t('nested.k2')")).toBe('Nested words here')
    expect(call(i18n, "t('quoted-key')")).toBe('Back tick text')
    expect(call(i18n, "t('dotted')")).toBe('Says "hi" twice')
  })

  test('a comment, a template with an interpolation, and a spread are not text', () => {
    const i18n = makeI18n(repo({ 'packages/pkg/src/i18n/messages/en-US/workspace/host.ts': module }))
    expect(call(i18n, "t('withTemplate')")).toBe(null)
    expect(call(i18n, "t('trailing comment')")).toBe(null)
    expect(call(i18n, "t('others')")).toBe(null)
  })

  test('a TS module under a root en folder without a namespace file keys by its leaves', () => {
    const i18n = makeI18n(repo({ 'src/locales/en.ts': 'export default { greeting: "Good morning" }' }))
    expect(call(i18n, "t('greeting')")).toBe('Good morning')
  })
})

group('calls and scoped lookup', () => {
  test('a scoped translator resolves its bare key by the suffix of the full path', () => {
    const i18n = makeI18n(repo({
      'packages/pkg/src/i18n/messages/en-US/workspace/host.ts': 'export const m = { backendUnavailableBanner: "The backend is down" }',
      'packages/pkg/src/views/Host.vue': "<script setup>const tr = useScopedI18n('workspace.host')</script>",
    }))
    expect(call(i18n, 'tr("backendUnavailableBanner")')).toBe('The backend is down')
  })

  test('an exact dotted key wins over a suffix match', () => {
    const i18n = makeI18n(repo({
      'locales/en.json': '{ "title": "Root title", "a": { "title": "Other title" } }',
      'locales/en/b.json': '{ "title": "B title" }',
    }))
    expect(call(i18n, "t('title')")).toBe('Root title')
    expect(call(i18n, "t('b.title')")).toBe('B title')
    expect(call(i18n, "t('a.title')")).toBe('Other title')
  })

  test('the translator names in the short list and any ident ending in T or Tr are calls', () => {
    const i18n = makeI18n(repo({ 'locales/en.json': '{ "k": "Some words" }' }))
    for (const expr of ["t('k')", "tc('k')", "tr('k')", "$t('k')", "translate('k')", "scopedT('k')", "pageTr('k')", "i18n.t('k')"]) {
      expect(call(i18n, expr)).toBe('Some words')
    }
  })

  test('an expression whose only key is missing is unresolved', () => {
    const i18n = makeI18n(repo({ 'locales/en.json': '{ "k": "Some words" }' }))
    expect(call(i18n, "t('missing')")).toBe(null)
    expect(call(i18n, "t('k') + t('missing')")).toBe(null)
  })

  test('a call with a template literal key is not a key', () => {
    const i18n = makeI18n(repo({ 'locales/en.json': '{ "k": "Some words" }' }))
    expect(call(i18n, 't(`k${n}`)')).toBe(null)
  })
})

group('closest catalog', () => {
  const tree = {
    'services/a/web/src/i18n/messages/en-US/page.ts': 'export const m = { title: "Alpha title words" }',
    'packages/b/src/i18n/messages/en-US/page.ts': 'export const m = { title: "Beta" }',
  }

  test('a call from a file next to one catalog takes that catalog', () => {
    const i18n = makeI18n(repo(tree))
    expect(call(i18n, 'tr("title")', 'services/a/web/src/views/Home.vue')).toBe('Alpha title words')
    expect(call(i18n, 'tr("title")', 'packages/b/src/Card.vue')).toBe('Beta')
  })

  test('without a calling file the first catalog in path order is taken', () => {
    expect(call(makeI18n(repo(tree)), 'tr("title")')).toBe('Beta')
  })
})

group('plurals', () => {
  test('a plural message counts its longest form, with each placeholder as one word', () => {
    const i18n = makeI18n(repo({ 'locales/en.json': '{ "eventCount": "one event | {n} events happened today" }' }))
    expect(call(i18n, 'trPlural("eventCount", n)')).toBe('{n} events happened today')
  })

  test('a placeholder touching other text is still its own word', () => {
    const i18n = makeI18n(repo({ 'locales/en.json': '{ "k": "Sent to {name}{tail} now" }' }))
    const text = call(i18n, "t('k')")
    expect(text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length).toBe(5)
  })
})

group('speed', () => {
  test('loading 300 catalogs of 100 keys among 6000 files stays under 300 ms', () => {
    const tree = {}
    for (let f = 0; f < 300; f++) {
      const keys = Array.from({ length: 100 }, (_, k) => `  "k${k}": "Text number ${k} of module ${f}"`).join(',\n')
      tree[`packages/p${f % 20}/src/i18n/messages/en-US/mod${f}.ts`] = `export const m = {\n${keys},\n}\n`
    }
    for (let f = 0; f < 5700; f++) tree[`packages/p${f % 20}/src/views/V${f}.vue`] = '<template><p>Hi</p></template>\n'
    const dir = repo(tree)
    const start = performance.now()
    const i18n = makeI18n(dir)
    const ms = performance.now() - start
    expect(i18n.keyText('k5')).not.toBe(null)
    expect(ms).toBeLessThan(300)
  }, 60000)
})
