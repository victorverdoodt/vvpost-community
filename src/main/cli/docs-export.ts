import { resolve } from 'node:path'
import type { DocsExporter } from '@vvpost/core/docs/export'
import type { Io } from './index'

export const DOCS_EXPORT_HELP_OPTIONS = `Opções de docs export (vvpost docs export; guia em docs/publish.md):
  --target <id>         Destino do vvpost.publish.json com um exportador (html ou de plugin). Sem ele: o único
                        destino exportável; sem vvpost.publish.json, um site html com a estrutura de partida
  --out <pasta>         Pasta de saída (padrão: o destination do destino, relativo ao workspace; sem arquivo, dist/site)
  --label <versão>      Nome desta versão na página Mudanças (ex.: v2.3.0)
  --force               Sobrescreve as páginas editadas à mão na pasta desde a última exportação
  --no-plugins          Só o exportador html
  --json -              Resultado em JSON no stdout
                        Diagramas viram imagem com o executável do VVPost por perto (o app instalado ou
                        VVPOST_ELECTRON); sem ele, o site leva o mermaid.min.js e o navegador desenha
`

export interface DocsExportValues {
  target?: string | undefined
  out?: string | undefined
  label?: string | undefined
  force?: boolean | undefined
  json?: string | undefined
  'no-plugins'?: boolean | undefined
}

/**
 * vvpost docs export: a documentação num site estático (ou no formato de um exportador de
 * plugin), para publicar no CI num portal de parceiros, no GitHub Pages ou no Backstage. Os
 * publicadores remotos (Confluence Cloud) continuam só no app, com confirmação. Sai com 0, 1
 * (página editada à mão sem --force) ou 2 (configuração).
 */
export async function docsExportCommand(dir: string, io: Io, values: DocsExportValues, options: { generator: string; plugins: { officialDir: string; userDir: string; stateFile: string } | null }): Promise<number> {
  const quiet = values.json === '-'
  const say = (text: string) => (quiet ? io.stderr(text) : io.stdout(text))
  if (values.json !== undefined && values.json !== '-') {
    io.stderr('vvpost: --json só aceita "-" (stdout) no docs export\n')
    return 2
  }
  if (values.label !== undefined && (!values.label.trim() || values.label.length > 80)) {
    io.stderr('vvpost: --label precisa de um nome de até 80 caracteres\n')
    return 2
  }
  const [exp, site] = await Promise.all([import('@vvpost/core/docs/export'), import('../docs/site-export')])
  let manager: import('@vvpost/core/plugins').PluginManager | null = null
  try {
    const exporters: DocsExporter[] = [exp.htmlExporter]
    if (options.plugins) {
      const { PluginManager } = await import('@vvpost/core/plugins')
      manager = new PluginManager(options.plugins)
      for (const e of await manager.exporters()) exporters.push(exp.pluginExporter(e, (input, signal) => e.invoke(input, signal)))
    }
    const { target, exporter, folder, result, diagnostics, warnings } = await site.exportDocsSite(dir, {
      exporters,
      generator: options.generator,
      target: values.target,
      ...(values.out && { folder: { dir: resolve(io.cwd, values.out), label: values.out } }),
      label: values.label,
      force: values.force,
      targetOption: '--target',
      remoteHint: `publique pelo app (Documentação → Enviar para…)${options.plugins ? '' : ' ou tire o --no-plugins'}`
    })
    for (const d of diagnostics) io.stderr(`${d.severity === 'error' ? 'erro' : 'aviso'}: ${d.file}${d.line > 1 ? `:${d.line}` : ''}: ${d.message}\n`)
    for (const w of warnings) io.stderr(`aviso: ${w}\n`)
    const tally = site.siteTally(result)
    if (quiet) {
      io.stdout(`${JSON.stringify({ target: target.id, exporter: exporter.id, dir: folder.dir, items: result.items, warnings: result.plan.warnings }, null, 2)}\n`)
    }
    for (const w of result.plan.warnings) io.stderr(`aviso: ${w}\n`)
    say(
      `${exporter.title} gravado em ${folder.dir}: ${tally.pages} página(s), ${tally.created} nova(s), ${tally.updated} atualizada(s), ${tally.unchanged} igual(is), ${tally.archived} removida(s)\n`
    )
    return 0
  } catch (err) {
    const message = (err as Error).message
    io.stderr(`vvpost: ${message}\n`)
    return /editadas à mão/.test(message) ? 1 : 2
  } finally {
    await manager?.shutdown()
  }
}
