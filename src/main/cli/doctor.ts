import type { ProxyConfig } from '@vvpost/core/http/proxy'
import type { LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import type { ReadinessFinding } from '@vvpost/core/readiness'

/**
 * `vvpost doctor` (docs/readiness.md): a prontidão do workspace no terminal ou em JSON, com os segredos
 * do CI (VVPOST_SECRET_*, --secrets, --var) já aplicados. Sai com 0 pronto e 2 com bloqueio, para o
 * CI e a esteira pararem antes de rodar cenários que falhariam pelo ambiente e não pelo código.
 */

interface DoctorIo {
  stdout(text: string): void
}

/** O Secret Sanitizer da sessão: uma URL montada com variável secreta não sai em claro. */
type Clean = (text: string) => string

export interface DoctorOptions {
  environmentIds: string[]
  json: boolean
  probe: boolean
  proxy?: ProxyConfig
}

const MARK: Record<ReadinessFinding['severity'], string> = { blocker: '✗', warning: '!', agent: '·' }

export async function doctor(load: () => Promise<LoadedWorkspace>, clean: Clean, io: DoctorIo, options: DoctorOptions): Promise<number> {
  const ws = await load()
  const { checkReadiness } = await import('@vvpost/core/readiness')
  const report = await checkReadiness(ws, {
    probe: options.probe,
    ...(options.environmentIds.length && !options.environmentIds.includes('all') && { environmentIds: options.environmentIds }),
    ...(options.proxy && { proxy: options.proxy })
  })
  if (options.json) {
    io.stdout(`${clean(JSON.stringify(report, null, 2))}\n`)
    return report.ready ? 0 : 2
  }
  const line = (f: ReadinessFinding) => `  ${MARK[f.severity]} ${f.message}${f.hint ? `\n      ${f.hint}` : ''}`
  const out = [`Workspace ${ws.dir}: ${report.connectors} conectores`]
  if (report.workspace.length) out.push('', 'Workspace:', ...report.workspace.map(line))
  for (const env of report.environments) {
    const title = env.id ? `${env.id}${env.name && env.name !== env.id ? ` (${env.name})` : ''}` : '(sem ambiente)'
    out.push('', `${env.canExecute ? '✓' : '✗'} ${title}`)
    for (const p of env.probes ?? []) out.push(`    ${p.ok === null ? '?' : p.ok ? '✓' : '✗'} ${p.origin}${p.ms !== undefined ? ` ${p.ms} ms` : ''}${p.ok === null && p.error ? ` (${p.error})` : ''}`)
    out.push(...env.findings.map(line))
  }
  out.push('', report.ready ? 'Pronto para rodar.' : 'Com bloqueio: os cenários desses ambientes falhariam pelo ambiente, não pelo código.')
  out.push(`Não conferido: ${report.unverified.join('; ')}.`)
  io.stdout(`${clean(out.join('\n'))}\n`)
  return report.ready ? 0 : 2
}
