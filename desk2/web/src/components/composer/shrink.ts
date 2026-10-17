// Every picture the window attaches (a paste, a drop, a file picked, a question's answer) is shrunk here to
// MAX_PICTURE_SIDE on its longest side before it is checked and sent. Claude's API refuses a request holding more than
// 20 pictures when any one is bigger, and Claude Code then fails that chat on every later turn: one big screenshot broke
// a long chat for good. A picture within the side goes byte for byte. logic.ts works out the size and the type
// (shrinkPlan); this draws, with the browser's own decoder and a canvas.

import { SHRINK_QUALITY, shrinkFallback, shrinkPlan, shrunkName } from './logic'

export interface ShrunkPicture {
  file: File
  /** The size it was drawn from, when it was shrunk (ImageRef.originalWidth and originalHeight). */
  originalWidth?: number
  originalHeight?: number
}

/** The picture to attach: the file itself when it is within the side or cannot be drawn, else its shrunk copy. */
export async function shrinkPicture(file: File): Promise<ShrunkPicture> {
  if (typeof createImageBitmap !== 'function') return { file }
  let bitmap: ImageBitmap
  try {
    // A GIF's first frame; a JPEG turned as its EXIF says, as it is shown.
    bitmap = await createImageBitmap(file)
  } catch {
    return { file } // not a picture the browser can read: checked as it is
  }
  try {
    const plan = shrinkPlan({ width: bitmap.width, height: bitmap.height, type: file.type })
    if (!plan) return { file }
    let blob = await encode(bitmap, plan.width, plan.height, plan.type)
    const again = shrinkFallback(blob.type, blob.size)
    if (again) blob = await encode(bitmap, plan.width, plan.height, again)
    const shrunk = new File([blob], shrunkName(file.name, file.type, blob.type), { type: blob.type })
    return { file: shrunk, originalWidth: bitmap.width, originalHeight: bitmap.height }
  } catch {
    return { file } // the canvas failed: the 5 MB check decides as before
  } finally {
    bitmap.close()
  }
}

async function encode(bitmap: ImageBitmap, width: number, height: number, type: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const g = canvas.getContext('2d')
  if (!g) throw new Error('no 2d canvas')
  // A JPEG has no transparency: what was clear shows white, not black.
  if (type === 'image/jpeg') {
    g.fillStyle = '#fff'
    g.fillRect(0, 0, width, height)
  }
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, 0, 0, width, height)
  return canvas.convertToBlob({ type, quality: SHRINK_QUALITY })
}

/** A file's bytes as a data: URL (the thumbnail, and ImageRef.dataBase64 after the comma). */
export function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('the picture could not be read'))
    reader.readAsDataURL(blob)
  })
}
