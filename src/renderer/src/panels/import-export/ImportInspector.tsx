import { useEffect, useId, useState, type ReactNode } from 'react'
import { Undo2 } from 'lucide-react'
import type {
  ImportAdjustment,
  ImportConflictMode,
  ImportConnectorRef,
  ImportPlanConnector,
  ImportPlanEnvironment,
  ImportPlanEndpoint,
  ImportPlanFlow,
  ImportSyncDecision,
  PostmanImportPreview
} from '@shared/ipc'
import { Badge, Button, InspectorPanel, InspectorSection, MethodBadge } from '../../design-system'
import {
  CONFLICT_HINT,
  CONFLICT_LABEL,
  describeAdjustment,
  fieldClass,
  subtree,
  SYNC_DECISION_LABEL,
  SYNC_FIELD_LABEL,
  SYNC_HINT,
  SYNC_LABEL,
  SYNC_TONE,
  type Selection
} from './model'

interface Props {
  preview: PostmanImportPreview
  selection: Selection
  adjustments: ImportAdjustment[]
  busy: boolean
  onAdjust: (a: ImportAdjustment) => void
  onConflict: (key: string, mode: ImportConflictMode) => void
  onEnvironmentConflict: (key: string, mode: ImportConflictMode) => void
  onFlowConflict: (key: string, mode: ImportConflictMode) => void
  onSyncDecision: (key: string, decision: ImportSyncDecision) => void
  onUndo: () => void
  onReset: () => void
}

/** Ações sobre o item selecionado na revisão e a lista de ajustes feitos, com desfazer. */
export function ImportInspector(props: Props) {
  const { preview, selection } = props
  const connector =
    selection?.kind === 'connector'
      ? preview.connectors.find((c) => c.key === selection.key && (c.origin === 'imported' || c.conflict))
      : undefined
  const endpointOwner =
    selection?.kind === 'endpoint'
      ? preview.connectors.find((c) => c.key === selection.connectorKey && (c.origin === 'imported' || c.conflict === 'merge'))
      : undefined
  const endpoint = selection?.kind === 'endpoint' ? endpointOwner?.endpoints.find((e) => e.id === selection.endpointId) : undefined
  const environment = selection?.kind === 'environment' ? preview.environments.find((e) => e.key === selection.key) : undefined
  const flow = selection?.kind === 'flow' ? preview.flows.find((f) => f.key === selection.key) : undefined
  const synced = selection?.kind === 'sync' ? preview.connectors.flatMap((c) => c.endpoints).find((e) => e.sync?.key === selection.key) : undefined
  const errors = new Map(preview.adjustmentErrors.map((e) => [e.adjustment, e.message]))

  return (
    <InspectorPanel id="import-review" title="Revisão">
      {connector && <ConnectorActions {...props} connector={connector} />}
      {endpointOwner && endpoint && (
        <EndpointActions {...props} owner={endpointOwner} endpointId={endpoint.id} key={`${endpointOwner.key}/${endpoint.id}`} />
      )}
      {environment && <EnvironmentActions {...props} environment={environment} />}
      {flow && <FlowActions {...props} flow={flow} />}
      {synced && <SyncActions {...props} endpoint={synced} />}
      {!connector && !endpoint && !environment && !flow && !synced && (
        <p className="px-3 py-3 text-xs text-muted">
          Selecione um conector, endpoint, ambiente ou fluxo para renomear, mudar de pai, agrupar, mover, mesclar
          como cenário ou deixar de fora.
        </p>
      )}
      <InspectorSection
        title="Ajustes"
        count={props.adjustments.length}
        actions={
          props.adjustments.length > 0 && (
            <Button size="sm" variant="ghost" icon={<Undo2 size={13} aria-hidden />} disabled={props.busy} onClick={props.onUndo}>
              Desfazer
            </Button>
          )
        }
      >
        {props.adjustments.length === 0 ? (
          <p className="text-xs text-muted">Nenhum ajuste: o import segue a estrutura dos arquivos.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {props.adjustments.map((a, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs">
                <span className="w-4 shrink-0 text-right text-faint">{i + 1}.</span>
                <span className="min-w-0 flex-1">
                  {describeAdjustment(a, preview)}
                  {errors.has(i) && <span className="block text-danger">não aplicado: {errors.get(i)}</span>}
                </span>
              </div>
            ))}
            <Button size="sm" variant="ghost" className="mt-1 self-start" disabled={props.busy} onClick={props.onReset}>
              Desfazer todos
            </Button>
          </div>
        )}
      </InspectorSection>
    </InspectorPanel>
  )
}

function ConnectorActions(props: Props & { connector: ImportPlanConnector }) {
  const c = props.connector
  const merged = c.conflict === 'merge'
  const blocked = subtree(props.preview.connectors, c.key)
  const parentOptions = props.preview.connectors.filter((p) => p.origin === 'imported' && !blocked.has(p.id))
  const currentParent = (() => {
    const p = props.preview.connectors.find((x) => x.id === c.extends)
    if (!c.extends) return ''
    return p?.origin === 'imported' ? refValue({ id: p.key }) : refValue({ id: c.extends, existing: true })
  })()
  const [selected, setSelected] = useState<string[]>([])
  const [group, setGroup] = useState('')
  useEffect(() => {
    setSelected([])
    setGroup('')
  }, [c.key])

  return (
    <>
      <InspectorSection title="Conector">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-mono text-muted">{c.id}</span>
            {c.conflict && <Badge tone="warning">id já existe no projeto</Badge>}
          </div>
          {c.conflict && (
            <Labeled label="Quando o id já existe">
              {(id) => (
                <select
                  id={id}
                  className={fieldClass}
                  value={c.conflict}
                  disabled={props.busy}
                  onChange={(e) => props.onConflict(c.key, e.target.value as ImportConflictMode)}
                >
                  {(Object.keys(CONFLICT_LABEL) as ImportConflictMode[]).map((m) => (
                    <option key={m} value={m}>
                      {CONFLICT_LABEL[m]}
                    </option>
                  ))}
                </select>
              )}
            </Labeled>
          )}
          {c.conflict && <p className="-mt-2 text-xs text-muted">{CONFLICT_HINT[c.conflict]}</p>}
          {!merged && (
            <>
              <CommitField
                label="Nome"
                value={c.name}
                disabled={props.busy}
                onCommit={(name) => props.onAdjust({ op: 'renameConnector', id: c.key, name })}
              />
              <Labeled label="Herda de">
                {(id) => (
                  <select
                    id={id}
                    className={fieldClass}
                    value={currentParent}
                    disabled={props.busy}
                    onChange={(e) =>
                      props.onAdjust({ op: 'setParent', id: c.key, parent: e.target.value ? parseRef(e.target.value) : null })
                    }
                  >
                    <option value="">(nenhum: conector raiz)</option>
                    <optgroup label="Deste import">
                      {parentOptions.map((p) => (
                        <option key={p.key} value={refValue({ id: p.key })}>
                          {p.name} ({p.id})
                        </option>
                      ))}
                    </optgroup>
                    {props.preview.projectConnectors.length > 0 && (
                      <optgroup label="Do projeto">
                        {props.preview.projectConnectors.map((p) => (
                          <option key={p.id} value={refValue({ id: p.id, existing: true })}>
                            {p.name} ({p.id})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}
              </Labeled>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {!merged && c.extends && (
              <Button
                size="sm"
                disabled={props.busy}
                title="Os endpoints e os filhos sobem para o conector pai"
                onClick={() => props.onAdjust({ op: 'dissolveConnector', id: c.key })}
              >
                Desfazer pasta
              </Button>
            )}
            <Button size="sm" variant="danger" disabled={props.busy} onClick={() => props.onAdjust({ op: 'excludeConnector', id: c.key })}>
              Não importar
            </Button>
          </div>
        </div>
      </InspectorSection>
      {!merged && c.endpoints.length > 1 && (
        <InspectorSection title="Agrupar endpoints" defaultOpen={false}>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted">Cria um conector filho com os endpoints marcados.</p>
            <div className="flex max-h-48 flex-col gap-1 overflow-auto">
              {c.endpoints.map((e) => (
                <label key={e.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.includes(e.id)}
                    onChange={(ev) =>
                      setSelected((s) => (ev.target.checked ? [...s, e.id] : s.filter((x) => x !== e.id)))
                    }
                  />
                  <MethodBadge method={e.method} className="w-14" />
                  <span className="truncate">{e.name}</span>
                </label>
              ))}
            </div>
            <Labeled label="Nome do grupo">
              {(id) => <input id={id} className={fieldClass} value={group} onChange={(e) => setGroup(e.target.value)} />}
            </Labeled>
            <Button
              size="sm"
              className="self-start"
              disabled={props.busy || !group.trim() || selected.length === 0}
              onClick={() => props.onAdjust({ op: 'groupEndpoints', id: c.key, endpointIds: selected, name: group })}
            >
              Agrupar
            </Button>
          </div>
        </InspectorSection>
      )}
    </>
  )
}

function EndpointActions(props: Props & { owner: ImportPlanConnector; endpointId: string }) {
  const { owner, preview } = props
  const e = owner.endpoints.find((x) => x.id === props.endpointId)!
  const suggestion = preview.suggestions.find((s) => s.connectorId === owner.key && s.endpointId === e.id)
  const [target, setTarget] = useState(() =>
    suggestion ? JSON.stringify({ connector: { id: suggestion.into.connectorId }, endpointId: suggestion.into.endpointId }) : ''
  )
  const [scenarioName, setScenarioName] = useState('')

  // Destinos de cenário: endpoints com o mesmo método, do import e do projeto.
  const imported = preview.connectors
    .filter((c) => c.origin === 'imported')
    .flatMap((c) => c.endpoints.filter((x) => x.method === e.method && !(c.key === owner.key && x.id === e.id)).map((x) => ({ c, x })))
  const project = preview.projectConnectors.flatMap((c) =>
    c.endpoints.filter((x) => x.method === e.method).map((x) => ({ c, x }))
  )
  const moveTargets = preview.connectors.filter((c) => c.origin === 'imported' && c.key !== owner.key)

  return (
    <>
      <InspectorSection title="Endpoint">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs">
            <MethodBadge method={e.method} className="w-14" />
            <span className="truncate font-mono">{e.path}</span>
          </div>
          <CommitField
            label="Nome"
            value={e.name}
            disabled={props.busy}
            onCommit={(name) => props.onAdjust({ op: 'renameEndpoint', connectorId: owner.key, endpointId: e.id, name })}
          />
          <Labeled label="Mover para">
            {(id) => (
              <select
                id={id}
                className={fieldClass}
                value=""
                disabled={props.busy}
                onChange={(ev) =>
                  ev.target.value &&
                  props.onAdjust({ op: 'moveEndpoint', connectorId: owner.key, endpointId: e.id, to: parseRef(ev.target.value) })
                }
              >
                <option value="">{owner.name} (atual)</option>
                <optgroup label="Deste import">
                  {moveTargets.map((c) => (
                    <option key={c.key} value={refValue({ id: c.key })}>
                      {c.name} ({c.id})
                    </option>
                  ))}
                </optgroup>
                {preview.projectConnectors.length > 0 && (
                  <optgroup label="Do projeto">
                    {preview.projectConnectors.map((c) => (
                      <option key={c.id} value={refValue({ id: c.id, existing: true })}>
                        {c.name} ({c.id})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
          </Labeled>
          <Button
            size="sm"
            variant="danger"
            className="self-start"
            disabled={props.busy}
            onClick={() => props.onAdjust({ op: 'excludeEndpoint', connectorId: owner.key, endpointId: e.id })}
          >
            Não importar
          </Button>
        </div>
      </InspectorSection>
      <InspectorSection title="Mesclar como cenário">
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            A requisição vira um cenário de teste do endpoint escolhido: o que muda (corpo, headers, query, parâmetros
            do caminho) vira override, e o teste de status do Postman vira a asserção.
          </p>
          {suggestion && (
            <p className="text-xs text-accent">Parece uma variação de "{suggestion.into.endpointName}".</p>
          )}
          <Labeled label="Endpoint">
            {(id) => (
              <select id={id} className={fieldClass} value={target} onChange={(ev) => setTarget(ev.target.value)}>
                <option value="">Escolha…</option>
                {imported.length > 0 && (
                  <optgroup label="Deste import">
                    {imported.map(({ c, x }) => (
                      <option key={`${c.key}/${x.id}`} value={JSON.stringify({ connector: { id: c.key }, endpointId: x.id })}>
                        {x.name} · {x.path}
                      </option>
                    ))}
                  </optgroup>
                )}
                {project.length > 0 && (
                  <optgroup label="Do projeto">
                    {project.map(({ c, x }) => (
                      <option
                        key={`${c.id}/${x.id}`}
                        value={JSON.stringify({ connector: { id: c.id, existing: true }, endpointId: x.id })}
                      >
                        {c.name} › {x.name} · {x.path}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
          </Labeled>
          <Labeled label="Nome do cenário (opcional)">
            {(id) => (
              <input
                id={id}
                className={fieldClass}
                value={scenarioName}
                placeholder={suggestion?.scenarioName ?? e.name}
                onChange={(ev) => setScenarioName(ev.target.value)}
              />
            )}
          </Labeled>
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            disabled={props.busy || !target}
            onClick={() =>
              props.onAdjust({
                op: 'mergeIntoScenario',
                connectorId: owner.key,
                endpointId: e.id,
                into: JSON.parse(target) as { connector: ImportConnectorRef; endpointId: string },
                ...(scenarioName.trim() ? { name: scenarioName.trim() } : {})
              })
            }
          >
            Mesclar como cenário
          </Button>
        </div>
      </InspectorSection>
    </>
  )
}

function EnvironmentActions(props: Props & { environment: ImportPlanEnvironment }) {
  const env = props.environment
  return (
    <InspectorSection title="Ambiente">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{env.name}</span>
          <span className="font-mono text-muted">{env.id}</span>
        </div>
        {env.conflict && (
          <>
            <Labeled label="Quando o id já existe">
              {(id) => (
                <select
                  id={id}
                  className={fieldClass}
                  value={env.conflict}
                  disabled={props.busy || env.excluded}
                  onChange={(e) => props.onEnvironmentConflict(env.key, e.target.value as ImportConflictMode)}
                >
                  {(Object.keys(CONFLICT_LABEL) as ImportConflictMode[]).map((m) => (
                    <option key={m} value={m}>
                      {CONFLICT_LABEL[m]}
                    </option>
                  ))}
                </select>
              )}
            </Labeled>
            <p className="-mt-2 text-xs text-muted">{CONFLICT_HINT[env.conflict]}</p>
          </>
        )}
        {env.excluded ? (
          <p className="text-xs text-muted">Fora do import. Desfaça o ajuste na lista abaixo para trazer de volta.</p>
        ) : (
          <Button
            size="sm"
            variant="danger"
            className="self-start"
            disabled={props.busy}
            onClick={() => props.onAdjust({ op: 'excludeEnvironment', id: env.key })}
          >
            Não importar
          </Button>
        )}
      </div>
    </InspectorSection>
  )
}

function FlowActions(props: Props & { flow: ImportPlanFlow }) {
  const flow = props.flow
  return (
    <InspectorSection title="Fluxo">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{flow.name}</span>
          <span className="font-mono text-muted">{flow.id}</span>
        </div>
        {flow.missingConnectors && (
          <p className="text-xs text-danger">
            Usa conector(es) que não vão estar no projeto: {flow.missingConnectors.join(', ')}.
          </p>
        )}
        {flow.conflict && (
          <>
            <Labeled label="Quando o id já existe">
              {(id) => (
                <select
                  id={id}
                  className={fieldClass}
                  value={flow.conflict}
                  disabled={props.busy || flow.excluded}
                  onChange={(e) => props.onFlowConflict(flow.key, e.target.value as ImportConflictMode)}
                >
                  {(Object.keys(CONFLICT_LABEL) as ImportConflictMode[]).map((m) => (
                    <option key={m} value={m}>
                      {m === 'merge' ? 'manter o do projeto' : CONFLICT_LABEL[m]}
                    </option>
                  ))}
                </select>
              )}
            </Labeled>
            <p className="-mt-2 text-xs text-muted">
              {flow.conflict === 'merge' ? 'Fluxo não é mesclado nó a nó: o do projeto fica como está.' : CONFLICT_HINT[flow.conflict]}
            </p>
          </>
        )}
        {flow.excluded ? (
          <p className="text-xs text-muted">Fora do import. Desfaça o ajuste na lista abaixo para trazer de volta.</p>
        ) : (
          <Button
            size="sm"
            variant="danger"
            className="self-start"
            disabled={props.busy}
            onClick={() => props.onAdjust({ op: 'excludeFlow', id: flow.key })}
          >
            Não importar
          </Button>
        )}
      </div>
    </InspectorSection>
  )
}

const refValue = (ref: ImportConnectorRef) => JSON.stringify(ref.existing ? { id: ref.id, existing: true } : { id: ref.id })
const parseRef = (value: string) => JSON.parse(value) as ImportConnectorRef

/** Reimportação de uma spec: o que mudou no endpoint e se vale a spec ou o projeto. */
function SyncActions(props: Props & { endpoint: ImportPlanEndpoint }) {
  const e = props.endpoint
  const sync = e.sync!
  if (e.status === 'new' || e.status === 'existing') return null
  const labels = SYNC_DECISION_LABEL[e.status]
  return (
    <InspectorSection title="Reimportação da spec">
      <div className="flex flex-col gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <MethodBadge method={e.method} />
          <span className="font-mono">{e.path}</span>
          <Badge tone={SYNC_TONE[e.status]}>{SYNC_LABEL[e.status]}</Badge>
        </div>
        <p className="text-muted">
          {SYNC_HINT[e.status]} Cenários, documentação e o resto do endpoint ficam como estão.
        </p>
        <fieldset className="flex flex-col gap-1.5" disabled={props.busy}>
          <legend className="mb-1 font-medium text-fg">O que fazer</legend>
          {(['spec', 'keep'] as const).map((d) => (
            <label key={d} className="flex items-center gap-2">
              <input
                type="radio"
                name={`sync-${sync.key}`}
                checked={sync.decision === d}
                onChange={() => props.onSyncDecision(sync.key, d)}
              />
              {labels[d]}
            </label>
          ))}
        </fieldset>
        {sync.changes.length > 0 && (
          <div className="flex flex-col gap-2" aria-label="Diferenças">
            <span className="font-medium text-fg">Diferenças (projeto → spec)</span>
            {sync.changes.map((ch) => (
              <div key={ch.field} className="flex flex-col gap-1">
                <span className="text-muted">{SYNC_FIELD_LABEL[ch.field] ?? ch.field}</span>
                <pre className="max-h-40 overflow-auto rounded-[var(--radius-control)] border border-danger/30 bg-danger/5 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">
                  {ch.before ?? '(nada)'}
                </pre>
                <pre className="max-h-40 overflow-auto rounded-[var(--radius-control)] border border-success/30 bg-success/5 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">
                  {ch.after ?? '(nada)'}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </InspectorSection>
  )
}

function Labeled(props: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] font-medium text-muted">
        {props.label}
      </label>
      {props.children(id)}
    </div>
  )
}

/** Texto que vira ajuste ao confirmar (Enter ou sair do campo), não a cada tecla. */
function CommitField(props: { label: string; value: string; disabled?: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value)
  useEffect(() => setDraft(props.value), [props.value])
  const commit = () => {
    const v = draft.trim()
    if (v && v !== props.value) props.onCommit(v)
    else setDraft(props.value)
  }
  return (
    <Labeled label={props.label}>
      {(id) => (
        <input
          id={id}
          className={fieldClass}
          value={draft}
          disabled={props.disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setDraft(props.value)
          }}
        />
      )}
    </Labeled>
  )
}
