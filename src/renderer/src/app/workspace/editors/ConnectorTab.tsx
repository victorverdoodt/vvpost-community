import { useEffect, useState } from 'react'
import type { RegistryConnector } from '@shared/ipc'
import { ConnectorEditor, impactOf } from '../../../modules/connectors/editor/ConnectorEditor'
import { WORKSPACE_CHANGED } from '../../../panels/useWorkspace'
import type { DocTab } from '../docs'

/** Aba de um *.connector.vvpost.json: o editor do Catálogo, com o aviso de impacto nos herdeiros. */
export default function ConnectorTab(props: { connectorId: string | null; tab: DocTab }) {
  const [connectors, setConnectors] = useState<RegistryConnector[]>([])
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const load = () => void window.vvpost.getConnectorRegistry().then((r) => r.ok && setConnectors(r.value?.connectors ?? []))
    load()
    window.addEventListener(WORKSPACE_CHANGED, load)
    return () => window.removeEventListener(WORKSPACE_CHANGED, load)
  }, [])
  return (
    <div className="h-full min-h-0 overflow-auto p-4">
      <ConnectorEditor
        key={`${props.connectorId ?? 'new'}:${version}`}
        connectorId={props.connectorId}
        connectorIds={connectors.map((c) => c.id)}
        {...(props.connectorId && { impact: impactOf(props.connectorId, connectors) })}
        onCancel={props.tab.close}
        onSaved={(id) => {
          // Conector novo: a aba passa a ser a do arquivo criado. Um salvo relê o que foi gravado.
          if (props.connectorId !== id) props.tab.replace({ kind: 'connector', connectorId: id })
          else setVersion((v) => v + 1)
        }}
      />
    </div>
  )
}
