// pricecheck/lib/config.mjs - the repo's .pricecheck.json. Every key is optional; a bad value fails loudly.
import fs from 'node:fs'
import path from 'node:path'
import { priceList } from './model.mjs'

const KEYS = ['pages', 'ignore', 'alias', 'weights', 'productOrigins', 'budgets']

const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string')
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export function loadConfig(root) {
  const file = path.join(root, '.pricecheck.json')
  let raw = {}
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`pricecheck: ${file} is not valid JSON (${e.message})`)
    }
    if (!isObj(raw)) throw new Error(`pricecheck: ${file} must be a JSON object`)
  }
  for (const k of Object.keys(raw)) {
    if (!KEYS.includes(k)) throw new Error(`pricecheck: unknown key "${k}" in ${file} (known: ${KEYS.join(', ')})`)
  }
  const cfg = {
    pages: raw.pages ?? null,
    ignore: raw.ignore ?? [],
    alias: raw.alias ?? {},
    weights: raw.weights ?? {},
    productOrigins: raw.productOrigins ?? [],
    budgets: raw.budgets ?? {},
  }
  const bad = (what) => new Error(`pricecheck: ${what} in ${file}`)
  if (cfg.pages !== null && !isStrArr(cfg.pages)) throw bad('"pages" must be an array of glob strings')
  if (!isStrArr(cfg.ignore)) throw bad('"ignore" must be an array of glob strings')
  if (!isStrArr(cfg.productOrigins)) throw bad('"productOrigins" must be an array of origins')
  if (!isObj(cfg.alias) || !Object.values(cfg.alias).every((v) => typeof v === 'string')) throw bad('"alias" must map prefixes to folders')
  if (!isObj(cfg.budgets) || !Object.values(cfg.budgets).every((v) => typeof v === 'number' && v >= 0)) {
    throw bad('"budgets" must map globs to non-negative numbers')
  }
  return { ...cfg, list: priceList(cfg.weights) }
}
