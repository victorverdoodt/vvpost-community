import { DocsError } from '../build'
import type { PublishAsset, PublishBundle } from '../publish/types'
import type { DocsExporter, ExportContext, ExportFile } from './types'

/** Um arquivo como o plugin devolve: texto ou bytes em base64. */
export interface PluginExportFile {
  path: string
  text?: string
  base64?: string
  page?: string
}

export interface PluginExportResult {
  files: PluginExportFile[]
}

/** O pacote como vai ao processo do plugin (JSON): os bytes dos anexos em base64. */
export type PluginBundle = Omit<PublishBundle, 'assets'> & { assets: (Omit<PublishAsset, 'data'> & { base64?: string })[] }

export function toPluginBundle(bundle: PublishBundle): PluginBundle {
  return {
    ...bundle,
    assets: bundle.assets.map(({ data, ...a }) => ({ ...a, ...(data && { base64: Buffer.from(data).toString('base64') }) }))
  }
}

/**
 * O exportador de um plugin (contributes.exporters): o host chama exporters[id].export(ctx) no
 * processo do plugin, com ctx.bundle, ctx.changelog e ctx.previous, e confere o que volta.
 */
export function pluginExporter(
  info: { id: string; title: string; description?: string; pluginName: string },
  invoke: (input: { bundle: PluginBundle; changelog: ExportContext['changelog']; previous: ExportContext['previous'] }, signal?: AbortSignal) => Promise<unknown>
): DocsExporter {
  return {
    id: info.id,
    title: info.title,
    ...(info.description && { description: info.description }),
    async render(bundle, ctx) {
      const value = (await invoke({ bundle: toPluginBundle(bundle), changelog: ctx.changelog, previous: ctx.previous }, ctx.signal)) as PluginExportResult | null
      const files = value && typeof value === 'object' && Array.isArray(value.files) ? value.files : null
      if (!files) throw new DocsError(`o exportador ${info.id} (${info.pluginName}) não devolveu { files: [...] }`)
      return files.map((f): ExportFile => {
        const path = typeof f?.path === 'string' ? f.path : ''
        let data: string | Uint8Array
        if (typeof f?.text === 'string') data = f.text
        else if (typeof f?.base64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)) data = new Uint8Array(Buffer.from(f.base64, 'base64'))
        else throw new DocsError(`o exportador ${info.id} devolveu "${path.slice(0, 120)}" sem text nem base64`)
        return { path, data, ...(typeof f.page === 'string' && { page: f.page }) }
      })
    }
  }
}
