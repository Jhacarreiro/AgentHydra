import { expect, test } from 'bun:test'
import { cn } from '../../src/lib/utils'

// Contract: cn() keeps a text colour beside a step of style.css's type scale, and still lets a later size replace an
// earlier one. Regression: 2026-10-13, tailwind-merge read text-ui, text-ui-sm and text-ui-lg as colours, so
// cn('text-text-muted', 'text-ui') returned 'text-ui' and the text lost its colour.
test('cn keeps the colour beside a type-scale size, and a later size wins', () => {
  for (const size of ['text-3xs', 'text-2xs', 'text-ui-sm', 'text-ui', 'text-ui-lg']) {
    expect(cn('text-text-muted', size)).toBe(`text-text-muted ${size}`)
    expect(cn('text-sm', size)).toBe(size)
  }
})
