// Picture tiles: the height is fixed, the width follows the picture's aspect ratio within a clamp. Past the clamp
// the picture is cropped to fill the tile, anchored where its content is.

/** The widest and narrowest a tile's width/height ratio may be. */
export const PICTURE_TILE_ASPECT = { min: 0.6, max: 3 } as const

export function clampAspect(aspect: number): number {
  return Math.min(PICTURE_TILE_ASPECT.max, Math.max(PICTURE_TILE_ASPECT.min, aspect))
}

/** Where a picture is anchored in its tile: a tall one shows its top (a page), a wide one its left, else centred. */
export function picturePosition(aspect: number): string {
  if (aspect < PICTURE_TILE_ASPECT.min) return 'center top'
  if (aspect > PICTURE_TILE_ASPECT.max) return 'left center'
  return 'center'
}

export interface PictureTile {
  width: number
  height: number
  objectPosition: string
}

/** A tile `height` px high for a picture of this natural size; a size not known yet gives a square. */
export function pictureTile(naturalWidth: number, naturalHeight: number, height: number): PictureTile {
  if (!(naturalWidth > 0 && naturalHeight > 0)) return { width: height, height, objectPosition: 'center' }
  const aspect = naturalWidth / naturalHeight
  return { width: Math.round(height * clampAspect(aspect)), height, objectPosition: picturePosition(aspect) }
}
