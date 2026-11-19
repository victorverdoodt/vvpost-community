import { resolve } from 'node:path'
import { isUrl } from '../importers/source'
import { syncSpecSources, type SpecSyncEndpoint, type SpecSyncReport } from '../importers/spec-sync'
import type { Io } from './index'

export interface SyncValues {
  connector?: string[]
  link?: string
  check?: boolean
  'dry-run'?: boolean
  prune?: boolean
  'keep-edits'?: boolean
  'fail-on'?: string
  json?: string
}

const STATUS_TEXT: Record<SpecSyncEndpoint['status'], string> = {
  new: 'novo',
  updated: 'mudou na spec',
  conflict: 'conflito',
  edited: 'editado aqui',
  linked: 'vinculado',
  removed: 'saiu da spec'
}

/**
 * vvpost sync (docs/openapi-sync.md): a spec OpenAPI do código como fonte do contrato. Sem opção,
 * aplica; --check só confere e sai com 1 se houver drift (ou, com --fail-on breaking, só se algo
 * quebrar), para o CI; --link vincula um conector feito à mão a uma spec.
 */
export async function syncCommand(dir: string, io: Io, values: SyncValues): Promise<number> {
  const failOn = values['fail-on'] ?? 'drift'
  if (failOn !== 'drift' && failOn !== 'breaking') {
    io.stderr(`vvpost: --fail-on ${failOn}: use drift ou breaking\n`)
    return 2
  }
  const connectors = (values.connector ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
  if (values.link !== undefined && connectors.length !== 1) {
    io.stderr('vvpost: --link pede o conector a vincular: vvpost sync --link <arquivo | URL> --connector <id>\n')
    return 2
  }
  if (values.link !== undefined && values.check) {
    io.stderr('vvpost: --link grava o vínculo; para só ver o plano, use --dry-run\n')
    return 2
  }
  const apply = !values.check && !values['dry-run']
  const report = await syncSpecSources(dir, {
    ...(values.link !== undefined
      ? { link: { connector: connectors[0]!, location: isUrl(values.link) ? values.link : resolve(io.cwd, values.link) } }
      : connectors.length && { connectors }),
    prune: values.prune === true,
    keepEdits: values['keep-edits'] === true,
    apply
  })
  const failed = values.check && report.results.some((r) => (failOn === 'drift' ? r.drift : r.breaking))
  const code = !report.ok ? 2 : failed ? 1 : 0
  if (values.json === '-') {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`)
    return code
  }
  for (const e of report.errors) io.stderr(`vvpost: ${e.message}\n`)
  io.stdout(text(report, apply, !!values.check))
  return code
}

function text(report: SpecSyncReport, apply: boolean, check: boolean): string {
  const lines: string[] = []
  for (const r of report.results) {
    lines.push(`${r.connector} ← ${r.location}${r.version ? ` (${r.version})` : ''}`)
    for (const e of r.errors) lines.push(`  erro  ${e.file}: ${e.message}`)
    for (const e of r.endpoints) {
      const fields = e.fields?.length ? `: ${e.fields.join(', ')}` : ''
      const what =
        e.status === 'removed'
          ? e.applied
            ? ' (apagado)'
            : ' (fica; --prune apaga)'
          : e.status === 'new'
            ? ''
            : e.applied
              ? ' (a spec ganha)'
              : ' (fica a versão do projeto)'
      const deps = e.dependents?.length ? ` · depende dele: ${e.dependents.join(', ')}` : ''
      lines.push(`  ${STATUS_TEXT[e.status].padEnd(13)} ${`${e.method} ${e.path}`.padEnd(28)} ${e.key}${fields}${what}${deps}`)
    }
    for (const s of r.schemas) {
      lines.push(`  ${'schema'.padEnd(13)} ${s.name} (${s.status === 'new' ? 'novo' : s.status === 'updated' ? 'mudou na spec' : s.applied ? 'editado aqui; a spec ganha' : 'editado aqui; fica'})`)
    }
    for (const b of r.breaks) lines.push(`  ${'quebra'.padEnd(13)} ${b.file}: ${b.message}`)
    if (r.onlyInProject.length) lines.push(`  ${'só no VVPost'.padEnd(13)} ${r.onlyInProject.join(', ')} (o sync não mexe)`)
    if (r.errors.length) continue
    if (!r.drift && !r.changes.length) lines.push('  Em dia com a spec')
    else if (apply) lines.push(`  ${r.changes.length} arquivo(s) gravado(s)${r.drift && r.endpoints.some((e) => !e.applied) ? '; o que ficou acima segue diferente da spec' : ''}`)
    else {
      const diffs = r.endpoints.filter((e) => e.status !== 'linked' || e.fields?.length).length + r.schemas.length
      lines.push(check ? `  Drift: ${diffs} diferença(s) com a spec; vvpost sync aplica` : `  Mudaria ${r.changes.length} arquivo(s); vvpost sync aplica`)
    }
  }
  return `${lines.join('\n')}\n`
}
