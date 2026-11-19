import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type {
  PluginCatalog,
  PluginContribution,
  PluginInfo,
  PluginInstallPreview,
  PluginRegistryListing,
  WorkspaceResult
} from '@shared/ipc'
import { Copy, FolderOpen, Power, PowerOff, Trash2 } from 'lucide-react'
import {
  buttonClass as buttonClassFor,
  separator,
  Shortcut,
  useContextMenu,
  useMenuCommands,
  usePromptDialog,
  type ContextMenuEntries
} from '../../design-system'

const buttonClass = buttonClassFor('secondary', 'sm')
const primaryClass = buttonClassFor('primary', 'sm')
const DOCS_URL = 'https://github.com/victorverdoodt/vvpost-community/blob/main/docs/plugins.md'

const STATE_LABEL: Record<PluginInfo['state'], string> = {
  stopped: 'processo parado',
  starting: 'processo subindo',
  running: 'processo ativo'
}

type Signature = NonNullable<PluginInfo['signature']>

const ORIGIN_LABEL: Record<NonNullable<PluginInfo['origin']>['kind'], string> = {
  folder: 'pasta',
  archive: 'arquivo',
  registry: 'registro'
}

/**
 * Extensions Hub (Plugin SDK): os plugins oficiais e os instalados, o que
 * cada um contribui ao Flow Studio, ligar e desligar, e instalar de uma pasta, de um
 * pacote (.zip, .tgz) ou de um registro, com uma prévia (permissões e assinatura) antes
 * de copiar. O código de um plugin só roda quando um nó dele roda.
 */
export default function ExtensionsModule() {
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [preview, setPreview] = useState<PluginInstallPreview | null>(null)
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [trustKey, setTrustKey] = useState(false)
  const [registries, setRegistries] = useState<PluginRegistryListing[] | null>(null)
  const [registryUrl, setRegistryUrl] = useState('')

  const apply = useCallback((result: WorkspaceResult<PluginCatalog>, info?: string) => {
    if (!result.ok) return setMessage({ kind: 'error', text: result.message })
    setCatalog(result.value)
    setMessage(info ? { kind: 'info', text: info } : null)
  }, [])

  const reload = useCallback(
    () =>
      void window.vvpost
        .listPlugins()
        .then((r) => (r.ok ? setCatalog(r.value) : setMessage({ kind: 'error', text: r.message }))),
    []
  )
  useEffect(() => {
    reload()
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    try {
      await task()
    } finally {
      setBusy(false)
    }
  }

  const showPreview = (result: WorkspaceResult<PluginInstallPreview | null>) => {
    if (!result.ok) return setMessage({ kind: 'error', text: result.message })
    if (result.value) {
      setPreview(result.value)
      setTrustKey(false)
      setMessage(null)
    }
  }
  const pick = () => run(async () => showPreview(await window.vvpost.previewPluginInstall()))
  const pickArchive = () => run(async () => showPreview(await window.vvpost.previewPluginArchive()))
  const pickFromRegistry = (url: string, id: string) => run(async () => showPreview(await window.vvpost.previewPluginFromRegistry(url, id)))

  const browse = useCallback(
    () =>
      void window.vvpost.browsePluginRegistries().then((r) => (r.ok ? setRegistries(r.value) : setMessage({ kind: 'error', text: r.message }))),
    []
  )
  const registryCount = catalog?.registries.length ?? 0
  useEffect(() => {
    if (registryCount) browse()
    else setRegistries([])
  }, [registryCount, browse])

  const addRegistry = () =>
    run(async () => {
      const url = registryUrl.trim()
      if (!url) return
      const result = await window.vvpost.addPluginRegistry(url)
      apply(result, 'Registro adicionado.')
      if (result.ok) {
        setRegistryUrl('')
        browse()
      }
    })
  const removeRegistry = (url: string) =>
    run(async () => {
      apply(await window.vvpost.removePluginRegistry(url), 'Registro removido.')
      browse()
    })
  const untrust = (publicKey: string, name: string) =>
    run(async () => apply(await window.vvpost.untrustPluginKey(publicKey), `A chave de ${name} deixou de ser confiável.`))

  const install = () =>
    run(async () => {
      if (!preview?.plugin) return
      const name = `${preview.plugin.name} ${preview.plugin.version}`
      const result = await window.vvpost.installPlugin(preview.id, { trustKey: trustKey && preview.signature.status === 'untrusted' })
      apply(result, `${name} instalado.`)
      setPreview(null)
      if (result.ok && registryCount) browse()
    })

  // Menu de contexto de cada plugin (o mesmo do cartão, mais copiar e revelar).
  const ctx = useContextMenu()
  const dialog = usePromptDialog()
  const toggle = (p: PluginInfo, enabled: boolean) => void run(async () => apply(await window.vvpost.setPluginEnabled(p.id, enabled)))
  const remove = async (p: PluginInfo) => {
    const ok = await dialog.confirm({ title: `Remover ${p.name}?`, message: 'A pasta do plugin é apagada; fluxos com nós dele deixam de rodar.', confirmLabel: 'Remover', danger: true })
    if (ok) await run(async () => apply(await window.vvpost.removePlugin(p.id), `${p.name} removido.`))
  }
  const pluginEntries = (p: PluginInfo): ContextMenuEntries => [
    p.enabled
      ? { id: 'disable', label: 'Desligar', icon: <PowerOff size={14} aria-hidden />, disabled: busy, run: () => toggle(p, false) }
      : { id: 'enable', label: 'Ligar', icon: <Power size={14} aria-hidden />, disabled: busy, run: () => toggle(p, true) },
    separator,
    { id: 'copy-id', label: 'Copiar o id', icon: <Copy size={14} aria-hidden />, shortcut: Shortcut.copy, run: () => void navigator.clipboard.writeText(p.id).then(() => setMessage({ kind: 'info', text: 'Id copiado na área de transferência.' })) },
    {
      id: 'reveal',
      label: 'Revelar a pasta',
      icon: <FolderOpen size={14} aria-hidden />,
      shortcut: Shortcut.reveal,
      run: () => void window.vvpost.revealInFolder({ pluginId: p.id }).then((r) => {
        if (!r.ok) setMessage({ kind: 'error', text: r.message })
      })
    },
    p.source === 'user' && separator,
    p.source === 'user' && { id: 'remove', label: 'Remover…', icon: <Trash2 size={14} aria-hidden />, shortcut: Shortcut.remove, danger: true, disabled: busy, run: () => void remove(p) }
  ]
  useMenuCommands('Extensões', [
    { id: 'install', label: 'Instalar plugin de uma pasta…', disabled: busy, run: () => void pick() },
    { id: 'install-archive', label: 'Instalar plugin de um arquivo (.zip, .tgz)…', disabled: busy, run: () => void pickArchive() }
  ])

  const plugins = catalog?.plugins ?? []
  const official = plugins.filter((p) => p.source === 'official')
  const user = plugins.filter((p) => p.source === 'user')

  return (
    <div className="flex h-full flex-col overflow-auto p-6">
      <header className="flex items-start gap-4">
        <div className="flex-1">
          <h1 className="text-base font-semibold">Extensions Hub</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Plugins acrescentam tipos de nó ao Flow Studio e protocolos ao Quick Request e aos cenários. Cada plugin
            roda num processo próprio, com as permissões que declara, que sobe quando é usado e para depois de um
            minuto sem uso.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void pickArchive()}>
            Instalar de arquivo…
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void pick()}>
            Instalar de pasta…
          </button>
        </div>
      </header>

      <TrustNotice kernelNetwork={catalog?.sandbox.kernelNetwork ?? false} />

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`mt-3 text-sm ${message.kind === 'error' ? 'text-danger' : 'text-success'}`}
        >
          {message.text}
        </p>
      )}

      {preview && (
        <InstallPreview
          preview={preview}
          busy={busy}
          trustKey={trustKey}
          onTrustKey={setTrustKey}
          onInstall={() => void install()}
          onCancel={() => setPreview(null)}
        />
      )}

      <Section title="Oficiais" empty="Nenhum plugin oficial encontrado.">
        {official.map((p) => (
          <PluginCard
            key={p.id}
            plugin={p}
            busy={busy}
            onToggle={(enabled) => toggle(p, enabled)}
            menu={ctx.bind(`Plugin ${p.name}`, () => pluginEntries(p))}
          />
        ))}
      </Section>

      <Section
        title="Instalados"
        empty="Nenhum plugin instalado. Instale de um registro, de um pacote .zip/.tgz ou da pasta de um plugin (com vvpost-plugin.json)."
      >
        {user.map((p) => (
          <PluginCard
            key={p.id}
            plugin={p}
            busy={busy}
            onToggle={(enabled) => toggle(p, enabled)}
            onRemove={() => void remove(p)}
            menu={ctx.bind(`Plugin ${p.name}`, () => pluginEntries(p))}
          />
        ))}
      </Section>

      <section aria-label="Registros" className="mt-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Registros</h2>
        <form
          className="flex max-w-3xl gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void addRegistry()
          }}
        >
          <input
            aria-label="URL do registro"
            className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs"
            placeholder="https://plugins.example.com/vvpost-registry.json"
            value={registryUrl}
            onChange={(e) => setRegistryUrl(e.target.value)}
          />
          <button type="submit" className={buttonClass} disabled={busy || !registryUrl.trim()}>
            Adicionar registro
          </button>
        </form>
        {!registryCount && (
          <p className="mt-2 text-sm text-muted">
            Nenhum registro. Um registro é um índice JSON (vvpost-registry.json) com os plugins, as versões e o SHA-256 de
            cada pacote, e pode fixar a chave que assina cada plugin.
          </p>
        )}
        {(registries ?? []).map((r) => (
          <RegistryCard key={r.url} registry={r} busy={busy} onInstall={(id) => void pickFromRegistry(r.url, id)} onRemove={() => void removeRegistry(r.url)} />
        ))}
      </section>

      {!!catalog?.trustedKeys.length && (
        <section aria-label="Chaves confiáveis" className="mt-6 text-xs">
          <h2 className="mb-2 font-semibold uppercase tracking-wide text-muted">Chaves confiáveis</h2>
          <ul className="flex max-w-3xl flex-col gap-1">
            {catalog.trustedKeys.map((k) => (
              <li key={k.publicKey} className="flex items-center gap-2">
                <span className="font-medium">{k.name}</span>
                <span className="font-mono text-muted">{k.fingerprint}</span>
                <button
                  type="button"
                  className="ml-auto text-danger hover:underline disabled:opacity-40"
                  disabled={busy}
                  aria-label={`Deixar de confiar na chave de ${k.name}`}
                  onClick={() => void untrust(k.publicKey, k.name)}
                >
                  Deixar de confiar
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!catalog?.issues.length && (
        <section aria-label="Pastas ignoradas" className="mt-6 text-xs">
          <h2 className="mb-2 font-semibold uppercase tracking-wide text-muted">Pastas ignoradas</h2>
          <ul className="flex flex-col gap-1 text-warning">
            {catalog.issues.map((i) => (
              <li key={i.dir}>
                <span className="font-mono">{i.dir}</span>: {i.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {catalog && (
        <p className="mt-6 text-xs text-muted">
          Plugins instalados ficam em <span className="font-mono">{catalog.userDir}</span>.
        </p>
      )}
      {ctx.menu}
      {dialog.element}
    </div>
  )
}

function TrustNotice({ kernelNetwork }: { kernelNetwork: boolean }) {
  return (
    <aside
      aria-label="Modelo de confiança"
      className="mt-4 max-w-3xl rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-muted"
    >
      <p className="font-semibold text-warning">Instale só plugins em que você confia</p>
      <p className="mt-1">
        Cada plugin roda num processo com permissões do Node: lê só a própria pasta, não grava arquivos nem abre
        programas, e só conecta aos hosts que o manifesto declara (abaixo de cada plugin). Sem rede declarada, as
        requisições dele saem só pelo VVPost, com a auth do conector aplicada fora do plugin
        {kernelNetwork ? ', e o sistema operacional também corta a rede do processo' : ''}. Plugins nunca são carregados
        de um workspace clonado e as variáveis de ambiente do app não chegam a eles. A barreira é do runtime: código feito
        para burlá-la é um risco que só a confiança no autor resolve.{' '}
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          Modelo de confiança e guia do SDK
        </a>
      </p>
    </aside>
  )
}

/** Assinatura do plugin: quem assinou e se a chave é confiável. */
function SignatureLine({ signature, preview = false }: { signature: Signature; preview?: boolean }) {
  const [text, tone] =
    signature.status === 'trusted'
      ? [`assinado por ${signature.signer} (${signature.fingerprint})`, 'text-success']
      : signature.status === 'untrusted'
        ? [`assinado por uma chave que você ainda não marcou como confiável (${signature.fingerprint})`, 'text-warning']
        : signature.status === 'invalid'
          ? [`inválida: ${signature.reason}`, 'text-danger']
          : [preview ? 'sem assinatura: nada garante quem escreveu o plugin nem que ele não mudou' : 'sem assinatura', preview ? 'text-warning' : 'text-muted']
  return (
    <p aria-label="Assinatura" className={`mt-2 text-xs ${tone}`}>
      <span className="font-medium">Assinatura: </span>
      {text}
    </p>
  )
}

function RegistryCard({
  registry,
  busy,
  onInstall,
  onRemove
}: {
  registry: PluginRegistryListing
  busy: boolean
  onInstall(id: string): void
  onRemove(): void
}) {
  return (
    <article aria-label={`Registro ${registry.name}`} className="mt-3 max-w-3xl rounded-md border border-border bg-panel p-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{registry.name}</h3>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{registry.url}</span>
        <button type="button" className="text-xs text-danger hover:underline disabled:opacity-40" disabled={busy} onClick={onRemove}>
          Remover registro
        </button>
      </div>
      {registry.error && <p className="mt-2 text-xs text-danger">{registry.error}</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {registry.plugins.map((p) => {
          const upToDate = p.installed === p.latest
          const label = p.official ? 'Oficial' : upToDate ? 'Instalado' : p.installed ? `Atualizar para ${p.latest}` : 'Instalar'
          return (
            <li key={p.id} aria-label={`${p.name} no registro`} className="flex items-start gap-3 text-xs">
              <div className="min-w-0 flex-1">
                <span className="font-medium">{p.name}</span> <span className="text-muted">{p.latest}</span>
                {p.signed && <span className="ml-1 rounded border border-success/50 px-1 text-[10px] text-success">assinatura fixada</span>}
                <span className="block font-mono text-[11px] text-muted">
                  {p.id}
                  {p.author ? ` · ${p.author}` : ''}
                  {p.installed && !upToDate ? ` · instalado ${p.installed}` : ''}
                </span>
                {p.description && <span className="block text-muted">{p.description}</span>}
              </div>
              <button
                type="button"
                className={buttonClass}
                aria-label={`${label}: ${p.name}`}
                disabled={busy || upToDate || p.official}
                onClick={() => onInstall(p.id)}
              >
                {label}
              </button>
            </li>
          )
        })}
      </ul>
    </article>
  )
}

function Section({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <section aria-label={title} className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {children.length ? (
        <div className="grid gap-3 xl:grid-cols-2">{children}</div>
      ) : (
        <p className="text-sm text-muted">{empty}</p>
      )}
    </section>
  )
}

function Contributions({
  items,
  exporters = [],
  publishers = []
}: {
  items: PluginContribution[]
  exporters?: { id: string; title: string; description?: string }[]
  publishers?: { id: string; title: string; description?: string; hosts: string[] }[]
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1 text-xs">
      {publishers.map((p) => (
        <li key={`publisher:${p.id}`} className="flex gap-2">
          <span className="w-16 shrink-0 text-muted">publicador</span>
          <span>
            <span className="font-medium">{p.title}</span> <span className="font-mono text-muted">{p.id}</span>
            <span className="block text-muted">{p.description ? `${p.description} · ` : ''}publica em {p.hosts.join(', ')}</span>
          </span>
        </li>
      ))}
      {exporters.map((e) => (
        <li key={`exporter:${e.id}`} className="flex gap-2">
          <span className="w-16 shrink-0 text-muted">exportador</span>
          <span>
            <span className="font-medium">{e.title}</span> <span className="font-mono text-muted">{e.id}</span>
            {e.description && <span className="block text-muted">{e.description}</span>}
          </span>
        </li>
      ))}
      {items.map((c) => (
        <li key={`${c.kind}:${c.name}`} className="flex gap-2">
          <span className="w-16 shrink-0 text-muted">{c.kind === 'node' ? 'nó' : 'adapter'}</span>
          <span>
            <span className="font-medium">{c.title}</span> <span className="font-mono text-muted">{c.name}</span>
            {c.description && <span className="block text-muted">{c.description}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Rede que o plugin declara (permissions.network do manifesto). */
function Permissions({ summary }: { summary: string[] }) {
  const open = summary.some((s) => s.startsWith('qualquer host'))
  return (
    <p aria-label="Permissões de rede" className={`mt-2 text-xs ${open ? 'text-warning' : 'text-muted'}`}>
      <span className="font-medium">Rede: </span>
      {summary.length ? summary.join(', ') : 'nenhuma própria (só requisições pelo VVPost)'}
    </p>
  )
}

function PluginCard({
  plugin,
  busy,
  onToggle,
  onRemove,
  menu
}: {
  plugin: PluginInfo
  busy: boolean
  onToggle(enabled: boolean): void
  onRemove?(): void
  menu: ReturnType<ReturnType<typeof useContextMenu>['bind']>
}) {
  return (
    <article aria-label={`Plugin ${plugin.name}`} {...menu} className="rounded-md border border-border bg-panel p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-sm font-semibold">{plugin.name}</h3>
            <span className="text-xs text-muted">{plugin.version}</span>
            <span className="rounded border border-border px-1 text-[10px] uppercase text-muted">
              {plugin.source === 'official' ? 'oficial' : 'instalado'}
            </span>
            <span aria-label={`Estado de ${plugin.name}`} className="text-[11px] text-muted">
              {plugin.enabled ? STATE_LABEL[plugin.state] : 'desligado'}
            </span>
          </div>
          <p className="font-mono text-[11px] text-muted">
            {plugin.id}
            {plugin.author ? ` · ${plugin.author}` : ''}
          </p>
          {plugin.description && <p className="mt-1 text-xs text-muted">{plugin.description}</p>}
        </div>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            aria-label={`Ligar ${plugin.name}`}
            checked={plugin.enabled}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          Ligado
        </label>
      </div>
      {plugin.error && <p className="mt-2 text-xs text-danger">{plugin.error}</p>}
      {plugin.lastError && !plugin.error && (
        <p className="mt-2 text-xs text-warning">Última falha do processo: {plugin.lastError}</p>
      )}
      <Contributions items={plugin.contributions} {...(plugin.exporters && { exporters: plugin.exporters })} {...(plugin.publishers && { publishers: plugin.publishers })} />
      <Permissions summary={plugin.permissions.summary} />
      {plugin.signature && <SignatureLine signature={plugin.signature} />}
      {plugin.origin && (
        <p className="mt-1 truncate text-[11px] text-muted" title={plugin.origin.location}>
          Instalado de {ORIGIN_LABEL[plugin.origin.kind]}: <span className="font-mono">{plugin.origin.registry ?? plugin.origin.location}</span>
        </p>
      )}
      {onRemove && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="text-xs text-danger hover:underline disabled:opacity-40"
            disabled={busy}
            onClick={onRemove}
          >
            Remover
          </button>
        </div>
      )}
    </article>
  )
}

function InstallPreview({
  preview,
  busy,
  trustKey,
  onTrustKey,
  onInstall,
  onCancel
}: {
  preview: PluginInstallPreview
  busy: boolean
  trustKey: boolean
  onTrustKey(trust: boolean): void
  onInstall(): void
  onCancel(): void
}) {
  const p = preview.plugin
  return (
    <section
      role="dialog"
      aria-label="Instalar plugin"
      className="mt-4 max-w-3xl rounded-md border border-accent/60 bg-panel p-4"
    >
      <h2 className="text-sm font-semibold">
        {p ? `Instalar ${p.name} ${p.version}` : 'Não foi possível ler o plugin'}
        {preview.replaces && <span className="font-normal text-muted"> (substitui a versão {preview.replaces})</span>}
      </h2>
      <p className="mt-1 break-all font-mono text-[11px] text-muted">
        {ORIGIN_LABEL[preview.origin.kind]}: {preview.origin.location}
      </p>
      {p && (
        <>
          <p className="mt-1 text-xs text-muted">
            {p.id}
            {p.author ? ` · ${p.author}` : ''} · {preview.files} arquivos,{' '}
            {Math.max(1, Math.round(preview.sizeBytes / 1024))} KB
          </p>
          {p.description && <p className="mt-2 text-xs">{p.description}</p>}
          <Contributions items={p.contributions} {...(p.exporters && { exporters: p.exporters })} {...(p.publishers && { publishers: p.publishers })} />
          <Permissions summary={p.permissions.summary} />
          {preview.signature.status !== 'invalid' && <SignatureLine signature={preview.signature} preview />}
          {preview.canInstall && preview.signature.status === 'untrusted' && (
            <label className="mt-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={trustKey} disabled={busy} onChange={(e) => onTrustKey(e.target.checked)} />
              Confiar nesta chave ({p.author ?? p.name}): as próximas versões assinadas por ela aparecem como confiáveis
            </label>
          )}
        </>
      )}
      {preview.problems.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-danger">
          {preview.problems.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {!!preview.conflicts?.length && (
        <ul className="mt-2 list-disc pl-5 text-xs text-warning">
          {preview.conflicts.map((m) => (
            <li key={m}>{m}: o plugin fica com erro até você desligar o outro.</li>
          ))}
        </ul>
      )}
      {preview.canInstall && (
        <p className="mt-3 text-xs text-warning">
          Ao instalar, o código do plugin roda sempre que um nó dele rodar num fluxo, com as permissões acima.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" className={primaryClass} disabled={busy || !preview.canInstall} onClick={onInstall}>
          Instalar
        </button>
        <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </section>
  )
}
