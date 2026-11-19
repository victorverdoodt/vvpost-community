import { readFile, rename, writeFile } from 'node:fs/promises'
import { SchemaId, validatePublishConfig, type PublishConfig, type PublishTarget, type PublishedItem } from '@vvpost/schemas'
import { DocsError } from '../build'
import { workspaceWritePath } from '../compose'
import type { PublishResult } from './types'

/** Destinos do "Enviar para…", na raiz do workspace (schema publish.json). Vai para o Git. */
export const PUBLISH_CONFIG_FILE = 'vvpost.publish.json'

export interface LoadedPublishConfig {
  /** null quando o arquivo não existe. */
  config: PublishConfig | null
  issues: { file: string; message: string }[]
  /** Texto lido, para gravar o resultado só se ninguém mudou o arquivo no meio. */
  text: string | null
}

export async function loadPublishConfig(dir: string): Promise<LoadedPublishConfig> {
  let text: string
  try {
    text = await readFile(await workspaceWritePath(dir, PUBLISH_CONFIG_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: null, issues: [], text: null }
    return { config: null, issues: [{ file: PUBLISH_CONFIG_FILE, message: (err as Error).message }], text: null }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { config: null, issues: [{ file: PUBLISH_CONFIG_FILE, message: `JSON inválido (${(err as Error).message})` }], text }
  }
  const result = validatePublishConfig(json)
  if (!result.ok) return { config: null, issues: result.issues.map((i) => ({ file: PUBLISH_CONFIG_FILE, message: `${i.path || '/'}: ${i.message}` })), text }
  return { config: result.value, issues: [], text }
}

/** Modelo para o primeiro destino: o documento do projeto, as páginas de docs/ e os conectores. */
export function starterPublishConfig(provider: string, destination: string): PublishConfig {
  return {
    $schema: SchemaId.Publish,
    targets: [
      {
        id: provider,
        provider,
        destination,
        structure: [
          {
            page: 'Documentação do projeto',
            source: 'document',
            children: [
              { folder: 'Guias', children: [{ pages: 'docs/**/*.md' }] },
              { folder: 'Referência da API', children: [{ each: 'connector' }] }
            ]
          }
        ]
      }
    ]
  }
}

/**
 * Grava no "published" do destino o que a publicação deixou no destino, para a próxima achar as
 * mesmas páginas. Recusa se o arquivo mudou desde a leitura (outra pessoa, o Git): a publicação
 * já aconteceu, então a mensagem diz o que falta.
 */
export async function recordPublished(dir: string, previous: string | null, targetId: string, result: PublishResult): Promise<void> {
  const path = await workspaceWritePath(dir, PUBLISH_CONFIG_FILE)
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null || text !== previous) {
    throw new DocsError(`${PUBLISH_CONFIG_FILE} mudou durante a publicação; as páginas foram publicadas, mas os ids não foram gravados. Publique de novo para registrá-los.`)
  }
  const doc = JSON.parse(text) as PublishConfig
  const target = doc.targets.find((t) => t.id === targetId)
  if (!target) throw new DocsError(`destino "${targetId}" não existe mais em ${PUBLISH_CONFIG_FILE}`)
  target.published = applyResult(target, result)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export function applyResult(target: PublishTarget, result: PublishResult): Record<string, PublishedItem> {
  const published: Record<string, PublishedItem> = { ...target.published }
  for (const item of result.items) {
    if (item.outcome === 'archived') delete published[item.key]
    else if ((item.outcome === 'created' || item.outcome === 'updated' || item.outcome === 'unchanged') && item.id) {
      published[item.key] = {
        id: item.id,
        kind: item.kind,
        ...(item.version !== undefined && { version: item.version }),
        ...(item.hash && { hash: item.hash }),
        ...(item.url && { url: item.url })
      }
    }
  }
  return Object.fromEntries(Object.entries(published).sort(([a], [b]) => a.localeCompare(b)))
}
