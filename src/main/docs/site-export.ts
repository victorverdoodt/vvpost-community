import { basename } from 'node:path'
import type { DocDiagnostic } from '@vvpost/core/docs'
import type { DocsExporter, ExportFolder, exportToFolder } from '@vvpost/core/docs/export'
import type { PublishTarget } from '@vvpost/schemas'

export type FolderExportResult = Awaited<ReturnType<typeof exportToFolder>>

/**
 * A documentação num site (ou no formato de um exportador de plugin) dentro de uma pasta: o
 * mesmo caminho do `vvpost docs export` e do `export_docs { format: "site" }` do MCP. Escolhe o
 * destino do vvpost.publish.json, monta o pacote pela estrutura (já pelo Secret Sanitizer),
 * desenha os diagramas quando há o executável do VVPost e grava com a página Mudanças.
 */
export interface SiteExportOptions {
  exporters: DocsExporter[]
  generator: string
  target?: string | undefined
  /** A pasta de saída já resolvida; sem ela, o destination do destino, relativo ao workspace. */
  folder?: ExportFolder | undefined
  label?: string | undefined
  force?: boolean | undefined
  /** Por que um destino de publicador não exporta para pasta (o que fazer em vez disso). */
  remoteHint: string
  /** Como se escolhe o destino nesta superfície (--target no CLI, target no MCP). */
  targetOption: string
}

export interface SiteExportResult {
  target: PublishTarget
  exporter: DocsExporter
  folder: ExportFolder
  result: FolderExportResult
  diagnostics: DocDiagnostic[]
  /** Diagramas que foram como código Mermaid (sem imagem nem o mermaid.min.js), e por quê. */
  warnings: string[]
}

export async function exportDocsSite(dir: string, options: SiteExportOptions): Promise<SiteExportResult> {
  const [{ loadWorkspace }, { loadFlows }, publish, exp, docs] = await Promise.all([
    import('@vvpost/core/connectors/workspace'),
    import('@vvpost/core/flows/workspace'),
    import('@vvpost/core/docs/publish'),
    import('@vvpost/core/docs/export'),
    import('@vvpost/core/docs')
  ])
  const { exporters } = options
  const loaded = await publish.loadPublishConfig(dir)
  if (loaded.issues.length) throw new SiteConfigError(loaded.issues.map((i) => `${i.file}: ${i.message}`).join('; '))
  let target: PublishTarget
  if (loaded.config) {
    const exportable = loaded.config.targets.filter((t) => exporters.some((e) => e.id === t.provider))
    if (options.target) {
      const found = loaded.config.targets.find((t) => t.id === options.target)
      if (!found) throw new SiteConfigError(`destino "${options.target}" não existe em ${publish.PUBLISH_CONFIG_FILE}`)
      if (!exportable.includes(found)) throw new SiteConfigError(`o destino "${found.id}" é do publicador ${found.provider}, que não exporta para uma pasta: ${options.remoteHint}`)
      target = found
    } else if (exportable.length === 1) target = exportable[0]!
    else if (exportable.length) {
      throw new SiteConfigError(`${publish.PUBLISH_CONFIG_FILE} tem ${exportable.length} destinos exportáveis; escolha com ${options.targetOption} (${exportable.map((t) => t.id).join(', ')})`)
    } else throw new SiteConfigError(`${publish.PUBLISH_CONFIG_FILE} não tem destino com o provider ${exporters.map((e) => e.id).join(' ou ')}`)
  } else {
    if (options.target) throw new SiteConfigError(`${publish.PUBLISH_CONFIG_FILE} não existe; sem ele, a exportação usa a estrutura de partida (sem ${options.targetOption})`)
    target = publish.starterPublishConfig('html', 'dist/site').targets[0]!
    // Sem o documento do projeto, a página de cima só agrupa os guias e a referência.
    if ((await docs.loadDocsProject(dir)).source === null) {
      const root = target.structure[0] as { page: string; source?: string }
      delete root.source
      root.page = 'Documentação'
    }
  }
  const exporter = exporters.find((e) => e.id === target.provider)!

  const [ws, flows] = await Promise.all([loadWorkspace(dir), loadFlows(dir)])
  const { bundle, diagnostics } = await publish.buildPublishBundle(ws, flows, target, { projectName: basename(dir), generator: options.generator })
  const warnings: string[] = []
  const pending = publish.pendingDiagrams(bundle)
  if (pending.length && bundle.target.diagrams !== 'code') {
    const { renderDiagramsInSubprocess } = await import('./print-spawn')
    const drawn = await renderDiagramsInSubprocess(pending, bundle.target.diagrams === 'svg' ? 'svg' : 'png').catch((err: Error) => {
      warnings.push(`os diagramas não viraram imagem (${err.message})`)
      return []
    })
    for (const d of drawn ?? []) {
      const asset = bundle.assets.find((a) => a.id === d.id && a.diagram !== undefined)
      if (asset) asset.data = d.data
    }
  }
  // O que ficou sem imagem o site html desenha no navegador, com o mermaid.min.js dele.
  let mermaidScript: string | undefined
  if (publish.pendingDiagrams(bundle).length && bundle.target.diagrams !== 'code') {
    mermaidScript = exporter.id === 'html' ? ((await (await import('./mermaid-script')).loadMermaidScript()) ?? undefined) : undefined
    if (!mermaidScript) warnings.push('sem o executável do VVPost (o app ou VVPOST_ELECTRON) nem o mermaid.min.js, os diagramas vão como código Mermaid')
  }

  const folder = options.folder ?? (await exp.workspaceExportFolder(dir, target.destination))
  const result = await exp.exportToFolder(bundle, exporter, folder, {
    ...(options.label && { release: options.label.trim() }),
    ...(options.force && { force: true }),
    ...(mermaidScript && { mermaidScript })
  })
  return { target, exporter, folder, result, diagnostics, warnings }
}

/** Configuração que impede a exportação (destino, vvpost.publish.json): o CLI sai com 2. */
export class SiteConfigError extends Error {}

/** Páginas do resultado por desfecho, sem as arquivadas no total. */
export function siteTally(result: FolderExportResult) {
  const count = (o: string) => result.items.filter((i) => i.outcome === o && i.kind === 'page').length
  return {
    pages: result.items.filter((i) => i.kind === 'page' && i.outcome !== 'archived').length,
    created: count('created'),
    updated: count('updated'),
    unchanged: count('unchanged'),
    archived: count('archived')
  }
}
