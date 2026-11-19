import { useState } from 'react'
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react'
import type { CatalogConnector } from '@shared/ipc'
import { DockablePane, IconButton, MethodBadge } from '../../design-system'
import { useLayoutChoice } from '../../lib/layout'
import { readPref } from '../../lib/storage'
import { ENDPOINT_DRAG_TYPE, type EndpointRef } from './model'

const icon = { size: 14, 'aria-hidden': true } as const
const SHOWN = ['open', 'closed'] as const
const SIDES = ['left', 'right'] as const

/**
 * Endpoints do catálogo ao lado do canvas: arrastar um para o canvas cria o nó de requisição
 * daquele endpoint (com a herança do conector). Enter ou duplo clique adicionam sem arrastar,
 * ligados ao nó selecionado, como os botões "+ Requisição".
 */
export function EndpointPalette(props: {
  connectors: CatalogConnector[]
  disabled: boolean
  onAdd: (ref: EndpointRef, name: string) => void
}) {
  // Aberta ou recolhida, lembrada no workspace (lib/layout); a escolha de antes vira o padrão.
  const [shown, setShown] = useLayoutChoice('flows.endpoints', readPref('flows.endpoints') === 'closed' ? 'closed' : 'open', SHOWN)
  const open = shown === 'open'
  const [query, setQuery] = useState('')
  const toggle = () => setShown(open ? 'closed' : 'open')
  // A lista se move para a direita do canvas (DockablePane): recolhida, a faixa vai junto.
  const [side] = useLayoutChoice('pane.flows.endpoints.width.side', 'left', SIDES)
  const [Hide, Show] = side === 'left' ? [ChevronLeft, ChevronRight] : [ChevronRight, ChevronLeft]
  if (!open)
    return (
      <div className={side === 'left' ? 'flex shrink-0 flex-col border-r border-border' : 'order-2 flex shrink-0 flex-col border-l border-border'}>
        <IconButton label="Mostrar os endpoints do catálogo" onClick={toggle}>
          <Show {...icon} />
        </IconButton>
      </div>
    )

  const q = query.trim().toLowerCase()
  const groups = props.connectors
    .filter((c) => !c.error)
    .map((c) => ({
      connector: c,
      endpoints: c.endpoints.filter(
        (e) => !q || `${c.name} ${e.name} ${e.method} ${e.path}`.toLowerCase().includes(q)
      )
    }))
    .filter((g) => g.endpoints.length > 0)

  return (
    <DockablePane
      as="aside"
      id="flows.endpoints.width"
      title="Endpoints"
      dockLabel="a lista de endpoints"
      inspector="flows"
      actions={
        <IconButton label="Esconder os endpoints do catálogo" onClick={toggle}>
          <Hide {...icon} />
        </IconButton>
      }
      label="Largura da lista de endpoints"
      defaultSize={240}
      min={180}
      max={520}
      onCollapse={toggle}
      className="flex flex-col border-r border-border text-xs"
      aria-label="Endpoints do catálogo"
    >
      <div className="px-2 py-1.5">
        <input
          aria-label="Buscar endpoint"
          placeholder="Buscar endpoint"
          className="h-7 w-full min-w-0 border px-2 text-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <p className="px-2 pb-1 text-[11px] text-muted">Arraste para o canvas. O nó leva a herança do conector.</p>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {groups.length === 0 && (
          <p className="px-2 py-1 text-muted">{q ? 'Nenhum endpoint com esse texto.' : 'Nenhum endpoint no catálogo.'}</p>
        )}
        {groups.map(({ connector, endpoints }) => (
          <section key={connector.id} aria-label={`Endpoints de ${connector.name}`} className="mt-1">
            <h3 className="truncate px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted" title={connector.chain.join(' → ')}>
              {connector.name}
            </h3>
            <ul role="list">
              {endpoints.map((e) => {
                const ref: EndpointRef = { connector: connector.id, endpoint: e.id }
                return (
                  <li key={e.id}>
                    <div
                      role="button"
                      tabIndex={props.disabled ? -1 : 0}
                      aria-disabled={props.disabled || undefined}
                      aria-label={`${e.name} (${e.method} ${e.path})`}
                      title={`${e.method} ${connector.baseUrl ?? ''}${e.path}\nArraste para o canvas, ou Enter para adicionar.`}
                      draggable={!props.disabled}
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData(ENDPOINT_DRAG_TYPE, JSON.stringify(ref))
                        ev.dataTransfer.setData('text/plain', `${e.method} ${e.path}`)
                        ev.dataTransfer.effectAllowed = 'copy'
                      }}
                      onDoubleClick={() => !props.disabled && props.onAdd(ref, e.name)}
                      onKeyDown={(ev) => {
                        if (props.disabled || (ev.key !== 'Enter' && ev.key !== ' ')) return
                        ev.preventDefault()
                        props.onAdd(ref, e.name)
                      }}
                      className="group flex cursor-grab items-center gap-1.5 px-2 py-1 hover:bg-elevated focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:opacity-50"
                    >
                      <GripVertical size={12} aria-hidden className="shrink-0 text-faint group-hover:text-muted" />
                      <MethodBadge method={e.method} />
                      <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </DockablePane>
  )
}
