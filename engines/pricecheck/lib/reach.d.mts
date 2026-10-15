import type { Item } from './model.mjs'

export interface ReachConfig {
  own?: string[]
  off?: string[]
  kit?: string[]
  offFactor?: number
}

export type Reach = 'own' | 'off'

export function featureWords(file: string): Set<string>
export function reachRules(
  cfg?: Omit<ReachConfig, 'offFactor'>,
  rendered?: Map<string, number>,
  pages?: number,
): { reachOf(item: Item & { via?: string }, page: string): Reach; isKit(file: string): boolean }
