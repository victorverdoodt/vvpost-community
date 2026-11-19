import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { SharedConnector } from '@vvpost/core/connectors/shared'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Lê um arquivo de --catalog. Aceita a resposta de GET /api/v1/catalog do Control
 * Plane ({ connectors: [{ scope, version, doc }] }), uma lista de conectores ou um
 * conector só. A validação de cada documento é a do loadWorkspace: um conector
 * inválido vira issue e o resto segue, como no app.
 */
export async function readCatalogFile(path: string): Promise<SharedConnector[]> {
  let doc: unknown
  try {
    doc = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    throw new Error(`--catalog ${path}: ${err instanceof SyntaxError ? `JSON inválido (${err.message})` : (err as Error).message}`)
  }
  const name = basename(path)
  if (Array.isArray(doc)) return doc.map((d) => ({ source: name, doc: d }))
  if (isRecord(doc) && Array.isArray(doc['connectors'])) {
    const origin = typeof doc['source'] === 'string' && doc['source'] ? doc['source'] : name
    return doc['connectors'].map((entry) => {
      // Entrada do snapshot ({ scope, version, doc }) ou o documento direto.
      if (isRecord(entry) && isRecord(entry['doc'])) {
        const at = typeof entry['scope'] === 'string' ? `@${entry['scope']}${typeof entry['version'] === 'number' ? `:${entry['version']}` : ''}` : ''
        return { source: `${origin}${at}`, doc: entry['doc'] }
      }
      return { source: origin, doc: entry }
    })
  }
  if (isRecord(doc) && typeof doc['id'] === 'string') return [{ source: name, doc }]
  throw new Error(`--catalog ${path}: use a resposta de /api/v1/catalog ({ "connectors": [...] }), uma lista de conectores ou um conector`)
}
