import type { ValidationIssue } from './validate.ts'

/** Tipos de arquivo do workspace com schema próprio. O nome é o do arquivo em schemas/. */
export type SchemaKind = 'connector' | 'environment' | 'secrets-engine' | 'flow' | 'plugin' | 'bundle' | 'webhooks' | 'privacy' | 'docs' | 'publish' | 'project' | 'workspace-plugins'

/**
 * Versão major atual de cada schema (o "v1" da URL). Sobe só com mudança
 * incompatível: campo removido ou renomeado, significado novo, regra mais
 * restrita. Campo opcional novo não muda a versão.
 */
export const CURRENT_SCHEMA_VERSION: Readonly<Record<SchemaKind, number>> = {
  connector: 1,
  environment: 1,
  'secrets-engine': 1,
  flow: 1,
  plugin: 1,
  bundle: 1,
  webhooks: 1,
  privacy: 1,
  docs: 1,
  publish: 1,
  project: 1,
  'workspace-plugins': 1
}

/** URL canônica do schema, a que vai no campo "$schema" dos arquivos. */
export function schemaUrl(kind: SchemaKind, version = CURRENT_SCHEMA_VERSION[kind]): string {
  return `https://vvpost.dev/schemas/v${version}/${kind}.json`
}

/**
 * Migração de um documento da versão N para N+1, no índice N-1. Recebe uma cópia
 * e devolve o documento na versão seguinte, ainda sem validar.
 */
export type SchemaMigration = (doc: Record<string, unknown>) => Record<string, unknown>

/** Nenhum schema passou da v1 ainda: as listas ficam vazias até a primeira mudança incompatível. */
export const MIGRATIONS: Readonly<Record<SchemaKind, readonly SchemaMigration[]>> = {
  connector: [],
  environment: [],
  'secrets-engine': [],
  flow: [],
  plugin: [],
  bundle: [],
  webhooks: [],
  privacy: [],
  docs: [],
  publish: [],
  project: [],
  'workspace-plugins': []
}

const CANONICAL = /^https:\/\/vvpost\.dev\/schemas\/v(\d+)\/([a-z][a-z-]*)\.json$/

export type SchemaVersionCheck =
  | { ok: true; version: number; doc: unknown; migrated: boolean }
  | { ok: false; issues: ValidationIssue[] }

/**
 * Lê a versão do schema pelo "$schema" do documento e o leva até a versão atual:
 * - sem "$schema": versão atual (arquivos escritos à mão continuam válidos);
 * - URL canônica (https://vvpost.dev/schemas/vN/<tipo>.json): o tipo precisa ser
 *   o esperado, uma versão mais nova que a do app é recusada e uma mais antiga
 *   passa pelas migrações;
 * - outro texto terminado em /<tipo>.json (cópia local do schema, para o editor):
 *   versão atual;
 * - qualquer outro valor é recusado, para um arquivo de outro tipo não ser lido
 *   como este.
 * O documento de entrada nunca é alterado; `migrated` diz se a saída é outra.
 */
export function checkSchemaVersion(
  data: unknown,
  kind: SchemaKind,
  // Só para testes: simula uma versão atual maior e as migrações até ela.
  { current = CURRENT_SCHEMA_VERSION[kind], migrations = MIGRATIONS[kind] }: { current?: number; migrations?: readonly SchemaMigration[] } = {}
): SchemaVersionCheck {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('$schema' in data)) {
    return { ok: true, version: current, doc: data, migrated: false }
  }
  const declared = (data as Record<string, unknown>)['$schema']
  const issue = (message: string): SchemaVersionCheck => ({ ok: false, issues: [{ path: '/$schema', message }] })
  if (typeof declared !== 'string') return issue('deve ser texto')

  const match = CANONICAL.exec(declared)
  if (!match) {
    if (declared.replaceAll('\\', '/').endsWith(`/${kind}.json`) || declared === `${kind}.json`) {
      return { ok: true, version: current, doc: data, migrated: false }
    }
    return issue(`schema desconhecido "${declared}"; use ${schemaUrl(kind, current)}`)
  }
  const version = Number(match[1])
  if (match[2] !== kind) return issue(`o arquivo é do tipo "${match[2]}", não "${kind}"`)
  if (version > current) {
    return issue(`o arquivo usa o schema v${version} de ${kind}, mais novo que o deste VVPost (v${current}); atualize o app`)
  }
  if (version < 1) return issue(`versão de schema inválida v${version}`)
  if (version === current) return { ok: true, version, doc: data, migrated: false }

  let doc = structuredClone(data) as Record<string, unknown>
  for (let v = version; v < current; v++) {
    const migrate = migrations[v - 1]
    if (!migrate) return issue(`sem migração de ${kind} v${v} para v${v + 1}`)
    doc = migrate(doc)
  }
  doc['$schema'] = schemaUrl(kind, current)
  return { ok: true, version, doc, migrated: true }
}
