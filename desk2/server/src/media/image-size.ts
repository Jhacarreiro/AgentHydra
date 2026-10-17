// A picture's width and height read from its file header (PNG, JPEG, GIF, WebP), without decoding it: the server has
// no image library, and these few bytes are all a size needs. A JPEG's is the size as stored, before any EXIF rotation,
// which may swap the two but never changes the longer side.

export interface ImageSize {
  width: number
  height: number
}

/** The picture's size; null when the bytes are not a PNG, JPEG, GIF or WebP, or their header is cut short or broken. */
export function imageSize(b: Uint8Array): ImageSize | null {
  const size = pngSize(b) ?? gifSize(b) ?? webpSize(b) ?? jpegSize(b)
  return size && size.width > 0 && size.height > 0 ? size : null
}

const be16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!
const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
const le16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const le24 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

/** The signature, then the IHDR chunk first: its width and height at 16 and 20. */
function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || b[0] !== 0x89 || ascii(b, 1, 3) !== 'PNG' || ascii(b, 12, 4) !== 'IHDR') return null
  return { width: be32(b, 16), height: be32(b, 20) }
}

/** The logical screen's size, right after GIF87a or GIF89a. */
function gifSize(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || ascii(b, 0, 4) !== 'GIF8') return null
  return { width: le16(b, 6), height: le16(b, 8) }
}

/** RIFF....WEBP, then the first chunk: VP8 (lossy), VP8L (lossless) or VP8X (extended, the canvas size). */
function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ') {
    // The key frame's start code, then two 14-bit sizes (the top two bits scale, ignored here).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 }
  return null
}

/** The frame header (SOF0-SOF15 but DHT, JPG and DAC), found by walking the segments after SOI. */
function jpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let at = 2
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]!
    // Fill bytes before a marker, and the markers that carry no length.
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // the end, or the scan, before any frame header
    const length = be16(b, at + 2)
    if (length < 2) return null
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) return null
      return { width: be16(b, at + 7), height: be16(b, at + 5) }
    }
    at += 2 + length
  }
  return null
}
