import { BASE_MODE, formatTokenValue, type BrandFile } from './tokens'

/** As diretivas da marca nas páginas: {{> tokens [grupo]}} e {{> contrast}}. */

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** Tabela dos tokens (do grupo, quando pedido): nome, tipo, valor, valores por modo e descrição. */
export function renderTokensMarkdown(files: BrandFile[], group: string): string | null {
  const tokens = files.flatMap((f) => f.tokens).filter((t) => t.resolved !== undefined && (!group || t.name === group || t.name.startsWith(`${group}.`)))
  if (!tokens.length) return null
  const modes = [...new Set(files.flatMap((f) => f.modes))].filter((m) => m !== BASE_MODE && tokens.some((t) => t.modes && m in t.modes))
  const header = ['Token', 'Tipo', 'Valor', ...modes.map((m) => `Modo ${m}`), 'Descrição']
  const rows = tokens.map((t) => [
    `\`${t.name}\``,
    t.type,
    `\`${cell(formatTokenValue(t.resolved))}\``,
    ...modes.map((m) => (t.modes && m in t.modes ? `\`${cell(formatTokenValue(t.modes[m]))}\`` : '')),
    cell(t.description ?? '')
  ])
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

/** Tabela dos pares de contraste em cada modo, com o resultado. */
export function renderContrastMarkdown(files: BrandFile[]): string | null {
  const results = files.flatMap((f) => f.contrast)
  if (!results.length) return null
  const ratio = (n: number | null) => (n === null ? '—' : `${String(n).replace('.', ',')}:1`)
  const rows = results.map((r) => [
    `\`${r.fg}\` sobre \`${r.bg}\``,
    r.mode === BASE_MODE ? 'padrão' : r.mode,
    `\`${r.fgValue ?? ''}\` / \`${r.bgValue ?? ''}\``,
    ratio(r.ratio),
    ratio(r.min),
    r.ok ? 'passa' : '**não passa**'
  ])
  return ['| Par | Modo | Cores | Contraste | Mínimo | Resultado |', '| --- | --- | --- | --- | --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}
