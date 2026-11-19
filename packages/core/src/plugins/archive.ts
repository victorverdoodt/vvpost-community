import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { crc32, deflateRawSync, gunzipSync, inflateRawSync } from 'node:zlib'

/**
 * Leitura e escrita dos pacotes de plugin: .zip (stored e deflate, sem zip64 nem
 * criptografia) e .tgz/.tar.gz/.tar (ustar, com nomes longos do pax e do GNU). Só arquivos
 * e pastas: links simbólicos, hard links e dispositivos recusam o pacote inteiro, assim
 * como caminhos absolutos, com ".." ou que saiam da pasta de destino.
 */

export class ArchiveError extends Error {}

export interface ArchiveLimits {
  maxFiles: number
  maxBytes: number
}

export interface ArchiveEntry {
  /** Caminho relativo com "/". */
  path: string
  data: Buffer
}

/** Caminho de uma entrada, normalizado, ou erro se ele tentar sair da pasta. */
export function safeEntryPath(name: string): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.includes('\0')) throw new ArchiveError(`caminho inválido no pacote: ${JSON.stringify(name)}`)
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new ArchiveError(`caminho absoluto no pacote: ${name}`)
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) throw new ArchiveError(`caminho com ".." no pacote: ${name}`)
  return parts.length ? parts.join('/') : null
}

function readZip(buf: Buffer, limits: ArchiveLimits): ArchiveEntry[] {
  // Fim do diretório central: nos últimos 64 KB + 22 bytes (o comentário tem até 64 KB).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ArchiveError('.zip sem o diretório central (arquivo cortado?)')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ArchiveError('.zip64 não é aceito')
  if (count > limits.maxFiles) throw new ArchiveError(`o pacote passa de ${limits.maxFiles} arquivos`)
  if (cdOffset + cdSize > eocd) throw new ArchiveError('.zip com o diretório central inválido')
  const entries: ArchiveEntry[] = []
  let total = 0
  let pos = cdOffset
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new ArchiveError('.zip com o diretório central inválido')
    const flags = buf.readUInt16LE(pos + 8)
    const method = buf.readUInt16LE(pos + 10)
    const crc = buf.readUInt32LE(pos + 16)
    const compressedSize = buf.readUInt32LE(pos + 20)
    const size = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const madeBy = buf.readUInt16LE(pos + 4) >> 8
    const external = buf.readUInt32LE(pos + 38)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    pos += 46 + nameLen + extraLen + commentLen
    if (flags & 1) throw new ArchiveError(`${name}: .zip com senha não é aceito`)
    // Atributos do Unix (madeBy 3): o tipo de arquivo está nos 16 bits altos.
    const mode = madeBy === 3 ? external >>> 16 : 0
    const type = mode & 0o170000
    const isDir = name.endsWith('/') || name.endsWith('\\') || (madeBy === 0 && (external & 0x10) !== 0)
    if (type === 0o120000) throw new ArchiveError(`${name}: links simbólicos não são aceitos no pacote`)
    if (type && type !== 0o100000 && type !== 0o040000) throw new ArchiveError(`${name}: só arquivos e pastas são aceitos no pacote`)
    const path = safeEntryPath(name)
    if (isDir || type === 0o040000 || path === null) continue
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ArchiveError(`${name}: cabeçalho local inválido`)
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (start + compressedSize > buf.length) throw new ArchiveError(`${name}: dados cortados`)
    total += size
    if (total > limits.maxBytes) throw new ArchiveError(`o pacote passa de ${limits.maxBytes / 1024 / 1024} MB descomprimido`)
    const raw = buf.subarray(start, start + compressedSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) })
      } catch (err) {
        throw new ArchiveError(`${name}: deflate inválido (${(err as Error).message})`)
      }
    } else throw new ArchiveError(`${name}: compressão ${method} não suportada (use deflate)`)
    if (data.length !== size || crc32(data) !== crc) throw new ArchiveError(`${name}: o conteúdo não confere com o CRC do .zip`)
    entries.push({ path, data })
  }
  return entries
}

function octal(buf: Buffer, start: number, length: number): number {
  const text = buf.toString('latin1', start, start + length).replace(/\0.*$/s, '').trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError('.tar com cabeçalho inválido')
  return parseInt(text, 8)
}

function readTar(buf: Buffer, limits: ArchiveLimits): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let total = 0
  let pos = 0
  let longName: string | null = null
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512)
    if (header.every((b) => b === 0)) break
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
    if (sum !== octal(header, 148, 8)) throw new ArchiveError('.tar com checksum inválido')
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156]!)
    const dataStart = pos + 512
    if (dataStart + size > buf.length) throw new ArchiveError('.tar cortado')
    const data = buf.subarray(dataStart, dataStart + size)
    pos = dataStart + Math.ceil(size / 512) * 512
    const cstr = (start: number, length: number) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '')
    const ustar = header.toString('latin1', 257, 262) === 'ustar'
    const name = longName ?? (ustar && cstr(345, 155) ? `${cstr(345, 155)}/${cstr(0, 100)}` : cstr(0, 100))
    if (type === 'x') {
      // Cabeçalho pax: "<tam> chave=valor\n"; só o path importa.
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      longName = match ? match[1]! : null
      continue
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    longName = null
    if (type === 'g') continue
    if (type === '5') continue
    if (type === '1' || type === '2') throw new ArchiveError(`${name}: links não são aceitos no pacote`)
    if (type !== '0' && type !== '\0' && type !== '7') throw new ArchiveError(`${name}: só arquivos e pastas são aceitos no pacote`)
    const path = safeEntryPath(name)
    if (path === null) continue
    if (entries.length >= limits.maxFiles) throw new ArchiveError(`o pacote passa de ${limits.maxFiles} arquivos`)
    total += size
    if (total > limits.maxBytes) throw new ArchiveError(`o pacote passa de ${limits.maxBytes / 1024 / 1024} MB descomprimido`)
    entries.push({ path, data: Buffer.from(data) })
  }
  return entries
}

/** As entradas de um .zip, .tgz ou .tar, pelo conteúdo (não pela extensão). */
export function readArchive(buf: Buffer, limits: ArchiveLimits): ArchiveEntry[] {
  let entries: ArchiveEntry[]
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) entries = readZip(buf, limits)
  else if (buf.length >= 4 && buf.readUInt32LE(0) === 0x06054b50) entries = []
  else if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    let tar: Buffer
    try {
      tar = gunzipSync(buf, { maxOutputLength: limits.maxBytes + limits.maxFiles * 1024 + 1024 })
    } catch (err) {
      throw new ArchiveError(`gzip inválido ou grande demais (${(err as Error).message})`)
    }
    entries = readTar(tar, limits)
  } else if (buf.length >= 512 && buf.toString('latin1', 257, 262) === 'ustar') entries = readTar(buf, limits)
  else throw new ArchiveError('o arquivo não é um .zip, .tgz nem .tar')
  const seen = new Set<string>()
  for (const e of entries) {
    const key = e.path.toLowerCase()
    if (seen.has(key)) throw new ArchiveError(`${e.path} aparece duas vezes no pacote`)
    seen.add(key)
  }
  return entries
}

/**
 * Extrai um pacote em `dest` (que deve estar vazia). Se tudo estiver dentro de uma pasta só
 * (como o "package/" do npm pack), devolve essa pasta como a raiz do plugin.
 */
export async function extractArchive(file: string, dest: string, limits: ArchiveLimits): Promise<string> {
  const info = await stat(file)
  if (info.size > limits.maxBytes) throw new ArchiveError(`o pacote passa de ${limits.maxBytes / 1024 / 1024} MB`)
  const entries = readArchive(await readFile(file), limits)
  if (!entries.length) throw new ArchiveError('o pacote está vazio')
  const root = resolve(dest)
  for (const e of entries) {
    const target = resolve(root, ...e.path.split('/'))
    if (!target.startsWith(root + sep)) throw new ArchiveError(`caminho fora da pasta: ${e.path}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, e.data, { flag: 'wx' })
  }
  const tops = new Set(entries.map((e) => e.path.split('/')[0]!))
  const [top] = tops
  return tops.size === 1 && top !== undefined && entries.every((e) => e.path.startsWith(`${top}/`)) ? join(root, top) : root
}

/** .zip com deflate, para o `vvpost plugin pack`. Datas fixas: o mesmo conteúdo dá os mesmos bytes. */
export function writeZip(files: ArchiveEntry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const name = Buffer.from(f.path, 'utf8')
    const deflated = deflateRawSync(f.data, { level: 9 })
    const stored = deflated.length >= f.data.length
    const body = stored ? f.data : deflated
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE((3 << 8) | 20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(stored ? 0 : 8, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(f.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
