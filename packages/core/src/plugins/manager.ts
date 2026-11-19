import { randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { validatePluginManifest, type PluginManifest } from '@vvpost/schemas'
import type {
  DiagramCatalog,
  DiagramIcon,
  DiagramIconPack,
  PluginCatalog,
  PluginContribution,
  PluginInfo,
  PluginInstallPreview,
  PluginOrigin,
  PluginPermissionsInfo,
  PluginRegistryListing,
  PluginSignatureInfo,
  TrustedPluginKey
} from '../types'
import { extractArchive } from './archive'
import { checkRegistryUrl, defaultFetcher, fetchRegistryIndex, latestVersion, RegistryError, sha256Hex, type Fetcher } from './registry'
import { fingerprintOf, INSTALL_RECORD, verifyPluginDir } from './signature'
import { describeNetworkRules, needsNetwork, staticNetworkRules } from '../sandbox/network-rules'
import { netnsAvailable } from '../sandbox/os'
import { assertFeature, featureDenial, pluginContributionDenial } from '../policy/features'
import { PluginWorker, type Invocation, type InvokeOutcome, type PluginWorkerOptions } from './host'
import type { ContributionKind, PluginHttpRequest, PluginHttpResult } from './protocol'

export const MANIFEST_FILE = 'vvpost-plugin.json'
/** Teto de um pacote de ícones dos diagramas (Iconify JSON). */
const MAX_ICON_PACK_BYTES = 4 * 1024 * 1024
const MAX_ICONS_PER_PACK = 10_000
const MAX_ICON_BODY = 64 * 1024
/** Exportadores por plugin e o tempo de uma exportação (um site grande leva segundos). */
const MAX_EXPORTERS = 16
export const EXPORT_TIMEOUT_MS = 180_000
/** Tempo de cada chamada de um publicador: a sessão é rápida; publicar um espaço grande, não. */
export const PUBLISHER_TIMEOUT_MS = { session: 30_000, plan: 180_000, publish: 600_000 } as const
/** Os exportadores e publicadores que vêm com o VVPost: um plugin não os troca. */
const BUILTIN_EXPORTERS = new Set(['html', 'confluence-cloud'])
/** Teto do que "Instalar de pasta" copia: um plugin não deveria trazer um disco inteiro. */
const MAX_INSTALL_FILES = 5_000
const MAX_INSTALL_BYTES = 100 * 1024 * 1024

export interface PluginManagerOptions extends PluginWorkerOptions {
  /** Plugins oficiais, que vêm com o app: só podem ser desligados. */
  officialDir: string
  /** Plugins instalados pelo usuário (userData/plugins). */
  userDir: string
  /** Quais plugins o usuário desligou, as chaves confiáveis e os registros (userData/plugins.json). */
  stateFile: string
  /** Onde os pacotes baixados e extraídos esperam a confirmação (padrão: <userDir>.staging). */
  stagingDir?: string
  /** Downloads dos registros (testes trocam). */
  fetcher?: Fetcher
}

/** userData/plugins.json. */
interface PluginState {
  disabled: string[]
  trustedKeys: TrustedPluginKey[]
  registries: string[]
}

/** O que a instalação grava em <plugin>/.vvpost-install.json. */
interface InstallRecord {
  origin: PluginOrigin
  signature: { status: 'unsigned' } | { status: 'valid'; publicKey: string; fingerprint: string }
  installedAt: string
}

/** Uma prévia que o usuário pode confirmar. */
interface PendingInstall {
  id: string
  sourceDir: string
  pluginId: string
  version: string
  origin: PluginOrigin
  record: InstallRecord['signature']
}

interface Scanned {
  manifest?: PluginManifest
  dir: string
  source: PluginInfo['source']
  entry?: string
  error?: string
}

/** Contribuição que um nó do fluxo pode usar: de um plugin ligado, carregado e sem conflito. */
export interface ResolvedContribution {
  pluginId: string
  pluginName: string
  contribution: PluginContribution
  /** permissions.network do manifesto (connector e config: viram hosts em cada chamada). */
  network: string[]
  /** permissions.connectorCredentials: o adapter recebe a conexão resolvida do conector. */
  connectorCredentials: boolean
}

/** Como a credencial da pessoa entra nas requisições do publicador (o auth do manifesto). */
export type PluginPublisherAuth = NonNullable<PluginManifest['contributes']['publishers']>[number]['auth']

/** Um publicador de plugin ligado: quem chama monta o DocsPublisher (docs/publish/plugin.ts) com invoke. */
export interface PluginPublisherEntry {
  pluginId: string
  pluginName: string
  id: string
  title: string
  description?: string
  hosts: string[]
  auth: PluginPublisherAuth
  /**
   * Roda publishers[id][op](ctx) no processo do plugin, com as requisições de ctx.http indo a
   * onHttp; lança com a mensagem do plugin.
   */
  invoke(
    op: 'session' | 'plan' | 'publish',
    input: { target: unknown; bundle?: unknown; plan?: unknown; approval?: unknown },
    onHttp: (request: PluginHttpRequest, signal: AbortSignal) => Promise<PluginHttpResult>,
    signal?: AbortSignal
  ): Promise<unknown>
}

/** Um exportador de plugin ligado: quem chama monta o exportador (docs/export/plugin.ts) com invoke. */
export interface PluginExporterEntry {
  pluginId: string
  pluginName: string
  id: string
  title: string
  description?: string
  /** Roda exporters[id].export(ctx) no processo do plugin; lança com a mensagem do plugin. */
  invoke(input: { bundle: unknown; changelog: unknown; previous: unknown }, signal?: AbortSignal): Promise<unknown>
}

/** O que o Context Engine usa para rodar nós de plugin (flows/plugin-node.ts). */
export interface FlowPluginRunner {
  /** A contribuição, ou o motivo de ela não estar disponível (denied: a organização desligou o recurso). */
  find(kind: ContributionKind, name: string): ResolvedContribution | string | { denied: string }
  invoke(pluginId: string, invocation: Invocation): Promise<InvokeOutcome>
}

const toContributions = (manifest: PluginManifest): PluginContribution[] => [
  ...(manifest.contributes.nodes ?? []).map((n): PluginContribution => ({
    kind: 'node',
    name: n.type,
    title: n.title,
    ...(n.description && { description: n.description }),
    fields: n.fields ?? []
  })),
  ...(manifest.contributes.adapters ?? []).map((a): PluginContribution => ({
    kind: 'adapter',
    name: a.protocol,
    title: a.title,
    ...(a.description && { description: a.description }),
    fields: a.fields ?? []
  }))
]

/** O que o plugin pode fazer, como o Extensions Hub e a prévia mostram. */
function toPermissions(manifest: PluginManifest): PluginPermissionsInfo {
  const network = manifest.permissions?.network ?? []
  const labels = new Map<string, string>()
  for (const c of [...(manifest.contributes.nodes ?? []), ...(manifest.contributes.adapters ?? [])]) {
    for (const f of c.fields ?? []) labels.set(f.key, f.label)
  }
  const summary = describeNetworkRules(network, (key) => labels.get(key) ?? key)
  if (manifest.permissions?.connectorCredentials) summary.push('recebe as credenciais do conector do nó')
  for (const p of manifest.contributes.publishers ?? []) summary.push(`publica em ${p.hosts.join(', ')} com a sua conta (pelo VVPost)`)
  return { network, connectorCredentials: manifest.permissions?.connectorCredentials === true, summary }
}

function publisherInfo(manifest: PluginManifest): NonNullable<PluginInfo['publishers']> {
  return (manifest.contributes.publishers ?? []).map((p) => ({ id: p.id, title: p.title, ...(p.description && { description: p.description }), hosts: p.hosts }))
}

export async function readManifest(dir: string): Promise<{ manifest: PluginManifest; entry: string } | { error: string }> {
  let raw: string
  try {
    raw = await readFile(join(dir, MANIFEST_FILE), 'utf8')
  } catch (err) {
    return { error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? `sem ${MANIFEST_FILE}` : (err as Error).message }
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    return { error: `${MANIFEST_FILE}: JSON inválido (${(err as Error).message})` }
  }
  const result = validatePluginManifest(doc)
  if (!result.ok) {
    return { error: `${MANIFEST_FILE}: ${result.issues.slice(0, 3).map((i) => `${i.path || '/'}: ${i.message}`).join('; ')}` }
  }
  const perms = result.value.permissions
  if (perms?.connectorCredentials && (perms.network ?? []).some((r) => r !== 'connector' && !r.startsWith('config:'))) {
    return { error: `${MANIFEST_FILE}: connectorCredentials só vale com permissions.network restrito a connector e config:<campo>` }
  }
  const entry = resolve(dir, result.value.main)
  if (!entry.startsWith(resolve(dir) + sep)) return { error: 'main fora da pasta do plugin' }
  const info = await stat(entry).catch(() => null)
  if (!info?.isFile()) return { error: `o arquivo de main (${result.value.main}) não existe` }
  return { manifest: result.value, entry }
}

async function scanDir(dir: string, source: PluginInfo['source']): Promise<Scanned[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: Scanned[] = []
  for (const e of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    const pluginDir = join(dir, e.name)
    const read = await readManifest(pluginDir)
    out.push('error' in read ? { dir: pluginDir, source, error: read.error } : { dir: pluginDir, source, ...read })
  }
  return out
}

/** Arquivos e bytes de uma pasta (sem .git e node_modules/.cache), parando no teto. */
async function measure(dir: string): Promise<{ files: number; bytes: number; tooLarge: boolean }> {
  let files = 0
  let bytes = 0
  const walk = async (path: string): Promise<boolean> => {
    for (const e of await readdir(path, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const full = join(path, e.name)
      if (e.isDirectory()) {
        if (!(await walk(full))) return false
      } else if (e.isFile()) {
        files++
        bytes += (await stat(full)).size
        if (files > MAX_INSTALL_FILES || bytes > MAX_INSTALL_BYTES) return false
      }
    }
    return true
  }
  const complete = await walk(dir)
  return { files, bytes, tooLarge: !complete }
}

/** A assinatura conferida, contra as chaves confiáveis e a chave fixada pelo registro. */
function describeSignature(
  check: Awaited<ReturnType<typeof verifyPluginDir>>,
  trusted: TrustedPluginKey[],
  pinned?: { publicKey: string; signer: string }
): PluginSignatureInfo {
  if (check.status === 'unsigned') return { status: 'unsigned' }
  if (check.status === 'invalid') return { status: 'invalid', reason: check.reason }
  const base = { publicKey: check.publicKey, fingerprint: check.fingerprint }
  if (pinned?.publicKey === check.publicKey) return { status: 'trusted', ...base, signer: pinned.signer }
  const key = trusted.find((k) => k.publicKey === check.publicKey)
  return key ? { status: 'trusted', ...base, signer: key.name } : { status: 'untrusted', ...base }
}

async function readRecord(dir: string): Promise<InstallRecord | null> {
  try {
    const record = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8')) as InstallRecord
    if (record?.signature?.status === 'valid' && typeof record.signature.publicKey === 'string') {
      return { ...record, signature: { ...record.signature, fingerprint: fingerprintOf(record.signature.publicKey) } }
    }
    return record?.origin ? { ...record, signature: { status: 'unsigned' } } : null
  } catch {
    return null
  }
}

/**
 * Plugins do VVPost (Plugin SDK). Duas origens: os oficiais, que vêm com o
 * app, e os instalados pelo usuário em userData/plugins (copiados de uma pasta pelo
 * Extensions Hub, depois de ele ver o que o plugin contribui). Nada é carregado de
 * dentro de um workspace: clonar um repositório nunca roda código de plugin.
 *
 * As pastas são relidas a cada listagem e a cada execução de fluxo (são poucos
 * arquivos pequenos); o código de cada plugin só sobe, num processo com sandbox, quando um
 * nó dele roda.
 */
export class PluginManager {
  private readonly workers = new Map<string, PluginWorker>()
  /** Plugins ligados e sem conflito com contributes.diagrams, da última varredura. */
  private diagramSources: { id: string; name: string; dir: string; diagrams: NonNullable<PluginManifest['contributes']['diagrams']> }[] = []
  private exporterSources: { pluginId: string; pluginName: string; id: string; title: string; description?: string }[] = []
  private publisherSources: Omit<PluginPublisherEntry, 'invoke'>[] = []
  private pendingInstall: PendingInstall | null = null
  /** Contribuições (kind:name) de plugins que a política da organização desligou, com o motivo, da última varredura. */
  private readonly denied = new Map<string, string>()

  constructor(private readonly options: PluginManagerOptions) {}

  private get stagingDir(): string {
    return this.options.stagingDir ?? `${resolve(this.options.userDir)}.staging`
  }

  async catalog(): Promise<PluginCatalog> {
    return (await this.scan()).catalog
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginCatalog> {
    const state = await this.readState()
    const disabled = new Set(state.disabled)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    await this.writeState({ ...state, disabled: [...disabled] })
    if (!enabled) await this.stopWorker(id, `o plugin ${id} foi desligado`)
    return this.catalog()
  }

  /** Lê a pasta escolhida e mostra o que seria instalado; nada é copiado ainda. */
  async previewInstall(sourceDir: string): Promise<PluginInstallPreview> {
    assertFeature('plugins')
    await this.clearStaging()
    const dir = resolve(sourceDir)
    return this.preview(dir, { kind: 'folder', location: dir })
  }

  /** Extrai um .zip/.tgz numa pasta temporária e mostra o que seria instalado. */
  async previewArchive(file: string): Promise<PluginInstallPreview> {
    assertFeature('plugins')
    const path = resolve(file)
    const origin: PluginOrigin = { kind: 'archive', location: path }
    let root: string
    try {
      root = await this.extract(path)
    } catch (err) {
      return this.failedPreview(path, origin, (err as Error).message)
    }
    return this.preview(root, origin)
  }

  /**
   * Baixa a versão (padrão: a mais nova) de um plugin do registro, confere o SHA-256 do pacote
   * e mostra a prévia. Uma chave fixada pelo registro precisa ter assinado o plugin.
   */
  async previewRegistry(registryUrl: string, pluginId: string, version?: string): Promise<PluginInstallPreview> {
    assertFeature('plugins')
    const fetcher = this.options.fetcher ?? defaultFetcher
    let origin: PluginOrigin = { kind: 'registry', location: registryUrl, registry: registryUrl }
    try {
      const index = await fetchRegistryIndex(registryUrl, fetcher)
      const entry = index.plugins.find((p) => p.id === pluginId)
      if (!entry) throw new RegistryError(`o registro ${index.name} não tem o plugin ${pluginId}`)
      const chosen = version ? entry.versions.find((v) => v.version === version) : latestVersion(entry)
      if (!chosen) throw new RegistryError(`o registro não tem ${pluginId}@${version}`)
      origin = { kind: 'registry', location: chosen.url, registry: registryUrl }
      const data = await fetcher(chosen.url, { maxBytes: MAX_INSTALL_BYTES })
      if (sha256Hex(data) !== chosen.sha256) throw new RegistryError(`o pacote baixado não confere com o SHA-256 do registro (${chosen.url})`)
      await this.clearStaging()
      await mkdir(this.stagingDir, { recursive: true })
      const file = join(this.stagingDir, `${randomUUID()}.pkg`)
      await writeFile(file, data)
      const root = await this.extract(file, false)
      return await this.preview(root, origin, {
        expect: { id: entry.id, version: chosen.version },
        ...(chosen.publicKey && { pinnedKey: { publicKey: chosen.publicKey, signer: `registro ${index.name}` } })
      })
    } catch (err) {
      return this.failedPreview(origin.location, origin, (err as Error).message)
    }
  }

  /** Copia a prévia para userData/plugins/<id> (substituindo uma versão anterior) e liga o plugin. */
  async install(previewId: string, options: { trustKey?: boolean } = {}): Promise<PluginCatalog> {
    assertFeature('plugins')
    const pending = this.pendingInstall
    if (!pending || pending.id !== previewId) throw new Error('Esta instalação não está mais disponível. Escolha o plugin de novo.')
    this.pendingInstall = null
    // A pasta pode ter mudado desde a prévia: id, versão e assinatura precisam ser os que o usuário viu.
    const read = await readManifest(pending.sourceDir)
    if ('error' in read) throw new Error(read.error)
    if (read.manifest.id !== pending.pluginId || read.manifest.version !== pending.version) throw new Error('O manifesto mudou depois da prévia. Escolha o plugin de novo.')
    const check = await verifyPluginDir(pending.sourceDir, read.manifest)
    const same = check.status === pending.record.status && (check.status !== 'valid' || (pending.record.status === 'valid' && check.publicKey === pending.record.publicKey))
    if (!same) throw new Error('Os arquivos do plugin mudaram depois da prévia. Escolha o plugin de novo.')
    const target = join(this.options.userDir, pending.pluginId)
    await this.stopWorker(pending.pluginId, `o plugin ${pending.pluginId} foi reinstalado`)
    await mkdir(this.options.userDir, { recursive: true })
    await rm(target, { recursive: true, force: true })
    await cp(pending.sourceDir, target, {
      recursive: true,
      filter: (src) => {
        const rel = relative(pending.sourceDir, src)
        return !rel.split(sep).includes('.git') && rel !== INSTALL_RECORD
      }
    })
    const record: InstallRecord = { origin: pending.origin, signature: pending.record, installedAt: new Date().toISOString() }
    await writeFile(join(target, INSTALL_RECORD), `${JSON.stringify(record, null, 2)}\n`)
    const state = await this.readState()
    const disabled = state.disabled.filter((d) => d !== pending.pluginId)
    let trustedKeys = state.trustedKeys
    if (options.trustKey && pending.record.status === 'valid' && !trustedKeys.some((k) => k.publicKey === (pending.record as { publicKey: string }).publicKey)) {
      trustedKeys = [...trustedKeys, { publicKey: pending.record.publicKey, fingerprint: pending.record.fingerprint, name: read.manifest.author ?? read.manifest.name, addedAt: record.installedAt }]
    }
    await this.writeState({ ...state, disabled, trustedKeys })
    await this.clearStaging()
    return this.catalog()
  }

  /** Apaga um plugin instalado pelo usuário. Os oficiais só podem ser desligados. */
  async remove(id: string): Promise<PluginCatalog> {
    const { plugins } = await this.catalog()
    const plugin = plugins.find((p) => p.id === id && p.source === 'user')
    if (!plugin) throw new Error(`Nenhum plugin instalado com o id ${id}.`)
    await this.stopWorker(id, `o plugin ${id} foi removido`)
    await rm(plugin.dir, { recursive: true, force: true })
    return this.catalog()
  }

  /** Passa a confiar numa chave de assinatura (ou troca o nome dela). */
  async trustKey(publicKey: string, name: string): Promise<PluginCatalog> {
    const fingerprint = fingerprintOf(publicKey)
    if (Buffer.from(publicKey, 'base64').length !== 32) throw new Error('A chave precisa ser uma chave pública Ed25519 de 32 bytes em base64.')
    const state = await this.readState()
    const others = state.trustedKeys.filter((k) => k.publicKey !== publicKey)
    await this.writeState({ ...state, trustedKeys: [...others, { publicKey, fingerprint, name: name.trim() || fingerprint, addedAt: new Date().toISOString() }] })
    return this.catalog()
  }

  async untrustKey(publicKey: string): Promise<PluginCatalog> {
    const state = await this.readState()
    await this.writeState({ ...state, trustedKeys: state.trustedKeys.filter((k) => k.publicKey !== publicKey) })
    return this.catalog()
  }

  /** Acrescenta um registro, depois de conferir que o índice dele é válido. */
  async addRegistry(url: string): Promise<PluginCatalog> {
    const normalized = checkRegistryUrl(url.trim()).toString()
    await fetchRegistryIndex(normalized, this.options.fetcher ?? defaultFetcher)
    const state = await this.readState()
    if (!state.registries.includes(normalized)) await this.writeState({ ...state, registries: [...state.registries, normalized] })
    return this.catalog()
  }

  async removeRegistry(url: string): Promise<PluginCatalog> {
    const state = await this.readState()
    await this.writeState({ ...state, registries: state.registries.filter((r) => r !== url) })
    return this.catalog()
  }

  /** O que cada registro configurado oferece, com as versões instaladas. */
  async browseRegistries(): Promise<PluginRegistryListing[]> {
    const [{ plugins }, state] = await Promise.all([this.catalog(), this.readState()])
    const fetcher = this.options.fetcher ?? defaultFetcher
    return Promise.all(
      state.registries.map(async (url): Promise<PluginRegistryListing> => {
        try {
          const index = await fetchRegistryIndex(url, fetcher)
          return {
            url,
            name: index.name,
            plugins: index.plugins.map((p) => {
              const latest = latestVersion(p)!
              const installed = plugins.find((i) => i.id === p.id)
              return {
                id: p.id,
                name: p.name,
                ...(p.description && { description: p.description }),
                ...(p.author && { author: p.author }),
                ...(p.homepage && { homepage: p.homepage }),
                latest: latest.version,
                versions: p.versions.map((v) => v.version),
                signed: !!latest.publicKey,
                ...(installed && { installed: installed.version }),
                ...(installed?.source === 'official' && { official: true })
              }
            })
          }
        } catch (err) {
          return { url, name: url, error: (err as Error).message, plugins: [] }
        }
      })
    )
  }

  private async extract(file: string, clear = true): Promise<string> {
    if (clear) await this.clearStaging()
    const dest = join(this.stagingDir, randomUUID())
    await mkdir(dest, { recursive: true })
    return extractArchive(file, dest, { maxFiles: MAX_INSTALL_FILES, maxBytes: MAX_INSTALL_BYTES })
  }

  private async clearStaging(): Promise<void> {
    this.pendingInstall = null
    await rm(this.stagingDir, { recursive: true, force: true })
  }

  private failedPreview(sourceDir: string, origin: PluginOrigin, problem: string): PluginInstallPreview {
    this.pendingInstall = null
    return { id: '', sourceDir, origin, signature: { status: 'unsigned' }, problems: [problem], canInstall: false, files: 0, sizeBytes: 0 }
  }

  private async preview(
    dir: string,
    origin: PluginOrigin,
    registry: { expect?: { id: string; version: string }; pinnedKey?: { publicKey: string; signer: string } } = {}
  ): Promise<PluginInstallPreview> {
    const problems: string[] = []
    const read = await readManifest(dir)
    if ('error' in read) return this.failedPreview(dir, origin, read.error)
    const { manifest } = read
    if (registry.expect && (registry.expect.id !== manifest.id || registry.expect.version !== manifest.version)) {
      problems.push(`o pacote é ${manifest.id}@${manifest.version}, mas o registro anuncia ${registry.expect.id}@${registry.expect.version}`)
    }
    const [{ plugins }, state] = await Promise.all([this.catalog(), this.readState()])
    const official = plugins.find((p) => p.id === manifest.id && p.source === 'official')
    if (official) problems.push(`o id ${manifest.id} é de um plugin oficial`)
    const userRoot = resolve(this.options.userDir)
    if (dir === userRoot || dir.startsWith(userRoot + sep)) problems.push('a pasta já está dentro da pasta de plugins instalados')
    const size = await measure(dir)
    if (size.tooLarge) problems.push(`o plugin passa de ${MAX_INSTALL_FILES} arquivos ou ${MAX_INSTALL_BYTES / 1024 / 1024} MB`)

    let check: Awaited<ReturnType<typeof verifyPluginDir>>
    try {
      check = await verifyPluginDir(dir, manifest)
    } catch (err) {
      check = { status: 'invalid', reason: (err as Error).message }
    }
    const signature = describeSignature(check, state.trustedKeys, registry.pinnedKey)
    if (check.status === 'invalid') problems.push(`assinatura inválida: ${check.reason}`)
    if (registry.pinnedKey && signature.status !== 'trusted' && check.status !== 'invalid') {
      problems.push(
        check.status === 'unsigned'
          ? `o ${registry.pinnedKey.signer} exige a assinatura do plugin, e o pacote não está assinado`
          : `o pacote foi assinado por ${signature.fingerprint}, não pela chave que o ${registry.pinnedKey.signer} fixa (${fingerprintOf(registry.pinnedKey.publicKey)})`
      )
    }
    // Atualização: quem assinou a versão instalada precisa assinar a nova.
    const installed = plugins.find((p) => p.id === manifest.id && p.source === 'user')
    const previous = installed ? await readRecord(installed.dir) : null
    if (previous?.signature.status === 'valid' && (check.status !== 'valid' || check.publicKey !== previous.signature.publicKey)) {
      problems.push(
        `a versão instalada (${installed!.version}) foi assinada por ${previous.signature.fingerprint}; esta ${check.status === 'valid' ? `é de outra chave (${check.fingerprint})` : 'não tem essa assinatura'}. Remova o plugin antes, se a troca for esperada`
      )
    }

    // Contribuições que já vêm de outro plugin ligado: o plugin instala, mas fica com erro de conflito.
    const taken = new Map<string, string>()
    for (const p of plugins) {
      if (p.id === manifest.id || !p.enabled || p.error) continue
      for (const c of p.contributions) taken.set(`${c.kind}:${c.name}`, p.name)
    }
    const conflicts = toContributions(manifest)
      .filter((c) => taken.has(`${c.kind}:${c.name}`))
      .map((c) => `${c.kind === 'node' ? 'o nó' : 'o adapter'} ${c.name} já vem de ${taken.get(`${c.kind}:${c.name}`)}`)
    const id = randomUUID()
    const canInstall = problems.length === 0
    this.pendingInstall = canInstall
      ? {
          id,
          sourceDir: dir,
          pluginId: manifest.id,
          version: manifest.version,
          origin,
          record: check.status === 'valid' ? { status: 'valid', publicKey: check.publicKey, fingerprint: check.fingerprint } : { status: 'unsigned' }
        }
      : null
    return {
      id,
      sourceDir: dir,
      origin,
      signature,
      plugin: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description && { description: manifest.description }),
        ...(manifest.author && { author: manifest.author }),
        ...(manifest.homepage && { homepage: manifest.homepage }),
        contributions: toContributions(manifest),
        ...(manifest.contributes.exporters?.length && {
          exporters: manifest.contributes.exporters.map((e) => ({ id: e.id, title: e.title, ...(e.description && { description: e.description }) }))
        }),
        ...(manifest.contributes.publishers?.length && { publishers: publisherInfo(manifest) }),
        permissions: toPermissions(manifest)
      },
      ...(installed && { replaces: installed.version }),
      conflicts,
      problems,
      canInstall,
      files: size.files,
      sizeBytes: size.bytes
    }
  }

  /** Lê as pastas uma vez e devolve o que o Context Engine precisa para rodar nós de plugin. */
  async runner(): Promise<FlowPluginRunner> {
    const { catalog, available } = await this.scan()
    return {
      find: (kind, name) => {
        const found = available.get(`${kind}:${name}`)
        if (found) return found
        const denied = this.denied.get(`${kind}:${name}`)
        if (denied) return { denied }
        const owner = catalog.plugins.find((p) => p.contributions.some((c) => c.kind === kind && c.name === name))
        const what = kind === 'node' ? `o tipo de nó ${name}` : `o adapter ${name}`
        if (!owner) return `${what} não vem de nenhum plugin instalado (Extensions Hub)`
        if (!owner.enabled) return `${what} é do plugin ${owner.name}, que está desligado no Extensions Hub`
        return `${what} é do plugin ${owner.name}, que está com erro: ${owner.error ?? 'conflito com outro plugin'}`
      },
      invoke: (pluginId, invocation) => {
        const worker = this.workers.get(pluginId)
        if (!worker) {
          return Promise.resolve({ ok: false, code: 'PLUGIN_UNAVAILABLE' as const, message: `o plugin ${pluginId} não está disponível`, logs: '', durationMs: 0 })
        }
        return worker.invoke(invocation)
      }
    }
  }

  /**
   * Exportadores da documentação dos plugins ligados (contributes.exporters). O exportador roda
   * no processo do plugin, com as mesmas permissões dos nós: recebe o pacote sem segredos e
   * devolve os arquivos; quem grava é o host (docs/export/folder.ts). Sem ctx.http.
   */
  async exporters(): Promise<PluginExporterEntry[]> {
    await this.scan()
    return this.exporterSources.map((e) => ({
      ...e,
      invoke: async (input, signal) => {
        const worker = this.workers.get(e.pluginId)
        if (!worker) throw new Error(`o plugin ${e.pluginName} não está disponível`)
        const outcome = await worker.invoke({
          kind: 'exporter',
          name: e.id,
          context: { config: {}, nodes: {}, node: { id: e.id, name: e.title }, timeoutMs: EXPORT_TIMEOUT_MS, ...input },
          ...(signal && { signal }),
          onHttp: async () => ({ ok: false, error: { code: 'POLICY_DENIED', message: 'um exportador não faz requisições pelo host' } })
        })
        if (!outcome.ok) throw new Error(`o exportador ${e.id} (${e.pluginName}) falhou: ${outcome.message}`)
        return outcome.value
      }
    }))
  }

  /**
   * Publicadores remotos dos plugins ligados (contributes.publishers). Rodam no processo do plugin
   * como os exportadores; as requisições de ctx.http vão ao onHttp de quem chama, que confere o host
   * e põe a credencial (docs/publish/plugin.ts).
   */
  async publishers(): Promise<PluginPublisherEntry[]> {
    await this.scan()
    return this.publisherSources.map((p) => ({
      ...p,
      invoke: async (op, input, onHttp, signal) => {
        const worker = this.workers.get(p.pluginId)
        if (!worker) throw new Error(`o plugin ${p.pluginName} não está disponível`)
        const outcome = await worker.invoke({
          kind: 'publisher',
          name: p.id,
          context: { config: {}, nodes: {}, node: { id: p.id, name: p.title }, timeoutMs: PUBLISHER_TIMEOUT_MS[op], op, ...input },
          ...(signal && { signal }),
          onHttp
        })
        if (!outcome.ok) throw new Error(`o publicador ${p.id} (${p.pluginName}) falhou: ${outcome.message}`)
        return outcome.value
      }
    }))
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.workers.values()].map((w) => w.terminate('o app está fechando')))
    this.workers.clear()
  }

  private async stopWorker(id: string, reason: string): Promise<void> {
    const worker = this.workers.get(id)
    this.workers.delete(id)
    await worker?.terminate(reason)
  }

  private async readState(): Promise<PluginState> {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(await readFile(this.options.stateFile, 'utf8')) as Record<string, unknown>
    } catch {
      return { disabled: [], trustedKeys: [], registries: [] }
    }
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [])
    const keys = Array.isArray(raw['trustedKeys'])
      ? (raw['trustedKeys'] as Partial<TrustedPluginKey>[]).filter(
          (k): k is TrustedPluginKey => !!k && typeof k.publicKey === 'string' && Buffer.from(k.publicKey, 'base64').length === 32
        )
      : []
    return {
      disabled: strings(raw['disabled']),
      trustedKeys: keys.map((k) => ({ publicKey: k.publicKey, fingerprint: fingerprintOf(k.publicKey), name: typeof k.name === 'string' ? k.name : '', addedAt: typeof k.addedAt === 'string' ? k.addedAt : '' })),
      registries: strings(raw['registries'])
    }
  }

  private async writeState(state: PluginState): Promise<void> {
    const out: Record<string, unknown> = { disabled: [...new Set(state.disabled)].sort() }
    if (state.trustedKeys.length) out['trustedKeys'] = state.trustedKeys
    if (state.registries.length) out['registries'] = state.registries
    await mkdir(resolve(this.options.stateFile, '..'), { recursive: true })
    await writeFile(this.options.stateFile, `${JSON.stringify(out, null, 2)}\n`)
  }

  /**
   * Oficiais primeiro, depois os do usuário em ordem alfabética. Um id repetido fica
   * com o primeiro; entre plugins ligados, um tipo de nó ou protocolo que já tem dono
   * deixa o plugin seguinte com erro de conflito (ele não roda até o conflito sumir).
   */
  private async scan(): Promise<{ catalog: PluginCatalog; available: Map<string, ResolvedContribution> }> {
    const [official, user, state] = await Promise.all([
      scanDir(this.options.officialDir, 'official'),
      scanDir(this.options.userDir, 'user'),
      this.readState()
    ])
    const disabled = new Set(state.disabled)
    const catalog: PluginCatalog = {
      plugins: [],
      issues: [],
      userDir: this.options.userDir,
      sandbox: { kernelNetwork: await netnsAvailable() },
      trustedKeys: state.trustedKeys,
      registries: state.registries
    }
    const available = new Map<string, ResolvedContribution>()
    this.denied.clear()
    const ids = new Map<string, string>()
    const iconPrefixes = new Map<string, string>()
    const diagramSources: typeof this.diagramSources = []
    const exporterSources: typeof this.exporterSources = []
    const exporterIds = new Map<string, string>()
    const publisherSources: typeof this.publisherSources = []
    for (const s of [...official, ...user]) {
      if (!s.manifest) {
        catalog.issues.push({ dir: s.dir, message: s.error ?? 'manifesto inválido' })
        continue
      }
      const { manifest } = s
      const first = ids.get(manifest.id)
      if (first) {
        catalog.issues.push({ dir: s.dir, message: `id ${manifest.id} já usado por ${first}; ignorado` })
        continue
      }
      ids.set(manifest.id, s.dir)
      const contributions = toContributions(manifest)
      const enabled = !disabled.has(manifest.id)
      let error: string | undefined
      // A organização desligou o recurso (plugins, protocolos ou scripts): o plugin não roda, mesmo ligado aqui.
      const denied = (s.source === 'user' ? featureDenial('plugins') : null) ?? contributions.map((c) => pluginContributionDenial(c.kind, c.name, s.source)).find((d) => d !== null) ?? null
      if (enabled && denied) {
        error = denied
        for (const c of contributions) this.denied.set(`${c.kind}:${c.name}`, denied)
      } else if (enabled) {
        const clash = contributions.find((c) => available.has(`${c.kind}:${c.name}`))
        if (clash) {
          error = `conflito: ${clash.kind === 'node' ? 'o nó' : 'o adapter'} ${clash.name} já vem de ${available.get(`${clash.kind}:${clash.name}`)!.pluginName}`
        }
        const iconClash = (manifest.contributes.diagrams?.iconPacks ?? []).find((p) => iconPrefixes.has(p.prefix))
        if (!error && iconClash) error = `conflito: os ícones ${iconClash.prefix}: já vêm de ${iconPrefixes.get(iconClash.prefix)}`
        // Exportadores e publicadores dividem os ids: os dois são o provider de um destino.
        const exporters = [...(manifest.contributes.exporters ?? []), ...(manifest.contributes.publishers ?? [])]
        const own = new Set<string>()
        const exporterClash = exporters.find((e) => {
          const repeated = own.has(e.id)
          own.add(e.id)
          return repeated || exporterIds.has(e.id) || BUILTIN_EXPORTERS.has(e.id)
        })
        if (!error && exporters.length > MAX_EXPORTERS) error = `o plugin declara mais de ${MAX_EXPORTERS} exportadores e publicadores`
        if (!error && exporterClash) error = `conflito: o exportador ou publicador ${exporterClash.id} já vem de ${exporterIds.get(exporterClash.id) ?? (BUILTIN_EXPORTERS.has(exporterClash.id) ? 'VVPost' : manifest.name)}`
      }
      const network = manifest.permissions?.network ?? []
      let worker = this.workers.get(manifest.id)
      // Reinstalado em outra pasta, com outro main ou outras permissões: o processo antigo não serve mais.
      if (worker && denied) {
        void worker.terminate(denied)
        this.workers.delete(manifest.id)
        worker = undefined
      }
      if (worker && (worker.entry !== s.entry || worker.sandbox.network.join('\n') !== staticNetworkRules(network).join('\n') || worker.sandbox.usesNetwork !== needsNetwork(network))) {
        void worker.terminate(`o plugin ${manifest.id} mudou`)
        worker = undefined
      }
      if (enabled && !error) {
        if (!worker) {
          worker = new PluginWorker(manifest.id, s.entry!, this.options, {
            dir: s.dir,
            network: staticNetworkRules(network),
            usesNetwork: needsNetwork(network)
          })
          this.workers.set(manifest.id, worker)
        }
        const diagrams = manifest.contributes.diagrams
        if (diagrams && (diagrams.iconPacks?.length || diagrams.blocks?.length)) {
          for (const p of diagrams.iconPacks ?? []) iconPrefixes.set(p.prefix, manifest.name)
          diagramSources.push({ id: manifest.id, name: manifest.name, dir: s.dir, diagrams })
        }
        for (const e of manifest.contributes.exporters ?? []) {
          exporterIds.set(e.id, manifest.name)
          exporterSources.push({ pluginId: manifest.id, pluginName: manifest.name, id: e.id, title: e.title, ...(e.description && { description: e.description }) })
        }
        for (const p of manifest.contributes.publishers ?? []) {
          exporterIds.set(p.id, manifest.name)
          publisherSources.push({
            pluginId: manifest.id,
            pluginName: manifest.name,
            id: p.id,
            title: p.title,
            ...(p.description && { description: p.description }),
            hosts: p.hosts.map((h) => h.toLowerCase()),
            auth: p.auth
          })
        }
        for (const c of contributions) available.set(`${c.kind}:${c.name}`, { pluginId: manifest.id, pluginName: manifest.name, contribution: c, network, connectorCredentials: manifest.permissions?.connectorCredentials === true })
      }
      const record = s.source === 'user' ? await readRecord(s.dir) : null
      catalog.plugins.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description && { description: manifest.description }),
        ...(manifest.author && { author: manifest.author }),
        ...(manifest.homepage && { homepage: manifest.homepage }),
        source: s.source,
        dir: s.dir,
        enabled,
        state: worker?.state ?? 'stopped',
        ...(error && { error }),
        ...(worker?.lastError && { lastError: worker.lastError }),
        contributions,
        ...(manifest.contributes.diagrams && {
          diagrams: {
            iconPacks: (manifest.contributes.diagrams.iconPacks ?? []).map((p) => ({ prefix: p.prefix, title: p.title })),
            blocks: manifest.contributes.diagrams.blocks?.length ?? 0
          }
        }),
        ...(manifest.contributes.exporters?.length && {
          exporters: manifest.contributes.exporters.map((e) => ({ id: e.id, title: e.title, ...(e.description && { description: e.description }) }))
        }),
        ...(manifest.contributes.publishers?.length && { publishers: publisherInfo(manifest) }),
        permissions: toPermissions(manifest),
        ...(s.source === 'user' && {
          signature: describeSignature(record?.signature ?? { status: 'unsigned' }, state.trustedKeys),
          ...(record && { origin: record.origin })
        })
      })
    }
    this.diagramSources = diagramSources
    this.exporterSources = exporterSources
    this.publisherSources = publisherSources
    return { catalog, available }
  }

  /**
   * Ícones e blocos que os plugins ligados trazem para o editor de diagramas. Só dados: nenhum
   * processo de plugin sobe para isso. O JSON de cada pacote é lido de dentro da pasta do plugin,
   * com teto de tamanho, e só os campos do formato do Iconify passam adiante (o renderer ainda
   * passa cada SVG pelo DOMPurify).
   */
  async diagramCatalog(): Promise<DiagramCatalog> {
    await this.scan()
    const out: DiagramCatalog = { iconPacks: [], blocks: [], issues: [] }
    for (const source of this.diagramSources) {
      for (const block of source.diagrams.blocks ?? []) out.blocks.push({ ...block, pluginId: source.id, pluginName: source.name })
      for (const pack of source.diagrams.iconPacks ?? []) {
        try {
          out.iconPacks.push({ prefix: pack.prefix, title: pack.title, pluginId: source.id, pluginName: source.name, icons: await readIconPack(source.dir, pack.file, pack.prefix) })
        } catch (err) {
          out.issues.push({ pluginId: source.id, message: `ícones ${pack.prefix} (${pack.file}): ${(err as Error).message}` })
        }
      }
    }
    return out
  }
}

/** Lê um pacote Iconify da pasta do plugin, só com os campos do formato. */
async function readIconPack(dir: string, file: string, prefix: string): Promise<DiagramIconPack['icons']> {
  const root = await realpath(dir)
  const path = await realpath(resolve(root, file)).catch(() => null)
  if (!path || !path.startsWith(root + sep)) throw new Error('arquivo ausente ou fora da pasta do plugin')
  const info = await stat(path)
  if (!info.isFile()) throw new Error('não é um arquivo')
  if (info.size > MAX_ICON_PACK_BYTES) throw new Error('passa de 4 MB')
  let doc: unknown
  try {
    doc = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    throw new Error(`JSON inválido (${(err as Error).message})`)
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000 ? v : undefined)
  if (!isRecord(doc) || !isRecord(doc['icons'])) throw new Error('não está no formato do Iconify (falta icons)')
  const names = Object.keys(doc['icons'])
  if (names.length > MAX_ICONS_PER_PACK) throw new Error(`mais de ${MAX_ICONS_PER_PACK} ícones`)
  const icons: Record<string, DiagramIcon> = {}
  for (const name of names) {
    const icon = doc['icons'][name]
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !isRecord(icon) || typeof icon['body'] !== 'string' || icon['body'].length > MAX_ICON_BODY) continue
    const size = { width: num(icon['width']), height: num(icon['height']), left: num(icon['left']), top: num(icon['top']) }
    icons[name] = { body: icon['body'], ...Object.fromEntries(Object.entries(size).filter(([, v]) => v !== undefined)) }
  }
  if (!Object.keys(icons).length) throw new Error('nenhum ícone válido')
  const aliases: Record<string, { parent: string }> = {}
  if (isRecord(doc['aliases'])) {
    for (const [name, alias] of Object.entries(doc['aliases'])) {
      if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && isRecord(alias) && typeof alias['parent'] === 'string' && alias['parent'] in icons) aliases[name] = { parent: alias['parent'] }
    }
  }
  const width = num(doc['width'])
  const height = num(doc['height'])
  return { prefix, icons, ...(Object.keys(aliases).length && { aliases }), ...(width && { width }), ...(height && { height }) }
}
