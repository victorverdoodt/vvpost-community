import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { FlowNode, FlowNodeStatus } from '@shared/ipc'
import { NODE_LABELS } from './model'

export interface CanvasNodeData extends Record<string, unknown> {
  node: FlowNode
  status?: FlowNodeStatus
  durationMs?: number
  /** Resumo do erro ou do motivo do salto. */
  note?: string
  /** Nome da contribuição de plugin (ex.: GraphQL); ausente quando o plugin não está disponível. */
  pluginTitle?: string
  /** Nó de um endpoint do catálogo: método e nome do endpoint, no lugar dos ids. */
  endpointLabel?: string
}

export type CanvasNode = Node<CanvasNodeData, FlowNode['type']>

const STATUS: Record<FlowNodeStatus, { label: string; className: string }> = {
  running: { label: 'rodando', className: 'border-accent text-accent' },
  success: { label: 'ok', className: 'border-success text-success' },
  error: { label: 'erro', className: 'border-danger text-danger' },
  skipped: { label: 'pulado', className: 'border-border text-muted' }
}

function summary(node: FlowNode): string {
  switch (node.type) {
    case 'request': {
      const r = node.request
      const poll = r.poll ? ' · polling' : ''
      if (r.endpoint) return `${r.method ?? ''} ${r.connector ?? ''} · ${r.endpoint}${poll}`.trim()
      return `${r.method ?? 'GET'} ${r.url || '(sem URL)'}${poll}`
    }
    case 'condition':
      return `${node.failWhenFalse ? 'exige ' : ''}${node.condition.target} ${node.condition.operator}`
    case 'wait':
      return `${node.wait.ms} ms`
    case 'webhook': {
      const w = node.webhook
      return [w.method, w.hook && `hook ${w.hook}`, w.path].filter(Boolean).join(' ') || 'qualquer evento'
    }
    case 'python':
      return `${node.python.code.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length} linhas`
    case 'plugin':
      return node.plugin.node ?? `${node.plugin.adapter}${node.plugin.connector ? ` · ${node.plugin.connector}` : ''}`
    case 'oauth2':
      return `${node.oauth2.grantType} · ${node.oauth2.tokenUrl}`
  }
}

function FlowCanvasNode({ data, selected }: NodeProps<CanvasNode>) {
  const { node, status, durationMs, note, pluginTitle, endpointLabel } = data
  const label = node.type === 'plugin' ? (pluginTitle ?? 'Plugin indisponível') : NODE_LABELS[node.type]
  const look = status ? STATUS[status] : null
  return (
    <div
      data-testid={`flow-node-${node.name}`}
      className={`w-56 rounded-lg border bg-panel px-3 py-2 text-xs shadow ${
        selected ? 'border-accent' : look && status !== 'skipped' ? look.className.split(' ')[0] : 'border-border'
      } ${status === 'skipped' ? 'opacity-60' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[10px] uppercase tracking-wide ${node.type === 'plugin' && !pluginTitle ? 'text-warning' : 'text-muted'}`}
        >
          {label}
        </span>
        {look && (
          <span aria-label={`Status de ${node.name}`} className={`rounded border px-1 text-[10px] ${look.className}`}>
            {look.label}
            {durationMs !== undefined && status !== 'skipped' ? ` · ${Math.round(durationMs)} ms` : ''}
          </span>
        )}
      </div>
      <div className="mt-1 truncate font-semibold text-fg">{node.name}</div>
      <div className="truncate font-mono text-[11px] text-muted" title={endpointLabel && summary(node)}>
        {endpointLabel ? `${endpointLabel}${node.type === 'request' && node.request.poll ? ' · polling' : ''}` : summary(node)}
      </div>
      {note && <div className="mt-1 line-clamp-2 text-[11px] text-muted">{note}</div>}
      {node.type === 'condition' && node.failWhenFalse ? (
        // Asserção: só segue quando vale, pela saída "sim".
        <Handle type="source" id="true" position={Position.Right} />
      ) : node.type === 'condition' ? (
        <>
          <Handle type="source" id="true" position={Position.Right} style={{ top: '35%' }} />
          <Handle type="source" id="false" position={Position.Right} style={{ top: '75%' }} />
          <span className="pointer-events-none absolute right-2 top-[28%] text-[9px] text-success">sim</span>
          <span className="pointer-events-none absolute right-2 top-[68%] text-[9px] text-danger">não</span>
        </>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  )
}

export const nodeTypes = {
  request: FlowCanvasNode,
  condition: FlowCanvasNode,
  python: FlowCanvasNode,
  plugin: FlowCanvasNode,
  wait: FlowCanvasNode,
  webhook: FlowCanvasNode,
  oauth2: FlowCanvasNode
}
