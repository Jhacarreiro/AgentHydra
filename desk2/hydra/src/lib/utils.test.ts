import { expect, test } from 'bun:test'
import { cn } from './utils'

// Contract: cn() keeps a text colour beside a step of the app's own type scale, and still lets a later size replace an
// earlier one. Regression: 2026-10-13, tailwind-merge read text-ui as a colour, so
// cn('text-muted-foreground', 'text-ui') returned 'text-ui' and the text lost its colour.
test('cn keeps the colour beside a type-scale size, and a later size wins', () => {
  for (const size of ['text-3xs', 'text-2xs', 'text-ui']) {
    expect(cn('text-muted-foreground', size)).toBe(`text-muted-foreground ${size}`)
    expect(cn('text-sm', size)).toBe(size)
  }
})
