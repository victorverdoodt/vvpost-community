import { FlaskConical, Folder, FolderInput } from 'lucide-react'
import type { ImportPlanConnector, PostmanImportPreview } from '@shared/ipc'
import { Badge, cx, MethodBadge } from '../../design-system'
import { CONFLICT_LABEL, depths, SYNC_LABEL, SYNC_TONE, type Selection } from './model'

/**
 * Árvore da revisão: conectores pela herança (`extends`), com os endpoints e os
 * cenários de cada um. Conectores do projeto aparecem quando recebem algo ou são pais
 * de um importado. Clicar seleciona; o inspector traz as ações.
 */
export function ImportTree(props: {
  preview: PostmanImportPreview
  selection: Selection
  onSelect: (s: Selection) => void
}) {
  const level = depths(props.preview.connectors)
  return (
    <div role="tree" aria-label="Conectores do import" className="flex flex-col">
      {props.preview.connectors.map((c) => (
        <ConnectorNode
          key={`${c.origin}:${c.id}`}
          connector={c}
          depth={level.get(c.id) ?? 0}
          selection={props.selection}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  )
}

const indent = (depth: number) => ({ paddingLeft: `${8 + depth * 16}px` })

function ConnectorNode(props: {
  connector: ImportPlanConnector
  depth: number
  selection: Selection
  onSelect: (s: Selection) => void
}) {
  const c = props.connector
  // Conector do projeto só aceita receber coisas; o que colide com um importado escolhe o modo.
  const selectable = c.origin === 'imported' || !!c.conflict
  const selected = props.selection?.kind === 'connector' && props.selection.key === c.key && selectable
  const Icon = c.origin === 'existing' ? FolderInput : Folder
  return (
    <div role="treeitem" aria-selected={selected} aria-level={props.depth + 1} aria-label={c.name}>
      <button
        type="button"
        disabled={!selectable}
        onClick={() => props.onSelect({ kind: 'connector', key: c.key })}
        style={indent(props.depth)}
        className={cx(
          'flex h-8 w-full items-center gap-2 pr-3 text-left text-xs transition-colors',
          selected ? 'bg-accent/12 text-fg' : 'hover:bg-border/40',
          !selectable && 'cursor-default hover:bg-transparent'
        )}
      >
        <Icon size={14} aria-hidden className={c.origin === 'existing' ? 'text-info' : 'text-muted'} />
        <span className={cx('truncate font-medium', c.untouched && 'text-muted')}>{c.name}</span>
        <span className="truncate font-mono text-[11px] text-faint">{c.id}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {c.baseUrl && <span className="hidden max-w-56 truncate font-mono text-[11px] text-muted lg:inline">{c.baseUrl}</span>}
          {c.origin === 'existing' ? (
            <Badge tone="info" title="Conector que já está no projeto">
              {c.untouched ? 'no projeto' : 'no projeto · recebe itens'}
            </Badge>
          ) : (
            <Badge tone="success">novo</Badge>
          )}
          {c.conflict && (
            <Badge tone="warning" title="O projeto já tem este id">
              {CONFLICT_LABEL[c.conflict]}
            </Badge>
          )}
        </span>
      </button>
      {!c.untouched && (
        <div role="group">
          {c.endpoints.map((e) => {
            const isNew = e.status === 'new'
            // Endpoints vindos do Postman (também os que entram num conector mesclado) aceitam ajustes.
            const adjustable = isNew && (c.origin === 'imported' || c.conflict === 'merge')
            // Na reimportação de uma spec, o endpoint do projeto escolhe entre a spec e o que está lá.
            const sync = e.sync
            const editable = adjustable || !!sync
            const sel = sync
              ? props.selection?.kind === 'sync' && props.selection.key === sync.key
              : props.selection?.kind === 'endpoint' &&
                props.selection.connectorKey === c.key &&
                props.selection.endpointId === e.id &&
                adjustable
            const newScenarios = e.scenarios.filter((s) => s.isNew).length
            return (
              <div key={e.id} role="treeitem" aria-selected={sel} aria-level={props.depth + 2} aria-label={e.name}>
                <button
                  type="button"
                  disabled={!editable}
                  onClick={() =>
                    props.onSelect(sync ? { kind: 'sync', key: sync.key } : { kind: 'endpoint', connectorKey: c.key, endpointId: e.id })
                  }
                  style={indent(props.depth + 1)}
                  className={cx(
                    'flex h-7 w-full items-center gap-2 pr-3 text-left text-xs transition-colors',
                    sel ? 'bg-accent/12' : 'hover:bg-border/40',
                    !editable && 'cursor-default text-muted hover:bg-transparent'
                  )}
                >
                  <MethodBadge method={e.method} className="w-14" />
                  <span className="truncate font-mono">{e.path}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span className="max-w-60 truncate text-muted">{e.name}</span>
                    {e.scenarios.length > 0 && (
                      <Badge
                        tone={newScenarios ? 'accent' : 'neutral'}
                        title={e.scenarios.map((s) => `${s.name}${s.isNew ? ' (novo)' : ''}`).join('\n')}
                      >
                        <FlaskConical size={11} aria-hidden />
                        {e.scenarios.length} cenário(s){newScenarios && !isNew ? ` · +${newScenarios}` : ''}
                      </Badge>
                    )}
                    {c.origin === 'existing' && isNew && <Badge tone="success">novo</Badge>}
                    {sync && e.status !== 'new' && e.status !== 'existing' && (
                      <Badge
                        tone={SYNC_TONE[e.status]}
                        title={sync.changes.map((ch) => ch.field).join(', ')}
                      >
                        {SYNC_LABEL[e.status]}
                        {sync.decision === 'spec' ? (e.status === 'removed' ? ' · apagar' : ' · aplicar') : ' · manter'}
                      </Badge>
                    )}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
