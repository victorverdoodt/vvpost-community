import { ToolError, type McpTool } from './tools'

/**
 * A marca para o agente (docs/brand.md): `get_brand` devolve os tokens resolvidos numa linha por
 * token (color.primary=#bd948a), o mais curto possível, para o agente ler antes de mexer no
 * frontend. Os achados do código vêm pelo lint (lint_project e lint.new de cada escrita).
 */

const getBrand: McpTool = {
  name: 'get_brand',
  title: 'Ler os tokens da marca (cores, fontes, espaçamentos) antes de mexer no frontend',
  description:
    'Devolve os tokens da marca e do produto de brand/*.tokens.json (formato W3C DTCG) já resolvidos, uma linha por token (color.primary=#bd948a), ' +
    'no modo pedido (padrão ou um dos modos, ex.: light), com o uso no código (var(--x) ou theme.palette...) e os pares de contraste que não passam. ' +
    'Chame antes de mexer em tela, CSS ou tema: use os tokens em vez de escrever cores, fontes e espaçamentos à mão. ' +
    'O lint confere o código contra eles (achados brand-* e tokens-contrast).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', description: 'Modo (ex.: light, dark) de $extensions.vvpost.modes; padrão: o valor base de cada token.' },
      group: { type: 'string', description: 'Só os tokens deste grupo (ex.: color, font, space).' },
      withDescriptions: { type: 'boolean', description: 'Inclui a $description de cada token (o uso de cada cor). Padrão: false.' }
    }
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    const [{ loadBrand, formatTokenValue, BASE_MODE }, { projectLayout }] = await Promise.all([import('@vvpost/core/brand'), import('@vvpost/core/projects')])
    const root = projectLayout(ctx.workspaceDir).root
    const { files, items } = await loadBrand(ctx.workspaceDir, { root })
    if (!files.length) {
      throw new ToolError('o projeto não tem tokens da marca', {
        code: 'NO_BRAND',
        hint: 'crie brand/<nome>.tokens.json no formato DTCG (docs/brand.md); sem ele, siga o tema que o código já usa'
      })
    }
    const mode = (args['mode'] as string | undefined) ?? BASE_MODE
    const modes = [...new Set(files.flatMap((f) => f.modes))]
    if (!modes.includes(mode)) throw new ToolError(`modo "${mode}" não existe`, { code: 'UNKNOWN_MODE', hint: `modos: ${modes.join(', ')}` })
    const group = args['group'] as string | undefined
    const withDescriptions = args['withDescriptions'] === true
    const usage = new Map(files.flatMap((f) => Object.entries(f.code).map(([name, targets]) => [name, targets.map((t) => (t.startsWith('--') ? `var(${t})` : `theme.${t}`)).join(' | ')] as const)))
    const lines: string[] = []
    for (const f of files)
      for (const t of f.tokens) {
        if (t.resolved === undefined || (group && t.name !== group && !t.name.startsWith(`${group}.`))) continue
        const value = mode !== BASE_MODE && t.modes && mode in t.modes ? t.modes[mode] : t.resolved
        const use = usage.get(t.name)
        lines.push(`${t.name}=${formatTokenValue(value)}${use ? ` (${use})` : ''}${withDescriptions && t.description ? ` # ${t.description}` : ''}`)
      }
    const failing = files.flatMap((f) => f.contrast).filter((c) => !c.ok && (c.mode === mode || mode === BASE_MODE))
    const invalid = items.filter((i) => i.code === 'tokens-invalid').length
    return {
      files: files.map((f) => f.file),
      mode,
      ...(modes.length > 1 && { modes }),
      tokens: ctx.sanitizer.text(lines.join('\n')),
      ...(failing.length && { contrastFailing: failing.map((c) => `${c.fg} / ${c.bg}${c.mode === BASE_MODE ? '' : ` (${c.mode})`}: ${c.ratio}:1 < ${c.min}:1`) }),
      ...(invalid && { invalidTokens: invalid, hint: 'lint_project { code: "tokens-invalid" } lista os problemas do arquivo de tokens' })
    }
  }
}

export const BRAND_TOOLS: readonly McpTool[] = [getBrand]
