import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  HTTP_METHODS,
  type CatalogConnector,
  type Flow,
  type FlowCondition,
  type FlowNode,
  type FlowNodeResult,
  type FlowPlugin,
  type FlowRequest,
  type FlowWebhook,
  type PluginContribution
} from '@shared/ipc'
import { Button, CodeEditor, ErrorNotice, hasFormFields, SchemaForm, SegmentedControl } from '../../design-system'
import { AppServicesContext } from '../../app/shell/useAppServices'
import { nameProblem, NODE_LABELS, pluginKeyOf, type KnownOutputs } from './model'
import { OAuth2Fields } from '../connectors/editor/OAuth2Fields'
import { PythonEditor } from './PythonEditor'
import { PluginFieldInput } from './PluginFields'
import { TemplateInput } from './TemplateInput'

const controlClass = 'min-w-0 border px-2 py-1 text-xs disabled:opacity-50'
const selectClass = `w-full ${controlClass}`

const OPERATORS = [
  'equals',
  'notEquals',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'contains',
  'matches',
  'exists',
  'notExists',
  'matchesSchema'
] as const

interface Props {
  flow: Flow
  node: FlowNode
  connectors: CatalogConnector[]
  /** Contribuições dos plugins ligados, por contributionKey. */
  contributions: ReadonlyMap<string, PluginContribution & { pluginName: string }>
  ancestors: readonly string[]
  outputs: KnownOutputs
  result?: FlowNodeResult
  onChange(node: FlowNode): void
  onRename(name: string): void
  onRemove(): void
  /** Nó de requisição: abre no Quick Request com os $nodes da última execução. */
  onOpenInQuick?(): void
}

/** Propriedade do nó apontada pelo erro da última execução (`request.url`, `python.code`...). */
const InvalidProperty = createContext<string | undefined>(undefined)

/** O caminho do arquivo do fluxo como o formulário chama o campo. */
export function propertyLabel(path: string): string {
  const [, group, rest] = /^(?:request|python|condition|plugin)\.([A-Za-z]+)(?:[.[](.*))?$/.exec(path) ?? []
  const name = rest?.replace(/\]$/, '')
  switch (group) {
    case 'url':
      return 'URL'
    case 'connector':
      return 'Conector'
    case 'endpoint':
      return 'Endpoint'
    case 'body':
      return 'Corpo'
    case 'headers':
      return name ? `header ${name}` : 'Headers'
    case 'query':
      return name ? `query ${name}` : 'Query'
    case 'pathParams':
      return name ? `parâmetro {${name}}` : 'Parâmetros'
    case 'poll':
      return 'Polling'
    case 'code':
      return 'Script Python'
    case 'version':
      return 'Python mínimo'
    case 'target':
      return 'Valor testado'
    case 'expected':
      return 'Esperado'
    case 'config':
      return name ? `campo ${name}` : 'Configuração'
    default:
      return path
  }
}

const matches = (invalid: string | undefined, path: string) =>
  !!invalid && (invalid === path || invalid.startsWith(`${path}.`) || invalid.startsWith(`${path}[`))

/**
 * Área de um campo do nó: com o erro da última execução apontando para ela, a borda e a
 * mensagem ficam em vermelho. "Ir para a propriedade" foca o campo.
 */
function Prop({ path, children }: { path: string; children: ReactNode }) {
  const invalid = useContext(InvalidProperty)
  const hit = matches(invalid, path)
  return (
    <div
      data-property={path}
      aria-invalid={hit || undefined}
      className={hit ? 'rounded-[var(--radius-control)] outline outline-1 outline-offset-2 outline-danger' : undefined}
    >
      {children}
      {hit && (
        <p className="mt-1 text-[11px] text-danger" role="note">
          O erro da última execução vem de {propertyLabel(invalid!)}.
        </p>
      )}
    </div>
  )
}

/** Lista de hosts editada como texto; a lista só muda ao sair do campo, para a vírgula não sumir enquanto digita. */
function HostListInput({
  label,
  value,
  disabled,
  onChange
}: {
  label: string
  value: string[]
  disabled?: boolean
  onChange(hosts: string[]): void
}) {
  const joined = value.join(', ')
  const [text, setText] = useState(joined)
  useEffect(() => setText(joined), [joined])
  const commit = () => {
    const hosts = [...new Set(text.split(/[\s,;]+/).filter(Boolean))]
    if (hosts.join(', ') !== joined) onChange(hosts)
    else setText(joined)
  }
  return (
    <input
      aria-label={label}
      value={text}
      placeholder="sem rede"
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className={`${selectClass} font-mono`}
    />
  )
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  )
}

/** Texto do editor de JSON: objeto/lista formatados; o resto como texto. */
const toText = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)

/** Corpo: um objeto ou lista JSON válido vira JSON; qualquer outra coisa fica como texto. */
function parseBody(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : text
  } catch {
    return text
  }
}

/**
 * O corpo do nó para o formulário: o do nó (objeto, ou texto JSON) ou, sem corpo próprio, o do
 * endpoint, que vira o do nó na primeira mudança.
 */
function formValue(own: unknown, endpointBody: string | undefined): { ok: true; value: unknown } | { ok: false } {
  const source = own !== undefined ? own : endpointBody
  if (source === undefined || source === '') return { ok: true, value: undefined }
  if (typeof source !== 'string') return { ok: true, value: source }
  try {
    return { ok: true, value: JSON.parse(source) }
  } catch {
    return { ok: false }
  }
}

/** O que o nó herda do conector e do endpoint: a requisição sai com tudo isso, como no Quick Request. */
function Inherited({ connector, endpoint }: { connector: CatalogConnector; endpoint: CatalogConnector['endpoints'][number] | undefined }) {
  const headers = [...connector.headers, ...(endpoint?.headers ?? [])]
  const scripts =
    (connector.scripts ?? []).reduce((n, sc) => n + (sc.pre?.trim() ? 1 : 0) + (sc.post?.trim() ? 1 : 0), 0) +
    (endpoint?.scripts?.pre?.trim() ? 1 : 0) +
    (endpoint?.scripts?.post?.trim() ? 1 : 0)
  return (
    <div role="group" aria-label="Herdado pelo nó" className="flex flex-col gap-0.5 rounded border border-border-subtle px-2 py-1.5 text-[11px]">
      <span className="text-muted">
        Herdado de {connector.chain.length > 1 ? connector.chain.join(' → ') : connector.name}
        {endpoint && ` e do endpoint ${endpoint.name}`}
      </span>
      {connector.baseUrl && (
        <span className="truncate font-mono" title={connector.baseUrl}>
          Base: {connector.baseUrl}
        </span>
      )}
      <span>Auth: {connector.auth ? `${connector.auth.summary} (de ${connector.auth.from})` : 'nenhuma'}</span>
      {headers.length > 0 && (
        <span className="truncate font-mono" title={headers.map((h) => `${h.name}: ${h.value}`).join('\n')}>
          Headers: {headers.map((h) => h.name).join(', ')}
        </span>
      )}
      {connector.tlsFrom && <span>Certificado mTLS de {connector.tlsFrom}</span>}
      {scripts > 0 && <span>{scripts === 1 ? '1 script' : `${scripts} scripts`} pre/post em volta do nó</span>}
    </div>
  )
}

/** Valor da condição: JSON (número, true, "texto", objeto) ou o texto cru (ex.: {{ $nodes... }}). */
function parseExpected(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Editor do nó selecionado no canvas e o resultado dele na última execução. */
export function Inspector({
  flow,
  node,
  connectors,
  contributions,
  ancestors,
  outputs,
  result,
  onChange,
  onRename,
  onRemove,
  onOpenInQuick
}: Props) {
  const [name, setName] = useState(node.name)
  useEffect(() => setName(node.name), [node.id, node.name])
  const problem = name === node.name ? null : nameProblem(flow, node.id, name)
  const input = { ancestors, outputs }
  const contribution = node.type === 'plugin' ? contributions.get(pluginKeyOf(node)) : undefined
  const invalid = result?.status === 'error' ? result.error?.property : undefined

  return (
    <InvalidProperty.Provider value={invalid}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {contribution ? `${contribution.title} · ${contribution.pluginName}` : NODE_LABELS[node.type]}
          </h3>
          <span className="flex gap-3">
            {onOpenInQuick && (
              <button type="button" onClick={onOpenInQuick} className="text-xs text-accent hover:underline">
                Abrir no Quick Request
              </button>
            )}
            <button type="button" onClick={onRemove} className="text-xs text-danger hover:underline">
              Excluir nó
            </button>
          </span>
        </div>
        <Field label="Nome" hint={problem ?? <>Referenciado como $nodes.{node.name}</>}>
          <input
            aria-label="Nome do nó"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => (problem || name === node.name ? setName(node.name) : onRename(name))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !problem && name !== node.name) onRename(name)
            }}
            className={`${selectClass} font-mono ${problem ? 'border-danger' : ''}`}
          />
        </Field>

        {node.type === 'request' && (
          <RequestEditor
            nodeName={node.name}
            request={node.request}
            connectors={connectors}
            {...input}
            onChange={(request) => onChange({ ...node, request })}
          />
        )}

        {node.type === 'condition' && (
          <>
            <ConditionFields
              condition={node.condition}
              {...input}
              onChange={(condition) => onChange({ ...node, condition })}
            />
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={node.failWhenFalse ?? false}
                onChange={(e) => {
                  const { failWhenFalse: _, ...rest } = node
                  onChange(e.target.checked ? { ...rest, failWhenFalse: true } : rest)
                }}
              />
              Falhar o fluxo quando não valer (asserção)
            </label>
            <p className="text-[11px] text-muted">
              {node.failWhenFalse
                ? 'Quando não vale, o nó falha e o fluxo termina como falho, no app e no CLI; os nós seguintes só rodam quando vale.'
                : 'A saída "sim" segue quando a condição vale; a "não", quando não vale.'}
            </p>
          </>
        )}

        {node.type === 'wait' && (
          <Field label="Esperar (ms)" hint="O fluxo segue depois desse tempo; cancelar a execução interrompe a espera.">
            <input
              aria-label="Milissegundos de espera"
              type="number"
              min={0}
              max={3600000}
              value={node.wait.ms}
              onChange={(e) =>
                onChange({ ...node, wait: { ms: Math.max(0, Math.round(Number(e.target.value) || 0)) } })
              }
              className={selectClass}
            />
          </Field>
        )}

        {node.type === 'webhook' && (
          <WebhookEditor
            nodeName={node.name}
            webhook={node.webhook}
            {...input}
            onChange={(webhook) => onChange({ ...node, webhook })}
          />
        )}

        {node.type === 'oauth2' && (
          <>
            <p className="text-xs text-muted-foreground">
              O token vai em Authorization nas requisições de quem herda desta base, renovado quando expira.
              Segredos entram como {'{{VARIÁVEL}}'} de um ambiente.
            </p>
            <OAuth2Fields narrow auth={node.oauth2} onChange={(oauth2) => onChange({ ...node, oauth2 })} />
          </>
        )}

        {node.type === 'python' && (
          <>
            <Field
              label="Script Python"
              hint={
                <>
                  <code>nodes</code> tem a saída dos nós anteriores; atribua o resultado a <code>output</code>. Roda num
                  processo separado, com {Math.round((node.python.timeoutMs ?? 10000) / 1000)} s de limite.
                </>
              }
            >
              <Prop path="python.code">
                <PythonEditor
                  value={node.python.code}
                  {...input}
                  onChange={(code) => onChange({ ...node, python: { ...node.python, code } })}
                />
              </Prop>
            </Field>
            <Field
              label="Rede"
              hint={
                <>
                  Hosts que o script acessa, separados por vírgula (ex.: <code>api.example.com, *.acme.com:443</code>;{' '}
                  <code>*</code> libera tudo). Vazio: sem rede, sem subprocessos e sem ctypes.
                </>
              }
            >
              <HostListInput
                label="Rede do script Python"
                value={node.python.network ?? []}
                onChange={(hosts) => {
                  const { network: _, ...rest } = node.python
                  onChange({ ...node, python: hosts.length ? { ...rest, network: hosts } : rest })
                }}
              />
            </Field>
            <Field label="Python mínimo" hint="Com um Python mais antigo que este, o nó falha sem rodar o script.">
              <Prop path="python.version">
                <select
                  aria-label="Versão mínima do Python"
                  className={selectClass}
                  value={node.python.version ?? ''}
                  onChange={(e) => {
                    const { version: _, ...rest } = node.python
                    onChange({ ...node, python: e.target.value ? { ...rest, version: e.target.value } : rest })
                  }}
                >
                  <option value="">3.8 (padrão)</option>
                  {PYTHON_VERSIONS.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Prop>
            </Field>
          </>
        )}

        {node.type === 'plugin' && (
          <PluginEditor
            plugin={node.plugin}
            contribution={contribution}
            connectors={connectors}
            {...input}
            onChange={(plugin) => onChange({ ...node, plugin })}
          />
        )}

        {result && <ResultView result={result} />}
      </div>
    </InvalidProperty.Provider>
  )
}

/**
 * Os conectores do projeto (e do Compartilhado) e, num grupo por projeto, as bases dos outros
 * projetos, que o nó cita como "<projeto>:<id>".
 */
function ConnectorOptions({ connectors }: { connectors: CatalogConnector[] }) {
  const own = connectors.filter((c) => !c.id.includes(':'))
  const others = new Map<string, CatalogConnector[]>()
  for (const c of connectors) {
    if (!c.id.includes(':')) continue
    const group = c.shared ?? c.id.slice(0, c.id.indexOf(':'))
    others.set(group, [...(others.get(group) ?? []), c])
  }
  const option = (c: CatalogConnector) => (
    <option key={c.id} value={c.id} disabled={!!c.error}>
      {c.name}
    </option>
  )
  return (
    <>
      {own.map(option)}
      {[...others].map(([group, list]) => (
        <optgroup key={group} label={group.charAt(0).toUpperCase() + group.slice(1)}>
          {list.map(option)}
        </optgroup>
      ))}
    </>
  )
}

/** Versões que o campo "Python mínimo" oferece; o arquivo aceita qualquer 3.x a partir do 3.8. */
const PYTHON_VERSIONS = ['3.9', '3.10', '3.11', '3.12', '3.13', '3.14']

/** Formulário de um nó de plugin a partir dos campos que a contribuição declara no manifesto. */
function PluginEditor({
  plugin,
  contribution,
  connectors,
  ancestors,
  outputs,
  onChange
}: {
  plugin: FlowPlugin
  contribution: PluginContribution | undefined
  connectors: CatalogConnector[]
  ancestors: readonly string[]
  outputs: KnownOutputs
  onChange(plugin: FlowPlugin): void
}) {
  const name = plugin.node ?? plugin.adapter
  if (!contribution) {
    return (
      <div className="flex flex-col gap-2 text-xs">
        <p className="text-warning">
          {plugin.node ? `O tipo de nó ${name}` : `O adapter ${name}`} não vem de nenhum plugin ligado. Instale ou ligue
          o plugin no Extensions Hub para editar e rodar este nó.
        </p>
        <pre className="overflow-auto rounded bg-surface p-2 font-mono text-[11px]">
          {JSON.stringify(plugin.config ?? {}, null, 2)}
        </pre>
      </div>
    )
  }
  const config = plugin.config ?? {}
  const setValue = (key: string, value: unknown) => {
    const { [key]: _, ...rest } = config
    onChange({ ...plugin, config: value === undefined ? rest : { ...rest, [key]: value } })
  }
  return (
    <>
      {contribution.description && <p className="text-[11px] text-muted">{contribution.description}</p>}
      {contribution.kind === 'adapter' && (
        <Field label="Conector" hint="A baseUrl, os headers e a auth do conector valem para as requisições do adapter.">
          <Prop path="plugin.connector">
            <select
              aria-label="Conector do nó"
              className={selectClass}
              value={plugin.connector ?? ''}
              onChange={(e) => {
                const { connector: _, ...rest } = plugin
                onChange(e.target.value ? { ...rest, connector: e.target.value } : rest)
              }}
            >
              <option value="">Sem conector</option>
              <ConnectorOptions connectors={connectors} />
            </select>
          </Prop>
        </Field>
      )}
      {contribution.fields.map((field) => (
        <PluginFieldInput
          key={field.key}
          field={field}
          value={Object.hasOwn(config, field.key) ? config[field.key] : undefined}
          ancestors={ancestors}
          outputs={outputs}
          onChange={(value) => setValue(field.key, value)}
        />
      ))}
      {contribution.kind === 'adapter' && (
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={plugin.ignoreHttpErrors ?? false}
            onChange={(e) => {
              const { ignoreHttpErrors: _, ...rest } = plugin
              onChange(e.target.checked ? { ...rest, ignoreHttpErrors: true } : rest)
            }}
          />
          Seguir com resposta 4xx/5xx (decidir numa condição)
        </label>
      )}
    </>
  )
}

function ExpectedField({
  value,
  ancestors,
  outputs,
  onChange
}: {
  value: unknown
  ancestors: readonly string[]
  outputs: KnownOutputs
  onChange(value: unknown): void
}) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value)))
  return (
    <Field label="Esperado" hint='JSON (200, true, "PIX") ou {{ $nodes... }} de outro nó'>
      <TemplateInput
        label="Esperado"
        value={text}
        ancestors={ancestors}
        outputs={outputs}
        onChange={(t) => {
          setText(t)
          onChange(parseExpected(t))
        }}
      />
    </Field>
  )
}

/** Valor testado, operador e esperado de uma condição (nó de condição e polling). */
function ConditionFields({
  condition,
  ancestors,
  outputs,
  onChange,
  targetHint = 'Caminho em $nodes de um nó anterior'
}: {
  condition: FlowCondition
  ancestors: readonly string[]
  outputs: KnownOutputs
  onChange(condition: FlowCondition): void
  targetHint?: string
}) {
  const input = { ancestors, outputs }
  return (
    <>
      <Field label="Valor testado" hint={targetHint}>
        <Prop path="condition.target">
          <TemplateInput
            label="Valor testado"
            format="path"
            value={condition.target}
            {...input}
            onChange={(target) => onChange({ ...condition, target })}
          />
        </Prop>
      </Field>
      <Field label="Operador">
        <select
          aria-label="Operador"
          className={selectClass}
          value={condition.operator}
          onChange={(e) => onChange({ ...condition, operator: e.target.value as (typeof OPERATORS)[number] })}
        >
          {OPERATORS.map((op) => (
            <option key={op}>{op}</option>
          ))}
        </select>
      </Field>
      {condition.operator !== 'exists' && condition.operator !== 'notExists' && (
        <ExpectedField
          value={condition.expected}
          {...input}
          onChange={(expected) => {
            const { expected: _, ...rest } = condition
            onChange(expected === undefined ? rest : { ...rest, expected })
          }}
        />
      )}
    </>
  )
}

/** Que evento o nó webhook aceita: hook, método, caminho, condição sobre o evento e tempo limite. */
function WebhookEditor({
  nodeName,
  webhook,
  ancestors,
  outputs,
  onChange
}: {
  nodeName: string
  webhook: FlowWebhook
  ancestors: readonly string[]
  outputs: KnownOutputs
  onChange(webhook: FlowWebhook): void
}) {
  const server = useContext(AppServicesContext)?.webhooks
  const set = (patch: Partial<FlowWebhook>) => {
    const next: Record<string, unknown> = { ...webhook, ...patch }
    for (const [k, v] of Object.entries(next)) if (v === undefined || v === '') delete next[k]
    onChange(next as FlowWebhook)
  }
  const hooks = server?.hooks ?? []
  const base = server?.url ?? 'http://127.0.0.1:4480'
  return (
    <>
      <Field label="Hook" hint="Só eventos que este hook de .vvpost/webhooks.json atendeu">
        <select
          aria-label="Hook do nó"
          className={selectClass}
          value={webhook.hook ?? ''}
          onChange={(e) => set({ hook: e.target.value || undefined })}
        >
          <option value="">Qualquer hook</option>
          {webhook.hook && !hooks.some((h) => h.id === webhook.hook) && (
            <option value={webhook.hook}>{webhook.hook}</option>
          )}
          {hooks.map((h) => (
            <option key={h.id} value={h.id}>
              {h.id} · {h.path}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-2">
        <select
          aria-label="Método do evento"
          className={`${controlClass} w-24 shrink-0`}
          value={webhook.method ?? ''}
          onChange={(e) => set({ method: (e.target.value || undefined) as FlowWebhook['method'] })}
        >
          <option value="">Qualquer</option>
          {HTTP_METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <div className="min-w-0 flex-1">
          <TemplateInput
            label="Caminho do evento"
            placeholder="/pagamentos (vazio: qualquer caminho)"
            value={webhook.path ?? ''}
            {...{ ancestors, outputs }}
            onChange={(path) => set({ path: path ? (path.startsWith('/') ? path : `/${path}`) : undefined })}
          />
        </div>
      </div>
      <p className="font-mono text-[11px] break-all text-muted">
        {webhook.method ?? 'POST'} {base}
        {webhook.path ?? '/…'}
      </p>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={webhook.until !== undefined}
          onChange={(e) =>
            set({
              until: e.target.checked ? { target: `$nodes.${nodeName}.data.body`, operator: 'exists' } : undefined
            })
          }
        />
        Só aceitar o evento quando uma condição valer
      </label>
      {webhook.until && (
        <div className="flex flex-col gap-2 border-l border-border pl-2">
          <ConditionFields
            condition={webhook.until}
            ancestors={[...ancestors, nodeName]}
            outputs={outputs}
            targetHint={`O evento fica em $nodes.${nodeName}.data (method, path, query, headers, body)`}
            onChange={(until) => set({ until })}
          />
        </div>
      )}
      <Field
        label="Tempo limite (ms)"
        hint="Sem evento até lá, o nó falha com WEBHOOK_TIMEOUT. O servidor liga sozinho ao rodar."
      >
        <input
          aria-label="Tempo limite do webhook"
          type="number"
          min={100}
          max={3600000}
          value={webhook.timeoutMs ?? 60000}
          onChange={(e) =>
            set({ timeoutMs: Math.min(3600000, Math.max(100, Math.round(Number(e.target.value) || 0))) })
          }
          className={selectClass}
        />
      </Field>
    </>
  )
}

function RequestEditor({
  nodeName,
  request,
  connectors,
  ancestors,
  outputs,
  onChange
}: {
  nodeName: string
  request: FlowRequest
  connectors: CatalogConnector[]
  ancestors: readonly string[]
  outputs: KnownOutputs
  onChange(request: FlowRequest): void
}) {
  const input = { ancestors, outputs }
  const connector = connectors.find((c) => c.id === request.connector)
  const endpoint = connector?.endpoints.find((e) => e.id === request.endpoint)
  const [bodyText, setBodyText] = useState(() => toText(request.body))
  // Endpoint com bodySchema: o corpo do nó abre no formulário do schema (o JSON continua a um clique).
  const bodySchema = endpoint?.bodySchema && hasFormFields(endpoint.bodySchema) ? endpoint.bodySchema : undefined
  const [bodyView, setBodyView] = useState<'form' | 'json'>('form')
  const formBody = bodySchema && bodyView === 'form' ? formValue(request.body, endpoint?.body) : undefined
  const params = endpoint ? [...endpoint.path.matchAll(/(?<!\{)\{([A-Za-z0-9_.-]+)\}(?!\})/g)].map((m) => m[1]!) : []

  const set = (patch: Partial<FlowRequest>) => {
    const next: FlowRequest = { ...request, ...patch }
    for (const key of Object.keys(next) as (keyof FlowRequest)[]) if (next[key] === undefined) delete next[key]
    onChange(next)
  }

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Field label="Conector">
          <Prop path="request.connector">
            <select
              aria-label="Conector do nó"
              className={selectClass}
              value={request.connector ?? ''}
              onChange={(e) => {
                const id = e.target.value || undefined
                // Sem conector não há endpoint; method e url passam a descrever a requisição.
                set(
                  id
                    ? { connector: id, endpoint: undefined }
                    : {
                        connector: undefined,
                        endpoint: undefined,
                        method: request.method ?? 'GET',
                        url: request.url ?? ''
                      }
                )
              }}
            >
              <option value="">Sem conector</option>
              <ConnectorOptions connectors={connectors} />
            </select>
          </Prop>
        </Field>
        <Field label="Endpoint">
          <Prop path="request.endpoint">
            <select
              aria-label="Endpoint do nó"
              className={selectClass}
              disabled={!connector}
              value={request.endpoint ?? ''}
              onChange={(e) => {
                const id = e.target.value || undefined
                set(
                  id
                    ? { endpoint: id, method: undefined, url: undefined }
                    : { endpoint: undefined, method: request.method ?? 'GET', url: request.url ?? '' }
                )
              }}
            >
              <option value="">Caminho livre</option>
              {connector?.endpoints.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.method} {e.path} · {e.name}
                </option>
              ))}
            </select>
          </Prop>
        </Field>
      </div>

      {!endpoint && (
        <div className="flex gap-2">
          <select
            aria-label="Método do nó"
            className={`${controlClass} w-24 shrink-0`}
            value={request.method ?? 'GET'}
            onChange={(e) => set({ method: e.target.value as FlowRequest['method'] })}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <Prop path="request.url">
            <div className="min-w-0 flex-1">
              <TemplateInput
                label="URL do nó"
                placeholder={connector ? '/recurso (relativo à baseUrl do conector)' : '{{BASE_URL}}/recurso'}
                value={request.url ?? ''}
                {...input}
                onChange={(url) => set({ url })}
              />
            </div>
          </Prop>
        </div>
      )}
      {endpoint && (
        <p className="font-mono text-[11px] text-muted">
          {endpoint.method} {connector?.baseUrl ?? ''}
          {endpoint.path}
        </p>
      )}
      {connector && <Inherited connector={connector} endpoint={endpoint} />}

      {params.map((param) => (
        <Field key={param} label={`Parâmetro {${param}}`}>
          <Prop path={`request.pathParams.${param}`}>
            <TemplateInput
              label={`Parâmetro ${param}`}
              value={request.pathParams?.[param] ?? ''}
              {...input}
              onChange={(value) => set({ pathParams: { ...request.pathParams, [param]: value } })}
            />
          </Prop>
        </Field>
      ))}

      <Prop path="request.headers">
        <PairsEditor
          title="Headers"
          pairs={request.headers}
          {...input}
          onChange={(headers) => set({ headers })}
          hint={connector ? 'Mesclados aos herdados do conector (auth, headers da base).' : undefined}
        />
      </Prop>
      <Prop path="request.query">
        <PairsEditor title="Query" pairs={request.query} {...input} onChange={(query) => set({ query })} />
      </Prop>

      {bodySchema && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted">Corpo (substitui o do endpoint)</span>
          <span className="flex-1" />
          <SegmentedControl<'form' | 'json'>
            label="Edição do corpo do nó"
            size="xs"
            value={bodyView}
            onChange={setBodyView}
            options={[
              { value: 'form', label: 'Formulário' },
              { value: 'json', label: 'JSON' }
            ]}
          />
        </div>
      )}
      {formBody?.ok ? (
        <Prop path="request.body">
          <SchemaForm
            schema={bodySchema!}
            value={formBody.value}
            label="Formulário do corpo do nó"
            onChange={(body) => {
              setBodyText(toText(body))
              set({ body })
            }}
          />
          <p className="mt-1 text-[11px] text-muted">
            Sem mudança, vai o corpo do endpoint. {'{{VAR}}'} e {'"{{ $nodes.X.data }}"'} valem em qualquer campo.
          </p>
        </Prop>
      ) : (
      <Field
        label={bodySchema ? 'Corpo em JSON' : endpoint ? 'Corpo (substitui o do endpoint)' : 'Corpo'}
        hint={'JSON ou texto. Num JSON, "{{ $nodes.X.data }}" sozinho vira o valor (objeto, número).'}
      >
        <Prop path="request.body">
          <TemplateInput
            label="Corpo do nó"
            multiline
            rows={6}
            placeholder={endpoint?.body ?? ''}
            value={bodyText}
            {...input}
            onChange={(text) => {
              setBodyText(text)
              set({ body: parseBody(text) })
            }}
          />
        </Prop>
        {formBody && !formBody.ok && (
          <span className="text-[11px] text-warning">O corpo não é um objeto JSON: o formulário volta quando o JSON for válido.</span>
        )}
      </Field>
      )}
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={request.ignoreHttpErrors ?? false}
          onChange={(e) => set({ ignoreHttpErrors: e.target.checked || undefined })}
        />
        Seguir com resposta 4xx/5xx (decidir numa condição)
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={request.poll !== undefined}
          onChange={(e) =>
            set({
              poll: e.target.checked
                ? { until: { target: `$nodes.${nodeName}.status`, operator: 'equals', expected: 200 } }
                : undefined
            })
          }
        />
        Repetir até uma condição valer (polling)
      </label>
      {request.poll && (
        <div className="flex flex-col gap-2 border-l border-border pl-2">
          <ConditionFields
            condition={request.poll.until}
            ancestors={[...ancestors, nodeName]}
            outputs={outputs}
            targetHint={`A resposta de cada tentativa fica em $nodes.${nodeName}`}
            onChange={(until) => set({ poll: { ...request.poll!, until } })}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <Field label="Intervalo (ms)">
              <input
                aria-label="Intervalo do polling"
                type="number"
                min={100}
                value={request.poll.intervalMs ?? 1000}
                onChange={(e) =>
                  set({
                    poll: { ...request.poll!, intervalMs: Math.max(100, Math.round(Number(e.target.value) || 0)) }
                  })
                }
                className={selectClass}
              />
            </Field>
            <Field label="Tempo limite (ms)">
              <input
                aria-label="Tempo limite do polling"
                type="number"
                min={100}
                value={request.poll.timeoutMs ?? 30000}
                onChange={(e) =>
                  set({ poll: { ...request.poll!, timeoutMs: Math.max(100, Math.round(Number(e.target.value) || 0)) } })
                }
                className={selectClass}
              />
            </Field>
          </div>
        </div>
      )}
      <RequestScriptsField
        scripts={request.requestScripts}
        onChange={(scripts) => set({ requestScripts: scripts.pre?.trim() || scripts.post?.trim() ? scripts : undefined })}
      />
    </>
  )
}

/**
 * Scripts pre e post do próprio nó (requestScripts), os mesmos da aba Scripts do Quick Request:
 * rodam depois dos do conector e do endpoint, em volta da requisição.
 */
function RequestScriptsField(props: { scripts: FlowRequest['requestScripts']; onChange: (scripts: NonNullable<FlowRequest['requestScripts']>) => void }) {
  const [phase, setPhase] = useState<'pre' | 'post'>('pre')
  const scripts = props.scripts ?? {}
  return (
    <Field label="Scripts do nó" hint="JavaScript com a API vv, como na aba Scripts do Quick Request. Rodam depois dos do conector e do endpoint.">
      <SegmentedControl<'pre' | 'post'>
        label="Momento do script do nó"
        size="xs"
        value={phase}
        onChange={setPhase}
        options={[
          { value: 'pre', label: `Antes do envio${scripts.pre?.trim() ? ' •' : ''}` },
          { value: 'post', label: `Depois da resposta${scripts.post?.trim() ? ' •' : ''}` }
        ]}
      />
      <div className="flex h-44 min-h-0 flex-col overflow-hidden rounded-[var(--radius-control)] border border-border">
        <CodeEditor
          key={phase}
          ariaLabel={phase === 'pre' ? 'Script do nó antes do envio' : 'Script do nó depois da resposta'}
          language="javascript"
          value={scripts[phase] ?? ''}
          onChange={(value) => props.onChange({ ...scripts, [phase]: value })}
          placeholder={phase === 'pre' ? "// vv.request.headers['X-Assinatura'] = vv.variables.get('TENANT')" : "// vv.test('status 200', () => vv.expect(vv.response.status).to.equal(200))"}
        />
      </div>
    </Field>
  )
}

function PairsEditor({
  title,
  pairs,
  ancestors,
  outputs,
  onChange,
  hint
}: {
  title: string
  pairs: Record<string, string | null> | undefined
  ancestors: readonly string[]
  outputs: KnownOutputs
  onChange(pairs: Record<string, string | null> | undefined): void
  hint?: string
}) {
  const entries = Object.entries(pairs ?? {})
  const commit = (next: [string, string | null][]) => onChange(next.length ? Object.fromEntries(next) : undefined)
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted">{title}</span>
        <button
          type="button"
          className="text-accent hover:underline"
          disabled={entries.some(([k]) => k === '')}
          onClick={() => commit([...entries, ['', '']])}
        >
          + {title === 'Headers' ? 'header' : 'parâmetro'}
        </button>
      </div>
      {entries.map(([key, value], i) => (
        <div key={i} className="flex gap-1">
          <input
            aria-label={`Nome em ${title} ${i + 1}`}
            value={key}
            spellCheck={false}
            onChange={(e) => commit(entries.map((entry, j) => (j === i ? [e.target.value, entry[1]] : entry)))}
            className={`${controlClass} w-32 shrink-0 font-mono`}
          />
          <div className="min-w-0 flex-1">
            {value === null ? (
              <span className="block px-2 py-1 text-muted">removido da herança</span>
            ) : (
              <TemplateInput
                label={`Valor de ${key || `${title} ${i + 1}`}`}
                value={value}
                ancestors={ancestors}
                outputs={outputs}
                onChange={(v) => commit(entries.map((entry, j) => (j === i ? [entry[0], v] : entry)))}
              />
            )}
          </div>
          <button
            type="button"
            aria-label={`Remover ${key || `linha ${i + 1}`}`}
            onClick={() => commit(entries.filter((_, j) => j !== i))}
            className="px-1 text-muted hover:text-danger"
          >
            ✕
          </button>
        </div>
      ))}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  )
}

/** Rola até o campo da propriedade e foca o primeiro controle dele. */
function focusProperty(path: string): void {
  const all = [...document.querySelectorAll<HTMLElement>('[data-property]')]
  const area = all.find((el) => matches(path, el.dataset['property']!) && el.getAttribute('aria-invalid'))
  area?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  area?.querySelector<HTMLElement>('input, textarea, select, [contenteditable], .monaco-editor textarea')?.focus()
}

const MAX_PREVIEW = 20_000

function ResultView({ result }: { result: FlowNodeResult }) {
  const output = result.output && JSON.stringify(result.output, null, 2)
  return (
    <section aria-label="Resultado do nó" className="flex min-w-0 flex-col gap-2 border-t border-border pt-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold">
          {result.status === 'success' ? 'Rodou' : result.status === 'error' ? 'Falhou' : 'Pulado'}
        </span>
        {result.status !== 'skipped' && <span className="text-muted">{Math.round(result.durationMs)} ms</span>}
        {result.output?.status !== undefined && <span className="text-muted">HTTP {result.output.status}</span>}
        {result.python && <span className="text-muted">Python {result.python}</span>}
        {result.attempts !== undefined && (
          <span className="text-muted">
            {result.attempts} tentativa{result.attempts > 1 ? 's' : ''}
          </span>
        )}
      </div>
      {result.reason && <p className="text-muted">{result.reason}</p>}
      {result.error && (
        <ErrorNotice
          compact
          title="O nó falhou"
          code={result.error.code}
          message={result.error.message}
          {...(result.error.property && {
            location: `propriedade ${propertyLabel(result.error.property)}`,
            actions: (
              <Button size="sm" variant="ghost" onClick={() => focusProperty(result.error!.property!)}>
                Ir para a propriedade
              </Button>
            )
          })}
        />
      )}
      {result.request && (
        <p className="break-all font-mono text-[11px] text-muted">
          {result.request.method} {result.request.url}
        </p>
      )}
      {result.auth && (
        <p className="text-[11px] text-muted">
          auth {result.auth.type} de {result.auth.from} ({result.auth.source})
        </p>
      )}
      {result.logs && (
        <>
          <span className="text-muted">Logs</span>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-[11px]">
            {result.logs}
          </pre>
        </>
      )}
      {output && (
        <>
          <span className="text-muted">Saída em $nodes.{result.name}</span>
          <pre
            aria-label="Saída do nó"
            className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-[11px]"
          >
            {output.length > MAX_PREVIEW ? `${output.slice(0, MAX_PREVIEW)}…` : output}
          </pre>
        </>
      )}
    </section>
  )
}

type FlowDefaults = NonNullable<Flow['defaults']>

/**
 * Base do fluxo, com nenhum nó selecionado (docs/flows.md, Herança entre fluxos): de quem herda e
 * os defaults que valem para as requisições deste fluxo e de quem herda dele. O login é um nó do
 * canvas (com cache) ou o nó OAuth2; o resto da auth, o mTLS e os scripts ficam no arquivo.
 */
export function BaseSettings({ flow, connectors, onChange }: { flow: Flow; connectors: CatalogConnector[]; onChange(flow: Flow): void }) {
  const defaults = flow.defaults ?? {}
  const set = (patch: Partial<FlowDefaults>) => {
    const next: Record<string, unknown> = { ...defaults, ...patch }
    for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key]
    const { defaults: _old, ...rest } = flow
    onChange(Object.keys(next).length ? { ...rest, defaults: next as FlowDefaults } : rest)
  }
  const bases = connectors.filter((c) => c.id !== flow.id)
  return (
    <section aria-label="Base do fluxo" className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-semibold text-fg">Base</h3>
        <p className="mt-1 text-[11px] text-muted">
          O que vale para as requisições deste fluxo e de quem herda dele. Um fluxo com estes campos e sem nós de passo é um
          fluxo-base: aparece como conector no explorador.
        </p>
      </div>
      <Field label="Herda de (extends)" hint="Id de outra base; <projeto>:<id> para uma base de outro projeto.">
        <input
          list="flow-base-options"
          value={flow.extends ?? ''}
          onChange={(e) => {
            const { extends: _old, ...rest } = flow
            onChange(e.target.value.trim() ? { ...rest, extends: e.target.value.trim() } : rest)
          }}
          spellCheck={false}
          className={`${selectClass} font-mono`}
        />
        <datalist id="flow-base-options">
          {bases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </datalist>
      </Field>
      <Field label="URL base">
        <input
          value={defaults.baseUrl ?? ''}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="{{BASE_URL}}"
          spellCheck={false}
          className={`${selectClass} font-mono`}
        />
      </Field>
      <Field label="basePath" hint="Somado ao basePath herdado; começa com /.">
        <input
          value={defaults.basePath ?? ''}
          onChange={(e) => set({ basePath: e.target.value })}
          placeholder="/v1"
          spellCheck={false}
          className={`${selectClass} font-mono`}
        />
      </Field>
      <PairsEditor
        title="Headers"
        pairs={defaults.headers}
        ancestors={flow.nodes.map((n) => n.name)}
        outputs={new Map()}
        onChange={(headers) => set({ headers: headers as FlowDefaults['headers'] })}
        hint="Valem em toda requisição de quem herda; use {{ $nodes.Login.data.token }} para o token do nó de login."
      />
      {defaults.auth && <p className="text-[11px] text-muted">Auth {defaults.auth.type} definida no arquivo do fluxo.</p>}
    </section>
  )
}
