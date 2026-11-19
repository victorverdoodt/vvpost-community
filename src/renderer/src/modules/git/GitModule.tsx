import { useEffect, useState } from 'react'
import type { FileDiff, GitChange, GitSyncAction, WorkspaceResult, WorkspaceState } from '@shared/ipc'
import { ConflictView } from './ConflictView'
import { DiffView } from './DiffView'
import { SecretsWizard } from './SecretsWizard'
import { Check, Copy, FileDiff as FileDiffIcon, FolderOpen, GitBranch, GitBranchPlus, RotateCcw, Square, SquareCheck } from 'lucide-react'
import {
  Button,
  buttonClass as buttonClassFor,
  ErrorNotice,
  separator,
  Shortcut,
  useContextMenu,
  useMenuCommands,
  usePromptDialog,
  WorkspaceTabs,
  DockablePane,
  type ContextMenuEntries
} from '../../design-system'
import { navigate } from '../../lib/navigate'

const buttonClass = buttonClassFor('secondary', 'md')
const primaryClass = buttonClassFor('primary', 'md')
const inputClass = 'h-8 border px-2.5 text-xs'
const icon = { size: 14, 'aria-hidden': true } as const

/** O módulo que edita o arquivo: conector no Catálogo, fluxo no Flow Studio. */
async function openInModule(path: string): Promise<string | null> {
  if (path.endsWith('.connector.vvpost.json')) {
    const r = await window.vvpost.getConnectorRegistry()
    const c = r.ok ? r.value?.connectors.find((x) => x.file === path) : undefined
    if (!c) return 'O conector deste arquivo não está no catálogo (inválido ou apagado).'
    navigate({ module: 'catalog', connectorId: c.id })
    return null
  }
  if (path.endsWith('.flow.vvpost.json')) {
    const r = await window.vvpost.listFlows()
    const f = r.ok ? r.value?.flows.find((x) => x.file === path) : undefined
    if (!f) return 'O fluxo deste arquivo não abre (inválido ou apagado).'
    navigate({ module: 'flows', flowId: f.flow.id })
    return null
  }
  return 'Este arquivo não abre em nenhum módulo.'
}
const moduleFor = (path: string) =>
  path.endsWith('.connector.vvpost.json') ? 'Catálogo' : path.endsWith('.flow.vvpost.json') ? 'Flow Studio' : null

const KIND_LABEL: Record<GitChange['kind'], { letter: string; title: string; color: string }> = {
  modified: { letter: 'M', title: 'Modificado', color: 'text-warning' },
  added: { letter: 'A', title: 'Adicionado', color: 'text-success' },
  untracked: { letter: 'U', title: 'Novo, fora do Git', color: 'text-success' },
  deleted: { letter: 'D', title: 'Apagado', color: 'text-danger' },
  renamed: { letter: 'R', title: 'Renomeado', color: 'text-info' },
  conflicted: { letter: '!', title: 'Em conflito', color: 'text-danger' }
}

type Message = { tone: 'ok' | 'error'; text: string }

/** Git Workspace: a pasta do projeto é o repositório Git. */
export default function GitModule() {
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [wizard, setWizard] = useState(false)

  /** Roda a operação, aplica o novo estado e mostra o erro, se houver. */
  const run = async <T,>(
    task: () => Promise<WorkspaceResult<T>>,
    onOk?: (value: T) => WorkspaceState | null | undefined | void,
    success?: string | ((value: T) => string)
  ) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await task()
      if (!result.ok) return setMessage({ tone: 'error', text: result.message })
      const next = onOk ? onOk(result.value) : (result.value as unknown as WorkspaceState | null)
      if (next !== undefined) setState(next)
      if (success) setMessage({ tone: 'ok', text: typeof success === 'string' ? success : success(result.value) })
      return result.value
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void window.vvpost.getWorkspace().then((r) => {
      if (r.ok) setState(r.value)
      else setMessage({ tone: 'error', text: r.message })
      setLoaded(true)
    })
  }, [])

  const refresh = () => run(() => window.vvpost.getWorkspace())
  const open = () =>
    run(
      () => window.vvpost.openWorkspace(),
      (s) => s ?? undefined
    )
  const clone = (url: string) =>
    run(
      () => window.vvpost.cloneWorkspace(url),
      (s) => {
        if (!s) return undefined
        // Logo depois do clone, o wizard pede os segredos que o repositório espera.
        if (s.missingSecrets.length) setWizard(true)
        return s
      },
      (s) => (s ? `Clonado em ${s.dir}` : '')
    )

  if (!loaded) return null

  return (
    <div className="relative flex h-full flex-col">
      {!state ? (
        <Start busy={busy} onOpen={() => void open()} onClone={(url) => void clone(url)} />
      ) : (
        <Workspace
          state={state}
          busy={busy}
          run={run}
          onOpen={() => void open()}
          onRefresh={() => void refresh()}
          onWizard={() => setWizard(true)}
          onMessage={setMessage}
        />
      )}
      {message?.tone === 'error' && (
        <div className="border-t border-border px-4 py-2">
          <ErrorNotice
            compact
            title="Falha no Git"
            code="GIT_ERROR"
            message={message.text}
            location={state?.branch ?? state?.dir}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setMessage(null)}>
                Dispensar
              </Button>
            }
          />
        </div>
      )}
      {message?.tone === 'ok' && (
        <div role="status" className="border-t border-border px-6 py-2 text-xs whitespace-pre-wrap text-success">
          {message.text}
        </div>
      )}
      {wizard && state && state.missingSecrets.length > 0 && (
        <SecretsWizard
          missing={state.missingSecrets}
          onDone={(next, error) => {
            setWizard(false)
            if (next) {
              setState(next)
              setMessage({ tone: 'ok', text: 'Segredos salvos no cofre local (cifrado, fora da pasta do projeto).' })
            }
            if (error) setMessage({ tone: 'error', text: error })
          }}
        />
      )}
    </div>
  )
}

function Start(props: { busy: boolean; onOpen: () => void; onClone: (url: string) => void }) {
  const [url, setUrl] = useState('')
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex w-full max-w-lg flex-col gap-6">
        <div>
          <h1 className="text-base font-semibold">Git Workspace</h1>
          <p className="mt-1 text-sm text-muted">
            O workspace é uma pasta com conectores e ambientes em JSON, versionada com o Git. Segredos são commitados
            como <span className="font-mono">__REQUIRED_SECRET__</span> e os valores ficam só na sua máquina.
          </p>
        </div>
        <button type="button" className={`${buttonClass} self-start`} disabled={props.busy} onClick={props.onOpen}>
          Abrir pasta…
        </button>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            props.onClone(url)
          }}
        >
          <label htmlFor="clone-url" className="text-xs font-semibold tracking-wide text-muted uppercase">
            Clonar repositório
          </label>
          <div className="flex gap-2">
            <input
              id="clone-url"
              className={`${inputClass} flex-1 font-mono`}
              placeholder="https://github.com/empresa/apis.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" className={buttonClass} disabled={props.busy || !url.trim()}>
              Clonar…
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

type Run = <T>(
  task: () => Promise<WorkspaceResult<T>>,
  onOk?: (value: T) => WorkspaceState | null | undefined | void,
  success?: string | ((value: T) => string)
) => Promise<T | undefined | void>

function Workspace(props: {
  state: WorkspaceState
  busy: boolean
  run: Run
  onOpen: () => void
  onRefresh: () => void
  onWizard: () => void
  onMessage: (message: Message) => void
}) {
  const { state, busy, run } = props
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // Abas dos arquivos abertos (diffs e conflitos); focused é a aba ativa.
  const [tabs, setTabs] = useState<string[]>([])
  const [focused, setFocused] = useState<string | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [newBranch, setNewBranch] = useState<string | null>(null)

  // Mudanças novas entram marcadas para o commit; as que sumiram saem da seleção e das abas.
  const paths = state.changes.map((c) => c.path).join('\0')
  useEffect(() => {
    setSelected(new Set(state.changes.filter((c) => c.kind !== 'conflicted').map((c) => c.path)))
    const left = tabs.filter((t) => state.changes.some((c) => c.path === t))
    if (left.length !== tabs.length) setTabs(left)
    if (focused && !left.includes(focused)) {
      setFocused(left.at(-1) ?? null)
      setDiff(null)
    }
  }, [paths])

  const isConflicted = (path: string | null) => state.changes.some((c) => c.path === path && c.kind === 'conflicted')

  const showDiff = async (path: string) => {
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setFocused(path)
    if (isConflicted(path)) return setDiff(null)
    const r = await window.vvpost.diffFile(path)
    setDiff(r.ok ? r.value : null)
  }
  const closeTab = (path: string) => {
    const i = tabs.indexOf(path)
    const left = tabs.filter((t) => t !== path)
    setTabs(left)
    if (focused !== path) return
    const next = left[Math.min(i, left.length - 1)]
    if (next) void showDiff(next)
    else {
      setFocused(null)
      setDiff(null)
    }
  }
  const tabEntries = (path: string): ContextMenuEntries => [
    { id: 'close', label: 'Fechar a aba', run: () => closeTab(path) },
    {
      id: 'close-others',
      label: 'Fechar as outras abas',
      disabled: tabs.length < 2,
      run: () => {
        setTabs([path])
        if (focused !== path) void showDiff(path)
      }
    },
    {
      id: 'close-all',
      label: 'Fechar todas as abas',
      run: () => {
        setTabs([])
        setFocused(null)
        setDiff(null)
      }
    },
    separator,
    { id: 'copy-path', label: 'Copiar o caminho', icon: <Copy {...icon} />, run: () => copy(path, 'Caminho copiado') }
  ]
  // O diff aberto acompanha o estado: depois de atualizar, mostra o conteúdo novo.
  useEffect(() => {
    if (focused && state.changes.some((c) => c.path === focused)) void showDiff(focused)
  }, [state])

  const unredacted = new Map(state.unredacted.map((u) => [u.file, u.variables]))
  const local = state.branches.filter((b) => !b.remote)
  const remote = state.branches.filter((b) => b.remote)

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const commit = () =>
    run(
      () => window.vvpost.commit(commitMessage, [...selected]),
      (out) => {
        setCommitMessage('')
        return out.state
      },
      (out) =>
        (out.commit ? `Commit ${out.commit} com ${out.committed.length} arquivo(s).` : 'Sem commit: depois de redigir os segredos, os arquivos ficaram iguais ao último commit.') +
        (out.redacted.length
          ? ` Segredos redigidos: ${out.redacted.map((r) => `${r.file} (${r.variables.join(', ')})`).join('; ')}.`
          : '')
    )

  const sync = (action: GitSyncAction, label: string) =>
    run(
      () => window.vvpost.sync(action),
      undefined,
      (s) =>
        action === 'pull' && s.operation === 'merge'
          ? `O pull trouxe conflitos em ${s.changes.filter((c) => c.kind === 'conflicted').length} arquivo(s). Resolva cada um e conclua o merge.`
          : label
    )

  const conflicts = state.changes.filter((c) => c.kind === 'conflicted').length
  const resolve = (path: string, resolution: Parameters<typeof window.vvpost.resolveConflict>[1], label: string) =>
    run(
      () => window.vvpost.resolveConflict(path, resolution),
      (s) => {
        // Abre o próximo arquivo em conflito, se houver.
        const next = s.changes.find((c) => c.kind === 'conflicted')
        if (next) void showDiff(next.path)
        else setFocused(path)
        return s
      },
      label
    )

  // Menus de contexto: arquivos alterados, branches e (na paleta) as ações do cabeçalho.
  const ctx = useContextMenu()
  const dialog = usePromptDialog()
  const say = (text: string, tone: Message['tone'] = 'ok') => props.onMessage({ tone, text })
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(() => say(`${what} na área de transferência.`), () => say('Não deu para copiar.', 'error'))
  const checkout = (name: string) => run(() => window.vvpost.checkoutBranch(name), undefined, `Na branch ${name}.`)
  const branchFrom = async (from: string) => {
    const name = await dialog.prompt({
      title: `Nova branch a partir de ${from}`,
      label: 'Nome da branch',
      initial: 'feature/',
      confirmLabel: 'Criar',
      validate: (v) => (state.branches.some((b) => b.name === v) ? 'Já existe uma branch com esse nome.' : /\s|\.\.|^[-/]|\/$/.test(v) ? 'Nome de branch inválido.' : undefined)
    })
    if (!name) return
    if (from !== state.branch && !(await checkout(from))) return
    await run(() => window.vvpost.createBranch(name), undefined, `Branch ${name} criada a partir de ${from}.`)
  }
  const discard = async (files: GitChange[]) => {
    const names = files.map((c) => c.path)
    const ok = await dialog.confirm({
      title: files.length === 1 ? `Descartar as mudanças em ${names[0]}?` : `Descartar as mudanças em ${files.length} arquivos?`,
      message: `${files.some((c) => c.kind === 'untracked' || c.kind === 'added') ? 'Arquivos novos são apagados. ' : ''}Isso não dá para desfazer.`,
      confirmLabel: 'Descartar',
      danger: true
    })
    if (ok) await run(() => window.vvpost.discardChanges(names), undefined, files.length === 1 ? `Mudanças em ${names[0]} descartadas.` : `${files.length} arquivos voltaram ao último commit.`)
  }

  const changeEntries = (c: GitChange): ContextMenuEntries => {
    const target = moduleFor(c.path)
    return [
      { id: 'diff', label: c.kind === 'conflicted' ? 'Resolver o conflito' : 'Ver o diff', icon: <FileDiffIcon {...icon} />, run: () => void showDiff(c.path) },
      c.kind !== 'conflicted' && {
        id: 'toggle',
        label: selected.has(c.path) ? 'Tirar do commit' : 'Incluir no commit',
        icon: selected.has(c.path) ? <Square {...icon} /> : <SquareCheck {...icon} />,
        run: () => toggle(c.path)
      },
      target && c.kind !== 'deleted' && { id: 'module', label: `Abrir no ${target}`, run: () => void openInModule(c.path).then((err) => {
            if (err) say(err, 'error')
          }) },
      separator,
      { id: 'copy-path', label: 'Copiar o caminho', icon: <Copy {...icon} />, shortcut: Shortcut.copy, run: () => copy(c.path, 'Caminho copiado') },
      c.kind !== 'deleted' && {
        id: 'reveal',
        label: 'Revelar no explorador',
        icon: <FolderOpen {...icon} />,
        shortcut: Shortcut.reveal,
        run: () => void window.vvpost.revealInFolder({ repoPath: c.path }).then((r) => {
            if (!r.ok) say(r.message, 'error')
          })
      },
      separator,
      c.kind !== 'conflicted' && { id: 'discard', label: 'Descartar as mudanças…', icon: <RotateCcw {...icon} />, shortcut: Shortcut.remove, danger: true, disabled: busy, run: () => void discard([c]) }
    ]
  }
  const discardable = state.changes.filter((c) => c.kind !== 'conflicted')
  const listEntries = (): ContextMenuEntries => [
    { id: 'all', label: 'Incluir todos no commit', icon: <SquareCheck {...icon} />, run: () => setSelected(new Set(discardable.map((c) => c.path))) },
    { id: 'none', label: 'Tirar todos do commit', icon: <Square {...icon} />, run: () => setSelected(new Set()) },
    separator,
    { id: 'refresh', label: 'Atualizar', run: props.onRefresh },
    discardable.length > 0 && { id: 'discard-all', label: 'Descartar todas as mudanças…', icon: <RotateCcw {...icon} />, danger: true, disabled: busy, run: () => void discard(discardable) }
  ]
  const branchEntries = (b: { name: string; remote: boolean }): ContextMenuEntries => [
    { id: 'checkout', label: b.name === state.branch ? 'Branch atual' : 'Fazer checkout', icon: b.name === state.branch ? <Check {...icon} /> : <GitBranch {...icon} />, disabled: busy || b.name === state.branch || state.operation !== null, run: () => void checkout(b.name) },
    { id: 'branch-from', label: 'Nova branch a partir desta…', icon: <GitBranchPlus {...icon} />, disabled: busy || state.operation !== null, run: () => void branchFrom(b.name) },
    separator,
    { id: 'copy-name', label: 'Copiar o nome', icon: <Copy {...icon} />, shortcut: Shortcut.copy, run: () => copy(b.name, 'Nome da branch copiado') }
  ]
  useMenuCommands('Git', [
    { id: 'refresh', label: 'Atualizar o estado do Git', run: props.onRefresh },
    { id: 'fetch', label: 'Fetch', disabled: busy || state.remotes.length === 0, run: () => void sync('fetch', 'Remotos atualizados.') },
    { id: 'pull', label: 'Pull', disabled: busy || !state.upstream, run: () => void sync('pull', 'Pull concluído.') },
    { id: 'push', label: 'Push', disabled: busy || state.remotes.length === 0 || state.head === null, run: () => void sync('push', 'Push concluído.') },
    {
      id: 'install-hook',
      label: 'Conferir segredos também nos commits fora do app',
      disabled: busy,
      run: () =>
        void run(
          () => window.vvpost.installCommitHook(),
          () => undefined,
          (r) =>
            r.status === 'unchanged'
              ? 'O hook de pre-commit do VVPost já está instalado.'
              : `Hook de pre-commit ${r.status === 'installed' ? 'instalado' : 'atualizado'}: commits do terminal e da IDE passam pela mesma conferência de segredos.`
        )
    },
    { id: 'new-branch', label: 'Nova branch…', icon: <GitBranchPlus {...icon} />, disabled: busy, run: () => void branchFrom(state.branch ?? state.head ?? 'HEAD') },
    { id: 'commit', label: `Commit (${selected.size})`, shortcut: Shortcut.run, disabled: busy || selected.size === 0 || !commitMessage.trim() || state.operation !== null, run: () => void commit() },
    focused && state.changes.some((c) => c.path === focused) && { id: 'discard', label: `Descartar as mudanças em ${focused}…`, danger: true, run: () => void discard(state.changes.filter((c) => c.path === focused && c.kind !== 'conflicted')) }
  ])

  if (!state.isRepo) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
        <div className="font-mono text-xs text-muted">{state.dir}</div>
        <div>Esta pasta ainda não é um repositório Git.</div>
        <div className="flex gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void run(() => window.vvpost.initWorkspace(), undefined, 'Repositório criado.')}
          >
            Iniciar repositório
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={props.onOpen}>
            Abrir outra pasta…
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="truncate font-mono text-xs text-muted" title={state.dir}>
          {state.dir}
        </span>
        <span className="mx-1 text-border">|</span>
        {newBranch === null ? (
          <select
            aria-label="Branch"
            className={`${inputClass} py-1 font-mono`}
            disabled={busy}
            value={state.branch ?? ''}
            onChange={(e) => {
              if (e.target.value === '\0new') return setNewBranch('')
              const name = e.target.value
              void run(() => window.vvpost.checkoutBranch(name), undefined, `Na branch ${name}.`)
            }}
          >
            {state.branch === null && <option value="">HEAD destacado ({state.head ?? 'sem commits'})</option>}
            {local.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
            {remote.length > 0 && (
              <optgroup label="Remotas">
                {remote.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </optgroup>
            )}
            <option value={'\0new'}>+ Nova branch…</option>
          </select>
        ) : (
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              const name = newBranch
              void run(
                () => window.vvpost.createBranch(name),
                (s) => {
                  setNewBranch(null)
                  return s
                },
                `Branch ${name} criada.`
              )
            }}
          >
            <input
              autoFocus
              aria-label="Nome da nova branch"
              className={`${inputClass} py-1 font-mono`}
              placeholder="feature/minha-branch"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
            />
            <button type="submit" className={buttonClass} disabled={busy || !newBranch.trim()}>
              Criar
            </button>
            <button type="button" className={buttonClass} onClick={() => setNewBranch(null)}>
              Cancelar
            </button>
          </form>
        )}
        {state.upstream && (
          <span className="font-mono text-xs text-muted" title={`Rastreando ${state.upstream}`}>
            ↑{state.ahead} ↓{state.behind}
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          <button type="button" className={buttonClass} disabled={busy} onClick={props.onRefresh}>
            Atualizar
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || state.remotes.length === 0}
            onClick={() => void sync('fetch', 'Remotos atualizados.')}
          >
            Fetch
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !state.upstream}
            onClick={() => void sync('pull', 'Pull concluído.')}
          >
            Pull
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || state.remotes.length === 0 || state.head === null}
            onClick={() => void sync('push', 'Push concluído.')}
          >
            Push
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={props.onOpen}>
            Trocar pasta…
          </button>
        </div>
      </header>

      {state.secretsFileTracked && (
        <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          <span className="font-mono">.vvpost/secrets.local.json</span> está versionado neste repositório: os valores já
          estão no histórico do Git. Tire o arquivo do Git e troque os segredos expostos.
        </div>
      )}
      {state.operation === 'merge' && (
        <div
          role="region"
          aria-label="Merge em andamento"
          className="flex flex-wrap items-center gap-3 border-b border-info/40 bg-info/10 px-4 py-2 text-xs text-info"
        >
          {conflicts > 0
            ? `Merge em andamento: ${conflicts} arquivo(s) em conflito. Abra cada um marcado com ! para resolver.`
            : 'Merge em andamento: todos os conflitos foram resolvidos.'}
          <span className="ml-auto" />
          <button
            type="button"
            className={buttonClass}
            disabled={busy || conflicts > 0}
            onClick={() =>
              void run(
                () => window.vvpost.finishMerge(),
                (out) => out.state,
                (out) => `Merge concluído no commit ${out.commit}.`
              )
            }
          >
            Concluir merge
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() =>
              void run(
                () => window.vvpost.abortMerge(),
                undefined,
                'Merge abortado: a branch voltou a como estava antes do pull.'
              )
            }
          >
            Abortar merge
          </button>
        </div>
      )}
      {state.operation && state.operation !== 'merge' && (
        <div className="border-b border-info/40 bg-info/10 px-4 py-2 text-xs text-info">
          Há um {state.operation} em andamento, começado fora do app. Resolva os conflitos aqui e termine no terminal (
          <span className="font-mono">git {state.operation} --continue</span> ou{' '}
          <span className="font-mono">--abort</span>).
        </div>
      )}
      {state.missingSecrets.length > 0 && (
        <div className="flex items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning">
          {state.missingSecrets.length} segredo(s) sem valor nesta máquina.
          <button type="button" className="underline" onClick={props.onWizard}>
            Preencher agora
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <DockablePane
          as="section"
          id="git.changes"
          title={`Mudanças (${state.changes.length})`}
          dockLabel="a lista de mudanças"
          label="Largura da lista de mudanças"
          defaultSize={320}
          min={220}
          max={640}
          className="flex flex-col border-r border-border"
          aria-label="Mudanças do Git"
        >
          <ul className="min-h-0 flex-1 overflow-auto px-2" aria-label="Mudanças" {...ctx.bind('Mudanças', listEntries)}>
            {state.changes.length === 0 && <li className="px-2 py-1 text-xs text-muted">Nada para commitar.</li>}
            {state.changes.map((c) => {
              const k = KIND_LABEL[c.kind]
              const secrets = unredacted.get(c.path)
              return (
                <li
                  key={c.path}
                  {...ctx.bind(`Arquivo ${c.path}`, () => changeEntries(c))}
                  className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${
                    focused === c.path ? 'bg-border' : 'hover:bg-border/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Incluir ${c.path} no commit`}
                    checked={selected.has(c.path)}
                    disabled={c.kind === 'conflicted'}
                    onChange={() => toggle(c.path)}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => void showDiff(c.path)}
                    title={c.origPath ? `${c.origPath} → ${c.path}` : c.path}
                  >
                    <span className="truncate font-mono">{c.path}</span>
                    {secrets && (
                      <span
                        className="shrink-0 rounded border border-warning/40 px-1 text-warning"
                        title={`Vão para o arquivo local no commit: ${secrets.join(', ')}`}
                      >
                        redige {secrets.length}
                      </span>
                    )}
                  </button>
                  <span className={`w-3 shrink-0 font-mono font-semibold ${k.color}`} title={k.title}>
                    {k.letter}
                  </span>
                </li>
              )
            })}
          </ul>
          <details className="border-t border-border">
            <summary className="cursor-pointer px-4 py-2 text-xs font-semibold tracking-wide text-muted uppercase">
              Branches ({state.branches.length})
            </summary>
            <ul className="max-h-40 overflow-auto px-2 pb-2" aria-label="Ramificações do repositório">
              {[...local, ...remote].map((b) => (
                <li key={b.name}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs ${
                      b.name === state.branch ? 'text-fg' : 'text-muted hover:bg-border/50 hover:text-fg'
                    }`}
                    aria-current={b.name === state.branch ? 'true' : undefined}
                    title={b.name === state.branch ? 'Branch atual' : 'Duplo clique faz checkout; botão direito para mais'}
                    onDoubleClick={() => b.name !== state.branch && !busy && void checkout(b.name)}
                    {...ctx.bind(`Branch ${b.name}`, () => branchEntries(b))}
                  >
                    <GitBranch size={12} aria-hidden className="shrink-0" />
                    <span className="truncate">{b.name}</span>
                    {b.remote && <span className="ml-auto font-sans text-faint">remota</span>}
                    {b.name === state.branch && <Check size={12} aria-hidden className="ml-auto shrink-0 text-success" />}
                  </button>
                </li>
              ))}
            </ul>
          </details>
          <form
            className="flex flex-col gap-2 border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault()
              void commit()
            }}
          >
            {state.operation && (
              <p className="text-xs text-muted">Com um {state.operation} em andamento, o commit fica para depois.</p>
            )}
            <textarea
              aria-label="Mensagem do commit"
              className={`${inputClass} h-20 resize-none`}
              placeholder="Mensagem do commit"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
            />
            <button
              type="submit"
              className={primaryClass}
              disabled={busy || selected.size === 0 || !commitMessage.trim() || state.operation !== null}
            >
              Commit ({selected.size})
            </button>
          </form>
        </DockablePane>
        <section className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 && (
            <WorkspaceTabs
              label="Arquivos abertos"
              idPrefix="git"
              tabs={tabs.map((t) => {
                const k = KIND_LABEL[state.changes.find((c) => c.path === t)?.kind ?? 'modified']
                return {
                  id: t,
                  title: t,
                  icon: (
                    <span aria-hidden className={`font-mono text-[11px] font-semibold ${k.color}`}>
                      {k.letter}
                    </span>
                  )
                }
              })}
              activeId={focused}
              onSelect={(t) => void showDiff(t)}
              onClose={closeTab}
              contextMenu={(t) => tabEntries(t.id)}
            />
          )}
          <div
            role={tabs.length > 0 && focused ? 'tabpanel' : undefined}
            id={focused ? `git-panel-${focused}` : undefined}
            aria-labelledby={tabs.length > 0 && focused ? `git-tab-${focused}` : undefined}
            className="flex min-h-0 flex-1 flex-col"
          >
            {focused && isConflicted(focused) ? (
              <>
                <div className="border-b border-border px-4 py-2 font-mono text-xs">{focused} (em conflito)</div>
                <ConflictView
                  path={focused}
                  busy={busy}
                  onResolve={(r, label) => resolve(focused, r, label).then(() => undefined)}
                />
              </>
            ) : diff ? (
              <>
                <div className="border-b border-border px-4 py-2 font-mono text-xs">{diff.path}</div>
                <DiffView diff={diff} />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted">
                Escolha um arquivo para ver o diff.
              </div>
            )}
          </div>
        </section>
      </div>
      {ctx.menu}
      {dialog.element}
    </div>
  )
}
