import { readFile } from 'node:fs/promises'
import { MCP_TOOL_PROFILES, MCP_TOOL_SUMMARIES, type McpToolProfile } from '@shared/mcp-tools'
import type { McpCallStats } from './server'

/**
 * O relatório do --usage: quais ferramentas os agentes chamam de fato, lido dos arquivos do --stats.
 * Cada arquivo conta como uma sessão (o VVBuilder grava um por passo). Serve para montar o --tools:
 * uma ferramenta anunciada e nunca chamada custa a definição dela em todo turno, sem ganho.
 */
export interface UsageReport {
  sessions: number
  calls: number
  tools: { tool: string; calls: number; sessions: number; errors: number; avgOutChars: number }[]
  /** Anunciadas pelo servidor completo e nunca chamadas nessas sessões. */
  unused: string[]
  /** O menor perfil que cobre tudo o que foi chamado, ou os nomes, quando nenhum cobre. */
  suggestion: string
  text: string
}

export async function readStats(files: readonly string[]): Promise<McpCallStats[][]> {
  return Promise.all(
    files.map(async (file) => {
      const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim())
      return lines.map((line, i) => {
        try {
          return JSON.parse(line) as McpCallStats
        } catch {
          throw new Error(`${file}:${i + 1}: linha que não é JSON (é um arquivo do --stats?)`)
        }
      })
    })
  )
}

export function usageReport(sessions: readonly (readonly McpCallStats[])[]): UsageReport {
  const byTool = new Map<string, { calls: number; sessions: number; errors: number; outChars: number }>()
  for (const session of sessions) {
    const seen = new Set<string>()
    for (const call of session) {
      const t = byTool.get(call.tool) ?? { calls: 0, sessions: 0, errors: 0, outChars: 0 }
      t.calls++
      t.outChars += call.outChars ?? 0
      if (call.error) t.errors++
      if (!seen.has(call.tool)) t.sessions++
      seen.add(call.tool)
      byTool.set(call.tool, t)
    }
  }
  const tools = [...byTool]
    .map(([tool, t]) => ({ tool, calls: t.calls, sessions: t.sessions, errors: t.errors, avgOutChars: Math.round(t.outChars / t.calls) }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
  const used = tools.map((t) => t.tool)
  const unused = MCP_TOOL_SUMMARIES.map(([name]) => name).filter((name) => !byTool.has(name))
  const covering = (Object.keys(MCP_TOOL_PROFILES) as McpToolProfile[])
    .filter((p) => used.every((name) => (MCP_TOOL_PROFILES[p] as readonly string[]).includes(name)))
    .sort((a, b) => MCP_TOOL_PROFILES[a].length - MCP_TOOL_PROFILES[b].length)
  const suggestion = !used.length ? 'leitura' : (covering[0] ?? used.join(','))
  const calls = tools.reduce((n, t) => n + t.calls, 0)
  const lines = [
    `${sessions.length} ${sessions.length === 1 ? 'sessão' : 'sessões'}, ${calls} chamadas`,
    '',
    ...tools.map((t) => `${t.tool.padEnd(22)} ${String(t.calls).padStart(5)} ${t.calls === 1 ? 'chamada ' : 'chamadas'} em ${t.sessions} ${t.sessions === 1 ? 'sessão' : 'sessões'}${t.errors ? `, ${t.errors} com erro` : ''}, ${t.avgOutChars} caracteres de resposta em média`),
    '',
    unused.length ? `Sem uso (${unused.length} de ${MCP_TOOL_SUMMARIES.length}): ${unused.join(', ')}` : 'Todas as ferramentas foram usadas.',
    `Sugestão: --tools ${suggestion}`,
    ''
  ]
  return { sessions: sessions.length, calls, tools, unused, suggestion, text: lines.join('\n') }
}
