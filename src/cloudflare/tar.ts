export type TarEntry = { path: string; type: 'file' | 'directory' | 'symlink'; mode: number; data: Uint8Array; target: string }

const block = 512

export async function gunzip(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>)).arrayBuffer())
}

const field = (bytes: Uint8Array, start: number, length: number) => {
  const slice = bytes.subarray(start, start + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end))
}
const octal = (bytes: Uint8Array, start: number, length: number) => parseInt(field(bytes, start, length).trim() || '0', 8)

/** Reads the PAX records of an extended header: "<length> <key>=<value>\n", where the length counts bytes. */
function pax(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {}
  const decoder = new TextDecoder()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    const length = Number(decoder.decode(data.subarray(offset, space)))
    if (!length || space === -1) break
    const record = data.subarray(space + 1, offset + length - 1)
    const equals = record.indexOf(0x3d)
    records[decoder.decode(record.subarray(0, equals))] = decoder.decode(record.subarray(equals + 1))
    offset += length
  }
  return records
}

/** The entries of a tar archive, with the first `strip` path components removed, as GitHub's tarballs need. */
export function untar(bytes: Uint8Array, strip: number): TarEntry[] {
  const entries: TarEntry[] = []
  let next: Record<string, string> = {}
  for (let offset = 0; offset + block <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + block)
    if (header.every((byte) => byte === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156]!)
    const data = bytes.subarray(offset + block, offset + block + size)
    offset += block + Math.ceil(size / block) * block
    if (type === 'x') {
      next = { ...next, ...pax(data) }
      continue
    }
    if (type === 'L') {
      next = { ...next, path: field(data, 0, data.length) }
      continue
    }
    if (type === 'g' || type === 'K') continue
    const prefix = field(header, 345, 155)
    const name = next.path ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    const target = next.linkpath ?? field(header, 157, 100)
    next = {}
    const path = name.split('/').filter(Boolean).slice(strip).join('/')
    if (!path) continue
    const kind = type === '5' ? 'directory' : type === '2' ? 'symlink' : type === '0' || type === '\0' ? 'file' : null
    if (kind) entries.push({ path, type: kind, mode: octal(header, 100, 8), data: kind === 'file' ? data : new Uint8Array(), target })
  }
  return entries
}
