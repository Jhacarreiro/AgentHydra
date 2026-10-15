/** Minimal "stored" (uncompressed) zip writer, so export needs no dependency. */
const crc32 = (b: Uint8Array): number => Bun.hash.crc32(b) as number

export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true)
    lh.setUint16(4, 20, true)
    lh.setUint16(6, 0x0800, true) // UTF-8 names
    lh.setUint32(14, crc, true)
    lh.setUint32(18, f.data.length, true)
    lh.setUint32(22, f.data.length, true)
    lh.setUint16(26, name.length, true)
    const head = new Uint8Array(lh.buffer)
    parts.push(head, name, f.data)
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true)
    ch.setUint16(4, 20, true)
    ch.setUint16(6, 20, true)
    ch.setUint16(8, 0x0800, true)
    ch.setUint32(16, crc, true)
    ch.setUint32(20, f.data.length, true)
    ch.setUint32(24, f.data.length, true)
    ch.setUint16(28, name.length, true)
    ch.setUint32(42, offset, true)
    central.push(new Uint8Array(ch.buffer), name)
    offset += head.length + name.length + f.data.length
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, cdSize, true)
  end.setUint32(16, offset, true)
  return new Uint8Array(Buffer.concat([...parts, ...central, new Uint8Array(end.buffer)]))
}
