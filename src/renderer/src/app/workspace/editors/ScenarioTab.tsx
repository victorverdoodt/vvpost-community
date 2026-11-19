import { useState } from 'react'
import { ScenarioEditor } from '../../../modules/connectors/editor/ScenarioEditor'
import { useWorkspace, WORKSPACE_CHANGED } from '../../../panels/useWorkspace'
import type { DocTab } from '../docs'

/** Aba de um cenário de teste: o editor de cenários do endpoint, com os ambientes do workspace. */
export default function ScenarioTab(props: { connectorId: string; endpointId?: string; scenarioId?: string; tab: DocTab }) {
  const ws = useWorkspace()
  const [version, setVersion] = useState(0)
  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <ScenarioEditor
        key={version}
        connectorId={props.connectorId}
        {...(props.endpointId && { endpointId: props.endpointId })}
        {...(props.scenarioId && { scenarioId: props.scenarioId })}
        environments={ws.workspace?.environments ?? []}
        onDone={(saved) => {
          if (!saved) return props.tab.close()
          window.dispatchEvent(new Event(WORKSPACE_CHANGED))
          // Um cenário novo salvo fecha a aba (ele aparece no explorador); um existente relê do disco.
          if (props.scenarioId) setVersion((v) => v + 1)
          else props.tab.close()
        }}
      />
    </div>
  )
}
