import { validateConnector, validateEnvironment } from '@vvpost/schemas'
import type { PostmanImportResult } from './postman'

export { SECRETS_FILE } from '../workspace/vault'

export interface PlannedFile {
  /** Caminho relativo ao workspace, com "/". */
  path: string
  content: string
}

/**
 * Arquivos versionáveis que a conversão gera, nos caminhos padrão: conectores e ambientes,
 * nunca segredos. Servem para apontar onde está um problema de schema; a gravação no
 * projeto passa pela camada de escrita (src/main/project).
 */
export function planFiles(result: Pick<PostmanImportResult, 'connectors' | 'environments'>): PlannedFile[] {
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
  return [
    ...result.connectors.map((c) => ({ path: `connectors/${c.id}.connector.vvpost.json`, content: json(c) })),
    ...result.environments.map((e) => ({
      path: `environments/${e.id.replace(/^env\./, '')}.env.json`,
      content: json(e)
    }))
  ]
}

/** Valida cada documento contra os schemas v1. Um problema aqui é bug do importador e bloqueia a gravação. */
export function validateImport(result: Pick<PostmanImportResult, 'connectors' | 'environments'>): { file: string; message: string }[] {
  const files = planFiles(result)
  const docs = [...result.connectors, ...result.environments]
  return docs.flatMap((doc, i) => {
    const r = i < result.connectors.length ? validateConnector(doc) : validateEnvironment(doc)
    return r.ok
      ? []
      : r.issues.map((issue) => ({ file: files[i]!.path, message: `${issue.path || '/'}: ${issue.message}` }))
  })
}
