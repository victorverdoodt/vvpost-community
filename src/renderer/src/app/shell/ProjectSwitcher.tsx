import { useEffect, useRef } from 'react'
import { Boxes, ChevronDown, FolderPlus, Layers } from 'lucide-react'
import type { WorkspaceInfo } from '@shared/ipc'
import { menuHeader, separator, useContextMenu, usePromptDialog, useToast } from '../../design-system'
import { WORKSPACE_CHANGED } from '../../panels/useWorkspace'

const SHOW_MENU = 'vvpost:project-menu'
const SHOW_NEW = 'vvpost:project-new'

/** A paleta abre o menu de projetos e o "Novo projeto no workspace". */
export const showProjectMenu = (): void => void window.dispatchEvent(new Event(SHOW_MENU))
export const showNewWorkspaceProject = (): void => void window.dispatchEvent(new Event(SHOW_NEW))

const icon = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const

/**
 * Seletor de projeto da barra superior (docs/git-workspace.md, Projetos): num workspace com
 * projetos, mostra o aberto e troca entre eles, o Compartilhado (a raiz, com o que todos herdam) e
 * "Novo projeto…". Sem projetos, só o "Novo projeto…" da paleta aparece.
 */
export function ProjectSwitcher(props: { workspace: WorkspaceInfo | null; onChanged: () => void }) {
  const ctx = useContextMenu()
  const dialog = usePromptDialog()
  const notify = useToast()
  const button = useRef<HTMLButtonElement>(null)
  const projects = props.workspace?.projects

  const done = (result: Awaited<ReturnType<typeof window.vvpost.switchProject>>, message: string) => {
    if (!result.ok) return notify(result.message, 'danger')
    props.onChanged()
    window.dispatchEvent(new Event(WORKSPACE_CHANGED))
    notify(message, 'success')
  }
  const create = async () => {
    if (!props.workspace) return notify('Abra um workspace antes de criar um projeto.', 'warning')
    const name = await dialog.prompt({
      title: 'Novo projeto no workspace',
      message: 'Uma subpasta com conectores, fluxos e docs próprios. Ambientes, segredos e o Compartilhado da raiz valem lá dentro.',
      label: 'Nome do projeto',
      confirmLabel: 'Criar'
    })
    if (name) done(await window.vvpost.createWorkspaceProject({ name }), `Projeto "${name}" criado e aberto.`)
  }
  const switchTo = async (id: string | null, name: string) => done(await window.vvpost.switchProject(id), `Aberto: ${name}.`)

  const openMenu = () => {
    if (!projects) return void create()
    ctx.open(button.current ?? { x: 200, y: 44 }, 'Projetos do workspace', [
      menuHeader('Projetos'),
      ...projects.list.map((p) => ({
        id: `project:${p.id}`,
        label: p.name,
        hint: p.id,
        icon: <Layers {...icon} />,
        checked: projects.current === p.id,
        run: () => void switchTo(p.id, p.name)
      })),
      separator,
      {
        id: 'project:shared',
        label: 'Compartilhado (raiz)',
        hint: 'o que os projetos herdam',
        icon: <Boxes {...icon} />,
        checked: projects.current === null,
        run: () => void switchTo(null, 'Compartilhado')
      },
      separator,
      { id: 'project:new', label: 'Novo projeto…', icon: <FolderPlus {...icon} />, run: () => void create() }
    ])
  }

  const openRef = useRef(openMenu)
  openRef.current = openMenu
  const createRef = useRef(create)
  createRef.current = create
  useEffect(() => {
    const menu = () => openRef.current()
    const make = () => void createRef.current()
    window.addEventListener(SHOW_MENU, menu)
    window.addEventListener(SHOW_NEW, make)
    return () => {
      window.removeEventListener(SHOW_MENU, menu)
      window.removeEventListener(SHOW_NEW, make)
    }
  }, [])

  const current = projects && (projects.list.find((p) => p.id === projects.current)?.name ?? 'Compartilhado')
  return (
    <>
      {current && (
        <button
          ref={button}
          type="button"
          onClick={openMenu}
          aria-label="Trocar de projeto"
          aria-haspopup="menu"
          title={`${current}\n${projects.list.length} projeto(s) no workspace · clique para trocar ou criar`}
          className="flex h-7 max-w-72 min-w-0 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-transparent px-2 text-xs hover:border-border hover:bg-elevated"
        >
          <Layers size={14} className="shrink-0 text-muted" aria-hidden />
          <span className="truncate">{current}</span>
          <ChevronDown size={13} className="shrink-0 text-faint" aria-hidden />
        </button>
      )}
      {ctx.menu}
      {dialog.element}
    </>
  )
}
