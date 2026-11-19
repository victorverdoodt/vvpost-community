import { useEffect, useState } from 'react'
import type { AssertionOperator, Connector, ConnectorSource } from '@shared/ipc'
import {
  JsonField,
  KeyValueEditor,
  Section,
  SelectField,
  TextField,
  fieldClass,
  inputClass,
  prune,
  smallButton
} from './fields'
import { buttonClass, ErrorNotice, ResizablePane } from '../../../design-system'

type Endpoint = NonNullable<Connector['endpoints']>[number]
type Scenario = NonNullable<Endpoint['scenarios']>[number]
type Assertion = Scenario['assertions'][number]

const OPERATORS: { value: AssertionOperator; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'notEquals' },
  { value: 'lessThan', label: 'lessThan' },
  { value: 'lessThanOrEqual', label: 'lessThanOrEqual' },
  { value: 'greaterThan', label: 'greaterThan' },
  { value: 'greaterThanOrEqual', label: 'greaterThanOrEqual' },
  { value: 'contains', label: 'contains' },
  { value: 'matches', label: 'matches (regex)' },
  { value: 'exists', label: 'exists' },
  { value: 'notExists', label: 'notExists' },
  { value: 'matchesSchema', label: 'matchesSchema' },
  { value: 'matchesExample', label: 'matchesExample (schema do exemplo)' }
]

const newScenario = (taken: Set<string>): Scenario => {
  let n = taken.size + 1
  while (taken.has(`cenario-${n}`)) n++
  return {
    id: `cenario-${n}`,
    name: 'Novo cenário',
    assertions: [{ target: 'status', operator: 'equals', expected: 200 }]
  }
}

const CAPTURE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const CAPTURE_SOURCE = /^(status|body|body(\.|\[).+|headers\..+)$/

/** Chave de um cenário em dependsOn: "<endpoint>/<cenário>" do mesmo conector. */
const scenarioKey = (endpointId: string, scenarioId: string) => `${endpointId}/${scenarioId}`

/**
 * Editor dos cenários table-driven de um conector: overrides de corpo,
 * headers, query e parâmetros de rota, encadeamento (dependsOn e capture) e as
 * asserções, com os ambientes em que cada uma vale. Grava o arquivo do conector
 * inteiro, que é onde os cenários moram.
 */
export function ScenarioEditor(props: {
  connectorId: string
  endpointId?: string
  scenarioId?: string
  /** Ambientes do workspace, para restringir uma asserção a alguns deles. */
  environments?: readonly { id: string; name: string }[]
  onDone: (saved: boolean) => void
}) {
  const [source, setSource] = useState<ConnectorSource | null>(null)
  const [draft, setDraft] = useState<Connector | null>(null)
  const [endpointIndex, setEndpointIndex] = useState(0)
  const [scenarioIndex, setScenarioIndex] = useState<number | null>(null)
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.vvpost.readConnector(props.connectorId).then((r) => {
      if (!r.ok) return setError(r.message)
      setSource(r.value)
      setDraft(r.value.connector)
      const endpoints = r.value.connector.endpoints ?? []
      const ei = Math.max(
        0,
        endpoints.findIndex((e) => e.id === props.endpointId)
      )
      setEndpointIndex(ei)
      const scenarios = endpoints[ei]?.scenarios ?? []
      if (props.scenarioId)
        setScenarioIndex(
          Math.max(
            0,
            scenarios.findIndex((s) => s.id === props.scenarioId)
          )
        )
      else if (props.endpointId) {
        // Pedido de um cenário novo no endpoint.
        const created = newScenario(new Set(scenarios.map((s) => s.id)))
        const next = endpoints.map((e, i) => (i === ei ? { ...e, scenarios: [...scenarios, created] } : e))
        setDraft({ ...r.value.connector, endpoints: next })
        setScenarioIndex(scenarios.length)
      } else setScenarioIndex(scenarios.length ? 0 : null)
    })
  }, [props.connectorId, props.endpointId, props.scenarioId])

  if (!draft) return error ? <p className="text-sm text-danger">{error}</p> : null

  const endpoints = draft.endpoints ?? []
  const endpoint = endpoints[endpointIndex]
  const scenarios = endpoint?.scenarios ?? []
  const scenario = scenarioIndex === null ? undefined : scenarios[scenarioIndex]

  const setScenarios = (next: Scenario[]) =>
    setDraft({ ...draft, endpoints: endpoints.map((e, i) => (i === endpointIndex ? { ...e, scenarios: next } : e)) })
  const setScenario = (patch: Partial<Scenario>) => {
    if (scenarioIndex === null || !endpoint) return
    const current = scenarios[scenarioIndex]!
    // Trocar o id leva junto o dependsOn de quem dependia do cenário, em todo endpoint.
    const from = patch.id !== undefined && patch.id !== current.id ? scenarioKey(endpoint.id, current.id) : null
    const to = from ? scenarioKey(endpoint.id, patch.id!) : null
    const relink = (s: Scenario): Scenario =>
      from && s.dependsOn?.includes(from) ? { ...s, dependsOn: s.dependsOn.map((d) => (d === from ? to! : d)) } : s
    setDraft({
      ...draft,
      endpoints: endpoints.map((e, ei) => ({
        ...e,
        ...(e.scenarios && {
          scenarios: e.scenarios.map((s, si) => relink(ei === endpointIndex && si === scenarioIndex ? { ...s, ...patch } : s))
        })
      }))
    })
  }
  const setOverrides = (patch: Partial<NonNullable<Scenario['overrides']>>) =>
    setScenario({ overrides: { ...scenario?.overrides, ...patch } })
  const setAssertion = (i: number, patch: Partial<Assertion>) =>
    scenario &&
    setScenario({
      assertions: scenario.assertions.map((a, j) => (j === i ? { ...a, ...patch } : a)) as Scenario['assertions']
    })
  const validity = (key: string) => (valid: boolean) =>
    setInvalid((prev) => {
      const next = new Set(prev)
      if (valid) next.delete(key)
      else next.add(key)
      return next
    })

  const save = async () => {
    if (!source) return
    setSaving(true)
    setError(null)
    try {
      const r = await window.vvpost.saveConnector(prune(draft), source.file, source.version)
      if (!r.ok) return setError(r.message)
      props.onDone(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 gap-3 text-xs"
      aria-label={`Editar cenários de ${draft.name}`}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <ResizablePane
        as="nav"
        id="catalog.scenarios"
        edge="right"
        label="Largura da lista de cenários"
        defaultSize={224}
        min={160}
        max={480}
        className="flex flex-col gap-2 overflow-auto pr-1"
        aria-label="Cenários do endpoint"
      >
        <SelectField
          label="Endpoint"
          value={String(endpointIndex)}
          options={endpoints.map((e, i) => ({ value: String(i), label: `${e.method} ${e.path} · ${e.name}` }))}
          onChange={(v) => {
            const i = Number(v)
            setEndpointIndex(i)
            setScenarioIndex(endpoints[i]?.scenarios?.length ? 0 : null)
          }}
        />
        <ul className="flex flex-col gap-0.5">
          {scenarios.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setScenarioIndex(i)}
                className={`w-full rounded-md px-2 py-1.5 text-left ${i === scenarioIndex ? 'bg-border text-fg' : 'text-muted hover:bg-border/50'}`}
              >
                {s.name}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={`${smallButton} self-start`}
          disabled={!endpoint}
          onClick={() => {
            setScenarios([...scenarios, newScenario(new Set(scenarios.map((s) => s.id)))])
            setScenarioIndex(scenarios.length)
          }}
        >
          + Novo cenário
        </button>
      </ResizablePane>

      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto pr-2">
        {!scenario ? (
          <p className="text-muted">
            {endpoint ? 'Este endpoint não tem cenários. Crie um.' : 'O conector não tem endpoints.'}
          </p>
        ) : (
          <>
            <Section
              title="Cenário"
              actions={
                <button
                  type="button"
                  className={smallButton}
                  onClick={() => {
                    setScenarios(scenarios.filter((_, i) => i !== scenarioIndex))
                    setScenarioIndex(scenarios.length > 1 ? 0 : null)
                  }}
                >
                  Apagar cenário
                </button>
              }
            >
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  label="Id"
                  required
                  mono
                  value={scenario.id}
                  onChange={(v) => setScenario({ id: v ?? '' })}
                />
                <TextField
                  label="Nome"
                  required
                  value={scenario.name}
                  onChange={(v) => setScenario({ name: v ?? '' })}
                />
              </div>
              <TextField
                label="Descrição"
                value={scenario.description}
                onChange={(v) => setScenario({ description: v })}
              />
            </Section>

            <ChainingSection
              connectorEndpoints={endpoints}
              self={endpoint ? scenarioKey(endpoint.id, scenario.id) : ''}
              scenario={scenario}
              onChange={setScenario}
              onValidity={validity('capture')}
            />

            <Section title="Overrides">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={scenario.overrides?.headers === null}
                  onChange={(e) => setOverrides({ headers: e.target.checked ? null : undefined })}
                />
                Sem headers nem auth herdados (ex.: testar 401)
              </label>
              {scenario.overrides?.headers !== null && (
                <KeyValueEditor
                  label="Header"
                  allowRemove
                  value={scenario.overrides?.headers}
                  onChange={(headers) => setOverrides({ headers })}
                />
              )}
              <div className="grid grid-cols-2 gap-3">
                <KeyValueEditor
                  label="Query"
                  allowRemove
                  value={scenario.overrides?.query}
                  onChange={(query) => setOverrides({ query })}
                />
                <KeyValueEditor
                  label="Parâmetro de rota"
                  value={scenario.overrides?.pathParams}
                  onChange={(v) => setOverrides({ pathParams: v as Record<string, string> | undefined })}
                />
              </div>
              <JsonField
                label="Corpo (substitui o padrão do endpoint)"
                value={scenario.overrides?.body}
                onChange={(body) => setOverrides({ body })}
                onValidity={validity('body')}
                hint={endpoint?.body !== undefined ? 'Vazio usa o corpo padrão do endpoint.' : undefined}
                rows={6}
              />
            </Section>

            <Section
              title={`Asserções (${scenario.assertions.length})`}
              actions={
                <button
                  type="button"
                  className={smallButton}
                  onClick={() =>
                    setScenario({
                      assertions: [
                        ...scenario.assertions,
                        { target: 'body.', operator: 'exists' }
                      ] as Scenario['assertions']
                    })
                  }
                >
                  + Asserção
                </button>
              }
            >
              <p className="text-[11px] text-muted">
                Alvo: status, responseTimeMs, body, body.caminho ou headers.nome. O esperado é JSON (200, true,
                "texto"); texto solto vira string. Sem ambiente marcado, a asserção vale em todos.
              </p>
              <ol className="flex flex-col gap-2">
                {scenario.assertions.map((a, i) => (
                  <li key={i} className="flex flex-col gap-1" aria-label={`Asserção ${i + 1}`}>
                    <div className="flex items-start gap-2">
                    <input
                      aria-label={`Alvo da asserção ${i + 1}`}
                      className={`${fieldClass} w-48 shrink-0 font-mono`}
                      value={a.target}
                      onChange={(e) => setAssertion(i, { target: e.target.value })}
                    />
                    <select
                      aria-label={`Operador da asserção ${i + 1}`}
                      className={`${fieldClass} w-40 shrink-0`}
                      value={a.operator}
                      onChange={(e) => {
                        const operator = e.target.value as AssertionOperator
                        setAssertion(i, {
                          operator,
                          ...(operator === 'exists' || operator === 'notExists' || operator === 'matchesExample' ? { expected: undefined } : {}),
                          ...(operator === 'matchesExample' && { target: 'body' })
                        })
                      }}
                    >
                      {OPERATORS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <div className="min-w-0 flex-1">
                      {a.operator === 'exists' || a.operator === 'notExists' ? null : a.operator === 'matchesExample' ? (
                        <p className="py-1 text-xs text-muted">O corpo segue o schema do exemplo de resposta do mesmo status.</p>
                      ) : a.operator === 'matchesSchema' ? (
                        <JsonField
                          label="JSON Schema esperado"
                          value={a.expected}
                          onChange={(expected) => setAssertion(i, { expected })}
                          onValidity={validity(`assert-${i}`)}
                        />
                      ) : (
                        <ExpectedInput
                          index={i}
                          value={a.expected}
                          onChange={(expected) => setAssertion(i, { expected })}
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className={smallButton}
                      aria-label={`Apagar asserção ${i + 1}`}
                      disabled={scenario.assertions.length === 1}
                      title={
                        scenario.assertions.length === 1 ? 'Um cenário precisa de ao menos uma asserção' : undefined
                      }
                      onClick={() =>
                        setScenario({
                          assertions: scenario.assertions.filter((_, j) => j !== i) as Scenario['assertions']
                        })
                      }
                    >
                      ×
                    </button>
                    </div>
                    <AssertionEnvironments
                      index={i}
                      environments={props.environments ?? []}
                      value={a.environments}
                      onChange={(environments) => setAssertion(i, { environments })}
                    />
                  </li>
                ))}
              </ol>
            </Section>
          </>
        )}
        {error && (
          <ErrorNotice
            compact
            title="O cenário não foi salvo"
            code="SCHEMA_INVALID"
            message={error}
            location={source?.file}
            hint="Corrija o que a mensagem aponta e salve de novo; nada foi gravado no arquivo."
          />
        )}
        <div className="flex items-center gap-2">
          {source && <span className="font-mono text-muted">{source.file}</span>}
          <span className="ml-auto" />
          <button type="button" className={smallButton} onClick={() => props.onDone(false)}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving || invalid.size > 0}
            className={buttonClass('primary', 'md')}
          >
            Salvar cenários
          </button>
        </div>
      </div>
    </form>
  )
}

/** Valor esperado numa linha: lido como JSON quando dá (200, true, null, "x"), senão como texto. */
function ExpectedInput(props: { index: number; value: unknown; onChange: (value: unknown) => void }) {
  // Uma string que pareceria outro tipo ("200", "true") aparece com aspas.
  const show = (v: unknown) => (v === undefined ? '' : typeof v === 'string' && parse(v) === v ? v : JSON.stringify(v))
  const [text, setText] = useState(() => show(props.value))
  useEffect(() => {
    if (parse(text) !== props.value && JSON.stringify(parse(text)) !== JSON.stringify(props.value))
      setText(show(props.value))
  }, [JSON.stringify(props.value)])
  return (
    <input
      aria-label={`Esperado da asserção ${props.index + 1}`}
      className={`${inputClass} font-mono`}
      placeholder="esperado"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        props.onChange(parse(e.target.value))
      }}
    />
  )
}

function parse(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Encadeamento: os cenários que rodam antes deste, no mesmo ambiente, e os
 * valores da resposta deste que os seguintes leem com {{$capture.<nome>}}.
 */
function ChainingSection(props: {
  connectorEndpoints: Endpoint[]
  self: string
  scenario: Scenario
  onChange: (patch: Partial<Scenario>) => void
  onValidity: (valid: boolean) => void
}) {
  const deps = props.scenario.dependsOn ?? []
  const options = props.connectorEndpoints.flatMap((e) =>
    (e.scenarios ?? []).map((s) => ({ key: scenarioKey(e.id, s.id), label: s.name, endpoint: `${e.method} ${e.path}` }))
  )
  const known = new Set(options.map((o) => o.key))
  const missing = deps.filter((d) => !known.has(d))
  const choices = options.filter((o) => o.key !== props.self)
  const toggle = (key: string, on: boolean) => {
    const next = on ? [...deps, key] : deps.filter((d) => d !== key)
    props.onChange({ dependsOn: next.length ? next : undefined })
  }

  const capture = props.scenario.capture
  const problems = Object.entries(capture ?? {}).flatMap(([name, source]) => [
    ...(CAPTURE_NAME.test(name) ? [] : [`"${name}": o nome usa letras, números e _, sem começar por número`]),
    ...(CAPTURE_SOURCE.test(source) ? [] : [`"${name}": a origem é status, body, body.caminho ou headers.nome`])
  ])
  const valid = problems.length === 0
  useEffect(() => props.onValidity(valid), [valid])

  return (
    <Section title="Encadeamento">
      <fieldset className="flex flex-col gap-1" aria-label="Depende de">
        <legend className="mb-1 text-xs text-muted">Depende de (rodam antes, no mesmo ambiente; se um falhar, este não é enviado)</legend>
        {choices.length === 0 && !missing.length ? (
          <span className="text-[11px] text-muted">O conector não tem outros cenários.</span>
        ) : (
          <div className="flex max-h-40 flex-col gap-0.5 overflow-auto">
            {choices.map((o) => (
              <label key={o.key} className="flex items-center gap-2">
                <input type="checkbox" checked={deps.includes(o.key)} onChange={(e) => toggle(o.key, e.target.checked)} />
                <span>{o.label}</span>
                <span className="truncate font-mono text-muted">
                  {o.key} · {o.endpoint}
                </span>
              </label>
            ))}
            {missing.map((key) => (
              <label key={key} className="flex items-center gap-2 text-warning">
                <input type="checkbox" checked onChange={() => toggle(key, false)} />
                <span className="font-mono">{key}</span>
                <span>não existe neste conector</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <KeyValueEditor
        label="Captura"
        namePlaceholder="nome"
        valuePlaceholder="body.id, headers.location ou status"
        value={capture}
        onChange={(v) => props.onChange({ capture: v as Record<string, string> | undefined })}
      />
      <p className="text-[11px] text-muted">
        Os cenários que dependem deste leem cada valor com <code className="font-mono">{'{{$capture.<nome>}}'}</code> nos
        overrides.
      </p>
      {problems.map((p) => (
        <p key={p} role="alert" className="text-[11px] text-danger">
          {p}
        </p>
      ))}
    </Section>
  )
}

/** Ambientes em que uma asserção vale; nenhum marcado é todos (o campo sai do arquivo). */
function AssertionEnvironments(props: {
  index: number
  environments: readonly { id: string; name: string }[]
  value: string[] | undefined
  onChange: (value: [string, ...string[]] | undefined) => void
}) {
  const chosen = props.value ?? []
  // Ambientes do arquivo que o workspace não tem mais continuam visíveis, para poder tirar.
  const all = [...props.environments, ...chosen.filter((id) => !props.environments.some((e) => e.id === id)).map((id) => ({ id, name: id }))]
  if (all.length < 2 && !chosen.length) return null
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id]
    props.onChange(next.length ? (next as [string, ...string[]]) : undefined)
  }
  return (
    <div className="flex flex-wrap items-center gap-1 pl-1" role="group" aria-label={`Ambientes da asserção ${props.index + 1}`}>
      <span className="text-[11px] text-muted">{chosen.length ? 'Só em' : 'Em todos os ambientes'}</span>
      {all.map((e) => {
        const on = chosen.includes(e.id)
        const gone = !props.environments.some((x) => x.id === e.id)
        return (
          <button
            key={e.id}
            type="button"
            aria-pressed={on}
            title={gone ? 'Este ambiente não existe mais no workspace' : on ? 'Tirar este ambiente' : 'Valer só nos ambientes marcados'}
            onClick={() => toggle(e.id)}
            className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? 'border-accent bg-accent/15 text-fg' : 'border-border text-muted hover:text-fg'} ${gone ? 'line-through' : ''}`}
          >
            {e.name}
          </button>
        )
      })}
    </div>
  )
}
