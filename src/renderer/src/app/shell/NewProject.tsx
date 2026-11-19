import { useEffect, useRef, useState } from 'react'
import { FolderPlus } from 'lucide-react'
import type { ProjectTemplate, ProjectTemplateId, WorkspaceState } from '@shared/ipc'
import { Button, cx, ErrorNotice, useToast } from '../../design-system'

const SHOW = 'vvpost:new-project'

/** "Novo projeto a partir de um modelo" (paleta, Primeiros passos, Git): abre o diálogo no App. */
export function showNewProject(): void {
  window.dispatchEvent(new Event(SHOW))
}

/**
 * Novo projeto a partir de um modelo: a pessoa vê o que cada modelo
 * cria antes de escolher a pasta, que precisa estar vazia. O repositório Git é opcional; nada mais
 * é ligado (MCP, plugins, proxy de segredos).
 */
export function NewProject(props: { onCreated: (state: WorkspaceState) => void }) {
  const [open, setOpen] = useState(false)
  const notify = useToast()
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(SHOW, show)
    return () => window.removeEventListener(SHOW, show)
  }, [])
  if (!open) return null
  return (
    <NewProjectDialog
      onClose={() => setOpen(false)}
      onCreated={(state) => {
        setOpen(false)
        notify(
          state.missingSecrets.length
            ? `Projeto criado em ${state.dir}. Configure ${state.missingSecrets.length === 1 ? 'o segredo pendente' : `os ${state.missingSecrets.length} segredos pendentes`} em Secrets.`
            : `Projeto criado em ${state.dir}.`,
          'success'
        )
        props.onCreated(state)
      }}
    />
  )
}

function NewProjectDialog(props: { onClose: () => void; onCreated: (state: WorkspaceState) => void }) {
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null)
  const [choice, setChoice] = useState<ProjectTemplateId>('rest-api')
  const [git, setGit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const restore = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    void window.vvpost.listProjectTemplates().then(setTemplates)
    const back = restore.current
    return () => back?.focus()
  }, [])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.vvpost.createProject({ template: choice, git })
      if (!r.ok) return setError(r.message)
      if (r.value) props.onCreated(r.value)
    } finally {
      setBusy(false)
    }
  }
  const selected = templates?.find((t) => t.id === choice)

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={props.onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Novo projeto"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            props.onClose()
          }
        }}
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
        className="flex max-h-[76vh] w-[min(34rem,92vw)] flex-col gap-3 overflow-auto rounded-[var(--radius-card)] bg-elevated p-4 text-xs shadow-[var(--shadow-overlay)]"
      >
        <h2 className="text-[13px] font-semibold text-fg">Novo projeto</h2>
        <p className="text-muted">
          Escolha um modelo e depois a pasta, que precisa estar vazia. Os segredos entram como pendentes, sem valor.
        </p>
        <div role="radiogroup" aria-label="Modelo do projeto" className="flex flex-col gap-2">
          {(templates ?? []).map((t, i) => (
            <label
              key={t.id}
              className={cx(
                'flex cursor-pointer gap-2.5 rounded-[var(--radius-control)] border p-2.5',
                t.id === choice ? 'border-accent bg-accent/10' : 'border-border hover:bg-border/40'
              )}
            >
              <input
                type="radio"
                name="template"
                value={t.id}
                checked={t.id === choice}
                autoFocus={i === 0}
                onChange={() => setChoice(t.id)}
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-fg">{t.name}</span>
                <span className="text-muted">{t.description}</span>
              </span>
            </label>
          ))}
        </div>
        {selected && (
          <div className="flex flex-col gap-1">
            <span className="text-muted">Arquivos que o modelo cria</span>
            <ul
              aria-label="Arquivos do modelo"
              className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-fg/90"
            >
              {selected.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
          Iniciar um repositório Git na pasta (sem commit)
        </label>
        {error && (
          <ErrorNotice
            compact
            title="O projeto não foi criado"
            code="CONFIG_ERROR"
            message={error}
            hint="Nada foi gravado. Escolha outra pasta ou abra a existente."
          />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={props.onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            icon={<FolderPlus size={14} aria-hidden />}
            disabled={!selected || busy}
          >
            Escolher a pasta e criar
          </Button>
        </div>
      </form>
    </div>
  )
}
