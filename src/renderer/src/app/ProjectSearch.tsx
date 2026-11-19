import { useEffect, useState } from 'react'
import { FlaskConical, Network, Workflow } from 'lucide-react'
import { CommandPalette, MethodBadge, type Command } from '../design-system'
import { navigate } from '../lib/navigate'

/**
 * Procurar no projeto (Ctrl+Shift+F): conectores, endpoints, cenários e fluxos do workspace,
 * na mesma lista da Command Palette. Escolher um item abre o módulo que o edita.
 */
export function ProjectSearch(props: { onClose: () => void }) {
  const [items, setItems] = useState<Command[] | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([window.vvpost.getConnectorRegistry(), window.vvpost.listFlows()]).then(([reg, flows]) => {
      if (!alive) return
      const out: Command[] = []
      for (const c of reg.ok ? (reg.value?.connectors ?? []) : []) {
        out.push({
          id: `c:${c.id}`,
          title: c.name,
          group: 'Conector',
          icon: <Network size={16} aria-hidden />,
          keywords: [c.id, c.file],
          run: () => navigate({ module: 'catalog', connectorId: c.id })
        })
        for (const e of c.endpoints) {
          out.push({
            id: `e:${c.id}/${e.id}`,
            title: `${e.name} · ${c.name}`,
            group: 'Endpoint',
            icon: <MethodBadge method={e.method} className="w-12" />,
            keywords: [e.id, e.method, e.path],
            run: () => navigate({ module: 'catalog', connectorId: c.id, endpointId: e.id })
          })
          for (const s of e.scenarios) {
            out.push({
              id: `s:${c.id}/${e.id}/${s.id}`,
              title: `${s.name} · ${e.name}`,
              group: 'Cenário',
              icon: <FlaskConical size={16} aria-hidden />,
              keywords: [s.id, c.name],
              run: () => navigate({ module: 'scenarios', connectorId: c.id, endpointId: e.id, scenarioId: s.id, action: 'edit' })
            })
          }
        }
      }
      for (const f of flows.ok ? (flows.value?.flows ?? []) : []) {
        out.push({
          id: `f:${f.flow.id}`,
          title: f.flow.name ?? f.flow.id,
          group: 'Fluxo',
          icon: <Workflow size={16} aria-hidden />,
          keywords: [f.flow.id, f.file],
          run: () => navigate({ module: 'flows', flowId: f.flow.id })
        })
      }
      setItems(out)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <CommandPalette
      commands={items ?? []}
      loading={items === null}
      label="Procurar no projeto"
      placeholder="Procurar conector, endpoint, cenário ou fluxo…"
      onClose={props.onClose}
    />
  )
}
