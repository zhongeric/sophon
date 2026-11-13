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

/** One PAX record: "<length> <key>=<value>\n", where the length counts its own digits too. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  const size = new TextEncoder().encode(body).length
  let length = size + String(size).length
  if (String(length).length !== String(size).length) length = size + String(length).length
  return `${length}${body}`
}

/** A tar archive of the entries, with PAX headers for long paths and link targets. GNU tar and busybox tar read it. */
export function tar(entries: TarEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const header = (name: string, type: string, size: number, mode: number, target: string) => {
    const bytes = new Uint8Array(block)
    const put = (text: string, start: number, length: number) => bytes.set(encoder.encode(text).subarray(0, length), start)
    const number = (value: number, start: number, length: number) => put(`${value.toString(8).padStart(length - 1, '0')}\0`, start, length)
    put(name, 0, 100)
    number(mode & 0o7777, 100, 8)
    number(0, 108, 8)
    number(0, 116, 8)
    number(size, 124, 12)
    number(0, 136, 12)
    bytes.fill(0x20, 148, 156)
    put(type, 156, 1)
    put(target, 157, 100)
    put('ustar\0', 257, 6)
    put('00', 263, 2)
    put(`${bytes.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8)
    return bytes
  }
  const push = (data: Uint8Array) => {
    chunks.push(data)
    const padding = (block - (data.length % block)) % block
    if (padding) chunks.push(new Uint8Array(padding))
  }
  for (const entry of entries) {
    const long = encoder.encode(entry.path).length > 99 || encoder.encode(entry.target).length > 99
    if (long) {
      const records = encoder.encode(paxRecord('path', entry.path) + (entry.target ? paxRecord('linkpath', entry.target) : ''))
      chunks.push(header('PaxHeader', 'x', records.length, 0o644, ''))
      push(records)
    }
    const type = entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0'
    const data = entry.type === 'file' ? entry.data : new Uint8Array()
    chunks.push(header(entry.path.slice(0, 99), type, data.length, entry.mode, entry.target.slice(0, 99)))
    if (data.length) push(data)
  }
  chunks.push(new Uint8Array(block * 2))
  const archive = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.length
  }
  return archive
}
