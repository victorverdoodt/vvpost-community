import { useEffect, useState, type ReactNode } from 'react'
import { FileArchive, FolderPlus, FolderTree } from 'lucide-react'
import type {
  ArchiveExportPreview,
  ArchiveExportSaveResult,
  ArchiveImportPreview,
  ArchiveImportResult,
  ArchiveKind,
  ArchiveSummary
} from '@shared/ipc'
import { Badge, Button, SegmentedControl, useToast } from '../../design-system'
import { WORKSPACE_CHANGED } from '../useWorkspace'
import { fieldClass } from './model'

const COUNTS: [keyof ArchiveSummary, string][] = [
  ['projects', 'projetos'],
  ['connectors', 'conectores'],
  ['flows', 'fluxos'],
  ['environments', 'ambientes'],
  ['docs', 'Markdown'],
  ['files', 'arquivos']
]

function Counts({ summary, label }: { summary: ArchiveSummary; label: string }) {
  return (
    <div className="flex flex-wrap gap-2 text-xs" aria-label={label}>
      {COUNTS.filter(([key]) => key !== 'projects' || summary.projects > 0).map(([key, text]) => (
        <span key={key} className="rounded-[var(--radius-control)] border border-border bg-panel px-2.5 py-1">
          <span className="font-semibold text-fg">{summary[key]}</span> <span className="text-muted">{text}</span>
        </span>
      ))}
      {summary.pendingSecrets > 0 && (
        <Badge tone="warning" title="Vão como __REQUIRED_SECRET__: o valor fica só na sua máquina">
          {summary.pendingSecrets} segredo(s) sem valor
        </Badge>
      )}
    </div>
  )
}

function Warnings({ list }: { list: string[] }) {
  if (!list.length) return null
  return (
    <details className="rounded-[var(--radius-card)] border border-warning/40 px-3 py-2 text-xs text-warning">
      <summary className="cursor-pointer font-medium">Avisos ({list.length})</summary>
      <div className="mt-2 flex flex-col gap-1 text-muted">
        {list.map((w, i) => (
          <div key={i}>{w}</div>
        ))}
      </div>
    </details>
  )
}

const Failure = ({ children }: { children: ReactNode }) => (
  <div role="alert" className="rounded-[var(--radius-card)] border border-danger/40 px-3 py-2 text-xs whitespace-pre-line text-danger">
    {children}
  </div>
)

/**
 * Exportar em .zip: a pasta do projeto aberto ou do workspace inteiro (o Compartilhado e todos os
 * projetos), como está no disco. A prévia vem do main process, que monta o zip de verdade e
 * recusa se algum valor de segredo fosse sair.
 */
export function ArchiveExport({ name }: { name: string }) {
  const [hasProjects, setHasProjects] = useState(false)
  const [inProject, setInProject] = useState(false)
  const [scope, setScope] = useState<ArchiveKind>('project')
  const [preview, setPreview] = useState<ArchiveExportPreview | null>(null)
  const [outcome, setOutcome] = useState<ArchiveExportSaveResult | null>(null)
  const [busy, setBusy] = useState(false)
  const notify = useToast()

  useEffect(() => {
    const load = () =>
      void window.vvpost.getWorkspaceInfo().then((info) => {
        setHasProjects(!!info?.projects)
        setInProject(!!info?.projects?.current)
      })
    load()
    window.addEventListener(WORKSPACE_CHANGED, load)
    return () => window.removeEventListener(WORKSPACE_CHANGED, load)
  }, [])

  // Na raiz de um workspace com projetos, o zip é sempre o workspace inteiro.
  const effective: ArchiveKind = inProject ? scope : 'workspace'
  useEffect(() => {
    let current = true
    setPreview(null)
    setOutcome(null)
    void window.vvpost.previewArchiveExport(effective).then((p) => current && setPreview(p))
    return () => {
      current = false
    }
  }, [effective, hasProjects])

  const save = async () => {
    setBusy(true)
    try {
      const result = await window.vvpost.saveArchiveExport(effective, { name: preview?.ok ? preview.name : name })
      if (!result.ok && result.reason === 'canceled') return
      setOutcome(result)
      if (result.ok) notify(result.kind === 'project' ? 'Projeto exportado em .zip' : 'Workspace exportado em .zip', 'success')
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        {inProject && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted">O que vai no zip</span>
            <SegmentedControl<ArchiveKind>
              label="O que vai no zip"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'project', label: 'Este projeto', title: 'Só a pasta do projeto aberto, com o vvpost.project.json' },
                { value: 'workspace', label: 'Workspace inteiro', title: 'O Compartilhado da raiz e todos os projetos' }
              ]}
            />
          </div>
        )}
        {preview?.ok && (
          <>
            <div className="flex items-center gap-2 text-xs">
              {preview.kind === 'project' ? <FileArchive size={14} aria-hidden className="text-muted" /> : <FolderTree size={14} aria-hidden className="text-muted" />}
              <span className="font-medium">{preview.kind === 'project' ? `Projeto ${preview.name}` : `Workspace ${preview.name}`}</span>
              <span className="truncate font-mono text-faint">{preview.folder}</span>
            </div>
            <Counts summary={preview.summary} label="Resumo do zip" />
            <Warnings list={preview.warnings} />
          </>
        )}
        {preview && !preview.ok && <Failure>{preview.message}</Failure>}
        <p className="max-w-prose text-xs text-muted">
          A pasta vai como está: conectores, fluxos, ambientes, o documento do projeto, diagramas, schemas e dados de teste.
          Num repositório Git, o que o .gitignore ignora fica de fora. O cofre local, os arquivos *.local.json e as pastas
          .git e node_modules nunca vão. Quem importar abre o zip como workspace novo ou acrescenta como projeto.
        </p>
      </div>
      <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-2.5">
        {outcome?.ok && (
          <div className="text-xs text-success" role="status">
            Zip salvo em <span className="font-mono">{outcome.path}</span>
          </div>
        )}
        {outcome && !outcome.ok && outcome.reason === 'error' && <Failure>{outcome.message}</Failure>}
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Segredos vão como __REQUIRED_SECRET__: quem importar preenche os valores na própria máquina.</span>
          <Button variant="primary" className="ml-auto" disabled={busy || !preview?.ok} onClick={() => void save()}>
            Exportar .zip…
          </Button>
        </div>
      </footer>
    </>
  )
}

/**
 * O zip escolhido na aba Importar: abre como workspace novo (numa pasta vazia) ou entra como
 * projeto do workspace aberto, com o id que a pessoa escolher.
 */
export function ArchiveImport(props: { preview: ArchiveImportPreview; onPickAnother: () => void; onClose: () => void }) {
  const { preview } = props
  const [id, setId] = useState(preview.asProject.id)
  const [name, setName] = useState(preview.asProject.name)
  const [outcome, setOutcome] = useState<ArchiveImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const notify = useToast()
  useEffect(() => {
    setId(preview.asProject.id)
    setName(preview.asProject.name)
    setOutcome(null)
  }, [preview])

  const write = async (choice: Parameters<typeof window.vvpost.writeArchiveImport>[1]) => {
    setBusy(true)
    try {
      const result = await window.vvpost.writeArchiveImport(preview.id, choice)
      if (!result.ok && result.reason === 'canceled') return
      setOutcome(result)
      if (result.ok) {
        notify(result.mode === 'workspace' ? 'Workspace aberto do zip' : `Projeto "${choice.mode === 'project' ? choice.name : ''}" importado e aberto`, 'success')
        window.dispatchEvent(new Event(WORKSPACE_CHANGED))
      }
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const sameId = id.trim() === preview.asProject.id
  const blocked = preview.asProject.blocked
  const taken = sameId ? preview.asProject.taken : undefined
  const done = outcome?.ok === true
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="text-sm font-semibold">Importar .zip</h1>
        <span className="truncate font-mono text-xs text-muted">{preview.file}</span>
        <span className="ml-auto" />
        <Button size="sm" disabled={busy} onClick={props.onPickAnother}>
          Outro .zip…
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={props.onClose}>
          Fechar
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        <div className="flex items-center gap-2 text-xs">
          {preview.kind === 'project' ? <FileArchive size={14} aria-hidden className="text-muted" /> : <FolderTree size={14} aria-hidden className="text-muted" />}
          <span className="font-medium">{preview.kind === 'project' ? `Projeto ${preview.name}` : `Workspace ${preview.name}`}</span>
          {preview.projects.length > 0 && <span className="truncate text-muted">com {preview.projects.map((p) => p.name).join(', ')}</span>}
        </div>
        <Counts summary={preview.summary} label="Conteúdo do zip" />
        <Warnings list={preview.warnings} />

        <section className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-panel p-3 text-xs" aria-label="Abrir como workspace novo">
          <h2 className="flex items-center gap-2 font-semibold">
            <FolderTree size={14} aria-hidden /> Abrir como workspace novo
          </h2>
          <p className="text-muted">
            Escolha uma pasta vazia: o zip é extraído ali e o workspace abre{preview.projects.length > 0 ? ', com os mesmos projetos' : ''}.
          </p>
          <div>
            <Button variant={blocked ? 'primary' : 'secondary'} disabled={busy || done} onClick={() => void write({ mode: 'workspace' })}>
              Escolher pasta vazia…
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-panel p-3 text-xs" aria-label="Acrescentar como projeto">
          <h2 className="flex items-center gap-2 font-semibold">
            <FolderPlus size={14} aria-hidden /> Acrescentar como projeto deste workspace
          </h2>
          {blocked ? (
            <p className="text-muted">Não dá: {blocked}.</p>
          ) : (
            <>
              <p className="text-muted">Uma subpasta nova com o vvpost.project.json. Ambientes, segredos e o Compartilhado da raiz valem lá dentro.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted">Id do projeto (nome da pasta)</span>
                  <input className={fieldClass} value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted">Nome</span>
                  <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
              </div>
              {taken && <p className="text-warning">{taken}: troque o id.</p>}
              <div>
                <Button
                  variant="primary"
                  disabled={busy || done || !id.trim() || !name.trim() || !!taken}
                  onClick={() => void write({ mode: 'project', id: id.trim(), name: name.trim() })}
                >
                  Acrescentar projeto
                </Button>
              </div>
            </>
          )}
        </section>

        {outcome?.ok && (
          <div className="text-xs text-success" role="status">
            {outcome.written} arquivo(s) gravado(s) em <span className="font-mono">{outcome.dir}</span>
            {outcome.pendingSecrets > 0 && <>; preencha {outcome.pendingSecrets} segredo(s) no módulo Secrets</>}
            {outcome.warnings.map((w, i) => (
              <div key={i} className="text-warning">
                {w}
              </div>
            ))}
          </div>
        )}
        {outcome && !outcome.ok && outcome.reason === 'error' && <Failure>{outcome.message}</Failure>}
      </div>
    </div>
  )
}
