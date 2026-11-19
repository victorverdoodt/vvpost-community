import { lazy, memo, Suspense, useMemo } from 'react'
import { PanelActiveContext } from '../../design-system'
import type { DocRef, DocTab } from './docs'

// Cada editor é um chunk à parte, carregado só quando a primeira aba do tipo abre.
const ConnectorTab = lazy(() => import('./editors/ConnectorTab'))
const EndpointTab = lazy(() => import('./editors/EndpointTab'))
const ScenarioTab = lazy(() => import('./editors/ScenarioTab'))
const MarkdownTab = lazy(() => import('./editors/MarkdownTab'))
const DiagramTab = lazy(() => import('./editors/DiagramTab'))

/** O editor da aba pelo tipo do documento. Fica montado enquanto a aba existe (o texto não salvo sobrevive). */
export const DocTabHost = memo(function DocTabHost(props: {
  tabKey: string
  doc: DocRef
  active: boolean
  onClose(key: string): void
  onReplace(key: string, ref: DocRef): void
  onDirty(key: string, dirty: boolean): void
}) {
  const { tabKey, onClose, onReplace, onDirty } = props
  const tab = useMemo<DocTab>(
    () => ({
      active: props.active,
      close: () => onClose(tabKey),
      replace: (ref) => onReplace(tabKey, ref),
      setDirty: (dirty) => onDirty(tabKey, dirty)
    }),
    [props.active, tabKey, onClose, onReplace, onDirty]
  )
  const d = props.doc
  return (
    <div id={`ws-panel-${tabKey}`} role="tabpanel" aria-labelledby={`ws-tab-${tabKey}`} className="h-full" hidden={!props.active} data-find-root={tabKey}>
      <PanelActiveContext.Provider value={props.active}>
        <Suspense fallback={null}>
          {d.kind === 'connector' && <ConnectorTab connectorId={d.connectorId} tab={tab} />}
          {d.kind === 'endpoint' && <EndpointTab connectorId={d.connectorId} endpointId={d.endpointId} tab={tab} />}
          {d.kind === 'scenario' && (
            <ScenarioTab
              connectorId={d.connectorId}
              {...(d.endpointId && { endpointId: d.endpointId })}
              {...(d.scenarioId && { scenarioId: d.scenarioId })}
              tab={tab}
            />
          )}
          {d.kind === 'markdown' && <MarkdownTab file={d.file} tab={tab} />}
          {d.kind === 'diagram' && <DiagramTab file={d.file} tab={tab} />}
        </Suspense>
      </PanelActiveContext.Provider>
    </div>
  )
})
