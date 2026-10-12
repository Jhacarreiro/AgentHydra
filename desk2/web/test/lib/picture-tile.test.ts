import { describe, expect, it } from 'bun:test'
import { clampAspect, picturePosition, pictureTile } from '../../src/lib/picture-tile'

describe('pictureTile', () => {
  it('clamps a wide strip to three times the height, anchored left', () => {
    expect(pictureTile(2400, 140, 120)).toEqual({ width: 360, height: 120, objectPosition: 'left center' })
  })

  it('clamps a tall page to 0.6 of the height, anchored at its top', () => {
    expect(pictureTile(400, 3000, 120)).toEqual({ width: 72, height: 120, objectPosition: 'center top' })
  })

  it('keeps a square as a square', () => {
    expect(pictureTile(500, 500, 120)).toEqual({ width: 120, height: 120, objectPosition: 'center' })
  })

  it('gives a normal photo its own ratio, centred', () => {
    expect(pictureTile(1600, 1000, 120)).toEqual({ width: 192, height: 120, objectPosition: 'center' })
  })

  it('gives a zero or unknown size a square, centred', () => {
    for (const [w, h] of [[0, 0], [0, 800], [640, 0], [Number.NaN, 480]] as const) {
      expect(pictureTile(w, h, 120)).toEqual({ width: 120, height: 120, objectPosition: 'center' })
    }
  })
})

describe('picture aspect clamp', () => {
  it('passes an aspect inside the clamp and pins one outside it', () => {
    expect(clampAspect(1.5)).toBe(1.5)
    expect(clampAspect(0.1)).toBe(0.6)
    expect(clampAspect(17)).toBe(3)
  })

  it('anchors a picture by which side it overflows', () => {
    expect(picturePosition(0.2)).toBe('center top')
    expect(picturePosition(9)).toBe('left center')
    expect(picturePosition(1)).toBe('center')
  })
})
