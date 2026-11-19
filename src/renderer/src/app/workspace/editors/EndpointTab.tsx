import { lazy, Suspense, useMemo, useState } from 'react'
import { Braces, FlaskConical, Network, Play, Plus } from 'lucide-react'
import type { DocScope } from '@shared/ipc'
import { Button, MethodBadge } from '../../../design-system'
import { EndpointSchemaEditor } from '../../../modules/connectors/editor/EndpointSchemaEditor'
import { navigate } from '../../../lib/navigate'
import { openInQuickRequest } from '../../../lib/open-request'
import { useWorkspace, WORKSPACE_CHANGED } from '../../../panels/useWorkspace'
import { openDoc, type DocTab } from '../docs'
import { useDiskChange } from '../../../lib/disk-changes'

// A documentação viva (marked, Mermaid) é o mesmo chunk do módulo Documentação.
const DocsViewer = lazy(() => import('../../../modules/docs/DocsViewer'))

/**
 * Aba de um endpoint: a documentação viva dele (herança efetiva, auth, schema, cenários, exemplos)
 * com as ações do dia a dia ao lado: testar no Quick Request, editar o schema do corpo, criar
 * cenário, rodar os cenários e abrir o conector.
 */
export default function EndpointTab(props: { connectorId: string; endpointId: string; tab: DocTab }) {
  const ws = useWorkspace()
  const [schema, setSchema] = useState(false)
  const [version, setVersion] = useState(0)
  // A documentação viva é só leitura: qualquer arquivo gravado fora do app a remonta.
  useDiskChange(
    () => !schema,
    () => setVersion((v) => v + 1)
  )
  const connector = ws.workspace?.connectors.find((c) => c.id === props.connectorId)
  const endpoint = connector?.endpoints.find((e) => e.id === props.endpointId)
  const scope = useMemo<DocScope>(
    () => ({ kind: 'endpoint', connectorId: props.connectorId, endpointId: props.endpointId }),
    [props.connectorId, props.endpointId]
  )

  const test = () =>
    endpoint &&
    openInQuickRequest(
      {
        method: endpoint.method,
        url: endpoint.path,
        headers: endpoint.headers,
        body: endpoint.body ?? '',
        connectorId: props.connectorId,
        environmentId: null,
        endpointId: endpoint.id
      },
      'docs'
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        {endpoint && <MethodBadge method={endpoint.method} />}
        <span className="min-w-0 truncate font-mono text-muted" title={endpoint?.path}>
          {connector?.name ?? props.connectorId} · {endpoint?.path ?? props.endpointId}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="primary" icon={<Play size={14} aria-hidden />} disabled={!endpoint} onClick={test}>
          Testar
        </Button>
        <Button size="sm" icon={<Braces size={14} aria-hidden />} aria-pressed={schema} onClick={() => setSchema((v) => !v)}>
          Schema do corpo
        </Button>
        <Button
          size="sm"
          icon={<Plus size={14} aria-hidden />}
          onClick={() => openDoc({ kind: 'scenario', connectorId: props.connectorId, endpointId: props.endpointId })}
        >
          Novo cenário
        </Button>
        <Button
          size="sm"
          icon={<FlaskConical size={14} aria-hidden />}
          disabled={!endpoint?.scenarios.length}
          onClick={() => navigate({ module: 'scenarios', connectorId: props.connectorId, endpointId: props.endpointId, action: 'run' })}
        >
          Rodar cenários
        </Button>
        <Button size="sm" icon={<Network size={14} aria-hidden />} onClick={() => openDoc({ kind: 'connector', connectorId: props.connectorId })}>
          Conector
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {schema ? (
          <EndpointSchemaEditor
            connectorId={props.connectorId}
            endpointId={props.endpointId}
            onClose={() => setSchema(false)}
            onSaved={() => {
              setSchema(false)
              setVersion((v) => v + 1)
              window.dispatchEvent(new Event(WORKSPACE_CHANGED))
            }}
          />
        ) : (
          <Suspense fallback={null}>
            <DocsViewer key={version} scope={scope} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
