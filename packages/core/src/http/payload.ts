import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { RequestPayload } from '../types'

/** Arquivo maior que isso não vai no corpo: o dispatcher lê tudo em memória. */
export const PAYLOAD_FILE_LIMIT = 100 * 1024 * 1024

export class PayloadError extends Error {}

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav'
}

/** Content-type pela extensão do arquivo (application/octet-stream quando não conhece). */
export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

async function readPayloadFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new PayloadError(`o arquivo do corpo precisa de um caminho absoluto: ${path}`)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new PayloadError(`arquivo do corpo não encontrado: ${path}`)
  if (info.size > PAYLOAD_FILE_LIMIT) throw new PayloadError(`arquivo do corpo maior que ${PAYLOAD_FILE_LIMIT / 1024 / 1024} MB: ${path}`)
  return readFile(path)
}

/** RFC 7578: nomes com aspas e quebras escapados. */
const quote = (s: string) => s.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')

/**
 * Serializa o corpo estruturado (spec, fase 12): form-urlencoded, multipart/form-data com
 * arquivos e binário. Os caminhos de arquivo já chegam absolutos e com {{VAR}} resolvido
 * (a auth headless resolve os relativos ao workspace).
 */
export async function encodePayload(payload: RequestPayload): Promise<{ body: Buffer; contentType: string }> {
  switch (payload.mode) {
    case 'urlencoded': {
      const params = new URLSearchParams(payload.fields.filter((f) => f.name).map((f): [string, string] => [f.name, f.value ?? '']))
      return { body: Buffer.from(params.toString()), contentType: 'application/x-www-form-urlencoded' }
    }
    case 'binary': {
      const body = await readPayloadFile(payload.file)
      return { body, contentType: payload.contentType || mimeOf(payload.file) }
    }
    case 'multipart': {
      const boundary = `----VVPostFormBoundary${randomBytes(12).toString('hex')}`
      const parts: Buffer[] = []
      for (const field of payload.fields) {
        if (!field.name) continue
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${quote(field.name)}"`
        let data: Buffer
        if (field.file !== undefined) {
          data = await readPayloadFile(field.file)
          head += `; filename="${quote(field.filename || basename(field.file))}"\r\nContent-Type: ${field.contentType || mimeOf(field.file)}`
        } else {
          data = Buffer.from(field.value ?? '')
          if (field.contentType) head += `\r\nContent-Type: ${field.contentType}`
        }
        parts.push(Buffer.from(`${head}\r\n\r\n`), data, Buffer.from('\r\n'))
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`))
      return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
    }
  }
}

/** Resumo em texto do corpo estruturado, para o histórico (os bytes dos arquivos não entram). */
export function describePayload(payload: RequestPayload): string {
  switch (payload.mode) {
    case 'urlencoded':
      return new URLSearchParams(payload.fields.filter((f) => f.name).map((f): [string, string] => [f.name, f.value ?? ''])).toString()
    case 'binary':
      return `[arquivo ${payload.file}]`
    case 'multipart':
      return payload.fields
        .filter((f) => f.name)
        .map((f) => (f.file !== undefined ? `${f.name}=@${f.file}` : `${f.name}=${f.value ?? ''}`))
        .join('\n')
  }
}
