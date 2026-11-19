import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { LoadedWorkspace } from '@vvpost/core/connectors/workspace'
import type { DocDiagnostic } from '@vvpost/core/docs/compose'
import type {
  DocsPublisher,
  PublishApproval,
  PublishBundle,
  PublishPlan,
  PublishResult,
  PublishTreeNode,
  PublisherSession
} from '@vvpost/core/docs/publish'
import type { PluginExporterEntry, PluginPublisherEntry } from '@vvpost/core/plugins'
import type { PublisherCredentials } from '@vvpost/core/docs/publish'
import type { HttpRequestInput, HttpResult } from '@vvpost/core/types'
import type { FlowCatalog } from '@vvpost/core/types'
import type { PublishOutlineNode, PublishPrepared, PublishTargetsState } from '@shared/ipc'
import { controlPlane, recordActivity } from '../enterprise/control-plane'
import { safeOpen } from '../enterprise/identity'

/**
 * "Enviar para…" da Documentação no main process. O renderer só escolhe o destino, desenha os
 * diagramas (é ele que tem o Mermaid) e confirma; o pacote é montado aqui, dos arquivos do
 * workspace e sem segredos, e só o publicador fala com o destino: um remoto (do módulo
 * Enterprise) com a conta da própria pessoa, ou um exportador para uma pasta do workspace (o
 * site html do core e os exportadores de plugins).
 */
export interface PublishDeps {
  dir(): Promise<string | null>
  workspace(): Promise<LoadedWorkspace>
  flows(dir: string): Promise<FlowCatalog>
  openExternal(url: string): Promise<void>
  /** SVG de um diagrama → PNG; null quando não deu (o publicador cai para o código). */
  svgToPng(svg: string): Promise<Uint8Array | null>
  /** Exportadores dos plugins ligados (contributes.exporters). */
  pluginExporters?(): Promise<PluginExporterEntry[]>
  /** Publicadores remotos dos plugins ligados (contributes.publishers), o cliente HTTP deles e onde ficam as credenciais. */
  pluginPublishers?(): Promise<PluginPublisherEntry[]>
  send?(input: HttpRequestInput): Promise<HttpResult>
  cancel?(id: string): void
  credentials?: PublisherCredentials
}

const MAX_SVG_BYTES = 5 * 1024 * 1024

let override: DocsPublisher[] | null = null

/** Só para testes: troca (ou limpa, com null) os publicadores sem carregar o módulo. */
export function setPublishersForTests(list: DocsPublisher[] | null): void {
  override = list
}

/**
 * Os publicadores remotos do módulo Enterprise e dos plugins, e os exportadores para pasta: o html
 * do core (que nada troca) e os de plugins. A pasta de um exportador é o destination, dentro do
 * workspace. Um id do módulo Enterprise vence o mesmo id vindo de um plugin.
 */
async function publishers(deps: PublishDeps): Promise<DocsPublisher[]> {
  if (override) return override
  const list = (await controlPlane())?.publishers
  const { createFolderPublisher, htmlExporter, pluginExporter, workspaceExportFolder } = await import('@vvpost/core/docs/export')
  const folder = async (target: { destination: string }) => {
    const dir = await deps.dir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    return workspaceExportFolder(dir, target.destination)
  }
  const plugins = (await deps.pluginExporters?.().catch(() => [])) ?? []
  const exporters = [htmlExporter, ...plugins.map((e) => pluginExporter(e, (input, signal) => e.invoke(input, signal)))]
  const remote = (Array.isArray(list) ? list.filter(validPublisher) : []).filter((p) => !exporters.some((e) => e.id === p.id))
  const fromPlugins = deps.send && deps.credentials ? ((await deps.pluginPublishers?.().catch(() => [])) ?? []) : []
  const { pluginPublisher } = fromPlugins.length ? await import('@vvpost/core/docs/publish') : { pluginPublisher: null }
  const pluginRemote = fromPlugins
    .filter((p) => !remote.some((r) => r.id === p.id) && !exporters.some((e) => e.id === p.id))
    .map((p) => pluginPublisher!(p, { send: deps.send!, ...(deps.cancel && { cancel: deps.cancel }), credentials: deps.credentials! }))
  return [...remote, ...pluginRemote, ...exporters.map((e) => createFolderPublisher(e, { folder }))]
}

function validPublisher(p: DocsPublisher): boolean {
  return typeof p?.id === 'string' && (['session', 'plan', 'publish'] as const).every((k) => typeof p[k] === 'function')
}

/** O pacote preparado e o plano que a pessoa está vendo. Um por vez: o diálogo é modal. */
let current: { id: string; dir: string; text: string | null; bundle: PublishBundle; plan?: PublishPlan } | null = null

export function createPublishService(deps: PublishDeps) {
  const docs = () => import('@vvpost/core/docs/publish')
  const open = safeOpen(deps.openExternal)

  async function workspaceDir(): Promise<string> {
    const dir = await deps.dir()
    if (!dir) throw new Error('Nenhum workspace aberto.')
    return dir
  }

  async function targetAndPublisher(targetId: string) {
    const dir = await workspaceDir()
    const { diagramFormat, loadPublishConfig, PUBLISH_CONFIG_FILE } = await docs()
    const loaded = await loadPublishConfig(dir)
    if (!loaded.config) throw new Error(loaded.issues[0] ? `${loaded.issues[0].file}: ${loaded.issues[0].message}` : `${PUBLISH_CONFIG_FILE} não existe no workspace.`)
    const target = loaded.config.targets.find((t) => t.id === targetId)
    if (!target) throw new Error(`destino "${targetId}" não existe em ${PUBLISH_CONFIG_FILE}`)
    const publisher = (await publishers(deps)).find((p) => p.id === target.provider)
    if (!publisher) throw new Error(`Nenhum publicador "${target.provider}" disponível: vem do VVPost Enterprise ou de um plugin (Extensions Hub).`)
    const ref = { id: target.id, name: target.name ?? target.id, provider: target.provider, destination: target.destination, diagrams: diagramFormat(target) }
    return { dir, loaded, target, ref, publisher }
  }

  return {
    /** Destinos do vvpost.publish.json, com o publicador e a conta de cada um. */
    async targets(): Promise<PublishTargetsState> {
      const dir = await workspaceDir()
      const [{ loadPublishConfig, diagramFormat }, list] = await Promise.all([docs(), publishers(deps)])
      const loaded = await loadPublishConfig(dir)
      const targets = await Promise.all(
        (loaded.config?.targets ?? []).map(async (t) => {
          const p = list.find((x) => x.id === t.provider)
          const ref = { id: t.id, name: t.name ?? t.id, provider: t.provider, destination: t.destination, diagrams: diagramFormat(t) }
          let session: PublisherSession | undefined
          if (p) session = await p.session(ref).then(cleanSession, (err: Error) => ({ status: 'unavailable' as const, message: err.message }))
          return { ...ref, available: p !== undefined, ...(p && { providerTitle: p.title }), ...(p?.local && { local: true }), ...(session && { session }) }
        })
      )
      return {
        configExists: loaded.text !== null,
        issues: loaded.issues,
        targets,
        providers: list.map((p) => ({ id: p.id, title: p.title, ...(p.local && { local: true }) }))
      }
    },

    /** Cria o vvpost.publish.json com um destino de partida (documento, docs/ e conectores). */
    async init(provider: string, destination: string): Promise<{ file: string }> {
      const dir = await workspaceDir()
      const { PUBLISH_CONFIG_FILE, starterPublishConfig } = await docs()
      const { workspaceWritePath } = await import('@vvpost/core/docs/compose')
      if (!(await publishers(deps)).some((p) => p.id === provider)) throw new Error(`publicador "${provider}" não está disponível`)
      if (!destination.trim() || destination.length > 500) throw new Error('destino inválido')
      const path = await workspaceWritePath(dir, PUBLISH_CONFIG_FILE)
      if (await readFile(path, 'utf8').then(() => true, () => false)) throw new Error(`${PUBLISH_CONFIG_FILE} já existe`)
      await writeFile(path, `${JSON.stringify(starterPublishConfig(provider, destination.trim()), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      return { file: PUBLISH_CONFIG_FILE }
    },

    /** credential: o que a pessoa colou, para um publicador com session.credential (os de plugins). */
    async signIn(targetId: string, credential?: string): Promise<PublisherSession> {
      const { ref, publisher } = await targetAndPublisher(targetId)
      if (!publisher.signIn) return cleanSession(await publisher.session(ref))
      return cleanSession(await publisher.signIn(ref, { openExternal: open, ...(credential && { credential }) }))
    },

    async signOut(targetId: string): Promise<void> {
      const { ref, publisher } = await targetAndPublisher(targetId)
      await publisher.signOut?.(ref)
    },

    /** Monta o pacote; devolve a estrutura e os diagramas que o renderer precisa desenhar. */
    async prepare(targetId: string): Promise<PublishPrepared> {
      const { dir, loaded, target } = await targetAndPublisher(targetId)
      const { buildPublishBundle, pendingDiagrams } = await docs()
      const [ws, flows] = await Promise.all([deps.workspace(), deps.flows(dir)])
      const { bundle, diagnostics } = await buildPublishBundle(ws, flows, target, { generator: 'VVPost' })
      current = { id: randomUUID(), dir, text: loaded.text, bundle }
      return {
        id: current.id,
        nodes: outline(bundle.nodes),
        pages: count(bundle.nodes),
        diagrams: pendingDiagrams(bundle),
        diagnostics: cleanDiagnostics(diagnostics)
      }
    },

    /** Recebe os SVGs, completa os anexos e pede o plano ao publicador (nada muda no destino). */
    async plan(id: string, images: { id: string; svg: string }[]): Promise<PublishPlan> {
      const prepared = active(id)
      const [{ publisher }, { svgFile }] = await Promise.all([targetAndPublisher(prepared.bundle.target.id), docs()])
      for (const image of images.slice(0, 500)) {
        const asset = prepared.bundle.assets.find((a) => a.id === image.id && a.diagram !== undefined)
        if (!asset || typeof image.svg !== 'string' || !image.svg.startsWith('<svg') || Buffer.byteLength(image.svg) > MAX_SVG_BYTES) continue
        asset.data = asset.mediaType === 'image/svg+xml' ? new TextEncoder().encode(svgFile(image.svg)) : ((await deps.svgToPng(image.svg).catch(() => null)) ?? undefined)
      }
      prepared.plan = await publisher.plan(prepared.bundle, { openExternal: open })
      return prepared.plan
    },

    /** Publica o que a pessoa confirmou e grava os ids no vvpost.publish.json. */
    async apply(id: string, approval: PublishApproval): Promise<PublishResult & { recorded: boolean; warning?: string }> {
      const prepared = active(id)
      if (!prepared.plan) throw new Error('Monte o plano antes de publicar.')
      const { publisher } = await targetAndPublisher(prepared.bundle.target.id)
      const clean = cleanApproval(approval, prepared.plan)
      const started = Date.now()
      const result = await publisher.publish(prepared.bundle, prepared.plan, clean, { openExternal: open })
      current = null
      const tally = (o: string) => result.items.filter((i) => i.outcome === o).length
      recordActivity({
        at: new Date().toISOString(),
        kind: 'docsPublish',
        provider: prepared.bundle.target.provider,
        target: prepared.bundle.target.id,
        destination: result.destination.label,
        created: tally('created'),
        updated: tally('updated'),
        unchanged: tally('unchanged'),
        skipped: tally('skipped'),
        archived: tally('archived'),
        failed: tally('failed'),
        durationMs: Date.now() - started
      })
      // Um exportador guarda o estado na própria pasta (vvpost-site.json): o arquivo do repositório não muda.
      if (publisher.local) return { ...result, recorded: false }
      const { recordPublished } = await docs()
      try {
        await recordPublished(prepared.dir, prepared.text, prepared.bundle.target.id, result)
        return { ...result, recorded: true }
      } catch (err) {
        return { ...result, recorded: false, warning: (err as Error).message }
      }
    }
  }
}

function active(id: string) {
  if (!current || current.id !== id) throw new Error('A publicação mudou ou expirou; monte o plano de novo.')
  return current
}

/** Só as chaves que o plano tem, cada uma na lista que a ação dela pede. */
function cleanApproval(a: PublishApproval, plan: PublishPlan): PublishApproval {
  const of = (action: string) => new Set(plan.items.filter((i) => i.action === action).map((i) => i.key))
  const pick = (list: unknown, allowed: Set<string>) => (Array.isArray(list) ? [...new Set(list.filter((k): k is string => typeof k === 'string' && allowed.has(k)))] : [])
  return { update: pick(a?.update, of('update')), conflicts: pick(a?.conflicts, of('conflict')), archive: pick(a?.archive, of('orphan')) }
}

/** Campo a campo: o que mais o módulo puser na sessão (um token, por engano) não vai ao renderer. */
function cleanSession(s: PublisherSession): PublisherSession {
  const text = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined)
  const status = s?.status === 'signedIn' || s?.status === 'signedOut' ? s.status : 'unavailable'
  const account = text(s?.account)
  const destination = text(s?.destination)
  const message = text(s?.message, 1000)
  const label = text(s?.credential?.label, 60)
  const help = text(s?.credential?.help, 500)
  const credential = status === 'signedOut' && label ? { label, ...(help?.startsWith('https://') && { help }) } : undefined
  return { status, ...(account && { account }), ...(destination && { destination }), ...(message && { message }), ...(credential && { credential }) }
}

function outline(nodes: PublishTreeNode[]): PublishOutlineNode[] {
  return nodes.map((n) => ({ key: n.key, kind: n.kind, title: n.title, ...(n.source && { source: n.source }), children: outline(n.children) }))
}

function count(nodes: PublishTreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + count(n.children), 0)
}

function cleanDiagnostics(list: DocDiagnostic[]): DocDiagnostic[] {
  const seen = new Set<string>()
  return list.filter((d) => {
    const k = `${d.file}:${d.line}:${d.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
