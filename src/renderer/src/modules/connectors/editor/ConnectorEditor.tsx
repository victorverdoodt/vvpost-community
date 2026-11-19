import { useEffect, useRef, useState } from 'react'
import { HTTP_METHODS, type Connector, type ConnectorSource, type HttpMethod, type RegistryConnector } from '@shared/ipc'
import { WORKSPACE_CHANGED } from '../../../panels/useWorkspace'
import { useDiskChange } from '../../../lib/disk-changes'
import { JsonField, KeyValueEditor, ScriptsField, Section, SelectField, TextField, prune, smallButton } from './fields'
import { OAuth2Fields } from './OAuth2Fields'
import { sharedSchemaName } from './EndpointSchemaEditor'
import { buttonClass, cx, ErrorNotice, SchemaBuilder, SegmentedControl, usePromptDialog } from '../../../design-system'

type Auth = NonNullable<NonNullable<Connector['config']>['auth']>
type AuthKind = Auth['type'] | 'inherit'
type Endpoint = NonNullable<Connector['endpoints']>[number]

const AUTH_OPTIONS: { value: AuthKind; label: string }[] = [
  { value: 'inherit', label: 'Herdada do pai (ou nenhuma)' },
  { value: 'none', label: 'Desligada (none)' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'apiKey', label: 'API key' },
  { value: 'basic', label: 'Basic' },
  { value: 'oauth2', label: 'OAuth2 (client credentials, password, authorization code)' },
  { value: 'login', label: 'Login próprio da API' },
  { value: 'digest', label: 'Digest' },
  { value: 'ntlm', label: 'NTLM' },
  { value: 'awsSigV4', label: 'AWS Signature v4' },
  { value: 'oauth1', label: 'OAuth 1.0' }
]

const NEW_AUTH: Record<Auth['type'], Auth> = {
  none: { type: 'none' },
  bearer: { type: 'bearer', token: '{{API_TOKEN}}' },
  apiKey: { type: 'apiKey', name: 'X-Api-Key', value: '{{API_KEY}}', in: 'header' },
  basic: { type: 'basic', username: '', password: '{{PASSWORD}}' },
  oauth2: {
    type: 'oauth2',
    grantType: 'client_credentials',
    tokenUrl: '',
    clientId: '',
    clientSecret: '{{CLIENT_SECRET}}'
  },
  login: { type: 'login', request: { method: 'POST', url: '/login', json: {} }, token: 'body.token' },
  digest: { type: 'digest', username: '', password: '{{PASSWORD}}' },
  ntlm: { type: 'ntlm', username: '', password: '{{PASSWORD}}' },
  awsSigV4: { type: 'awsSigV4', accessKeyId: '{{AWS_ACCESS_KEY_ID}}', secretAccessKey: '{{AWS_SECRET_ACCESS_KEY}}', region: 'us-east-1', service: 'execute-api' },
  oauth1: { type: 'oauth1', consumerKey: '', consumerSecret: '{{CONSUMER_SECRET}}' }
}

const blank = (): Connector => ({ id: '', name: '', version: '1.0.0', endpoints: [] })

/** Campo da configuração herdável que "Ir à definição" abre: URL base, um header, auth ou mTLS. */
export type ConnectorField = 'baseUrl' | 'basePath' | 'auth' | 'tls' | { header: string }

/** Quem herda deste conector: os descendentes e os endpoints deles (os próprios incluídos). */
export interface InheritanceImpact {
  connectors: string[]
  endpoints: number
}

/** Quem herda de um conector: os descendentes (cadeia que passa por ele) e os endpoints deles. */
export function impactOf(id: string, connectors: readonly Pick<RegistryConnector, 'id' | 'name' | 'chain' | 'endpoints'>[]): InheritanceImpact {
  const heirs = connectors.filter((c) => c.id !== id && c.chain.includes(id))
  return {
    connectors: heirs.map((c) => c.name),
    endpoints: heirs.reduce((n, c) => n + c.endpoints.length, 0)
  }
}

/** O que os filhos herdam: a configuração inteira (URL base, basePath, headers, auth, mTLS). */
const inherited = (c: Connector) => JSON.stringify(prune({ config: c.config ?? {} }))

/** Abre o campo pedido, rola até ele e põe o foco (o header pelo nome). */
function focusField(form: HTMLElement, field: ConnectorField): void {
  const key = typeof field === 'string' ? field : 'headers'
  const area = form.querySelector<HTMLElement>(`[data-field="${key}"]`)
  if (!area) return
  if (area instanceof HTMLDetailsElement) area.open = true
  let target = area.querySelector<HTMLElement>('input, select, textarea')
  if (typeof field === 'object') {
    const inputs = [...area.querySelectorAll<HTMLInputElement>('input')]
    const i = inputs.findIndex((el) => el.value.toLowerCase() === field.header.toLowerCase())
    if (i >= 0) target = inputs[i + 1] ?? inputs[i]!
  }
  area.dataset['highlight'] = 'true'
  setTimeout(() => delete area.dataset['highlight'], 2000)
  area.scrollIntoView({ block: 'center' })
  target?.focus()
}

/**
 * Editor de um conector do workspace: o que o próprio arquivo define,
 * sem a herança aplicada (a aba Herança mostra o resultado). Os cenários de cada
 * endpoint são preservados e editados no painel Cenários de teste.
 */
export function ConnectorEditor(props: {
  /** null cria um conector novo. */
  connectorId: string | null
  /** Ids de todos os conectores, para o extends. */
  connectorIds: string[]
  onSaved: (id: string) => void
  onCancel: () => void
  /** Campo a abrir quando o editor carrega (Ir à definição na aba Herança). */
  focus?: ConnectorField
  /** Conectores e endpoints que herdam deste: a mudança herdável pede confirmação antes de salvar. */
  impact?: InheritanceImpact
}) {
  const [source, setSource] = useState<ConnectorSource | null>(null)
  const [draft, setDraft] = useState<Connector | null>(props.connectorId ? null : blank())
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const dialog = usePromptDialog()
  const form = useRef<HTMLFormElement>(null)
  const loaded = !!draft

  // Ir à definição: depois do primeiro render com o rascunho, abre o campo herdado.
  useEffect(() => {
    if (loaded && props.focus && form.current) focusField(form.current, props.focus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  const reload = () => {
    if (!props.connectorId) return
    void window.vvpost.readConnector(props.connectorId).then((r) => {
      if (!r.ok) return setError(r.message)
      setOutside(false)
      setSource(r.value)
      setDraft(r.value.connector)
    })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [props.connectorId])

  // Gravado fora do app (um agente pelo MCP, o CLI, outro editor): a versão no disco mudou. Sem
  // mudanças no formulário, o editor relê sozinho; com mudanças, avisa.
  const [outside, setOutside] = useState(false)
  const latest = useRef({ source, draft })
  latest.current = { source, draft }
  // Manter o formulário: a versão do disco de agora vira a base, e Salvar grava por cima dela.
  const keepMine = () => {
    if (!props.connectorId) return
    void window.vvpost.readConnector(props.connectorId).then((r) => {
      if (r.ok) setSource((s) => s && { ...s, version: r.value.version })
      setOutside(false)
    })
  }
  useDiskChange(
    (f) => f.endsWith('.json'),
    () => {
      const { source: before, draft: current } = latest.current
      if (!props.connectorId || !before) return
      void window.vvpost.readConnector(props.connectorId).then((r) => {
        if (!r.ok || r.value.version === before.version) return
        if (JSON.stringify(current) === JSON.stringify(before.connector)) reload()
        else setOutside(true)
      })
    }
  )

  if (!draft) return error ? <p className="text-sm text-danger">{error}</p> : null

  const set = (patch: Partial<Connector>) => setDraft({ ...draft, ...patch })
  const config = draft.config ?? {}
  const setConfig = (patch: Partial<NonNullable<Connector['config']>>) => set({ config: { ...config, ...patch } })
  const endpoints = draft.endpoints ?? []
  const setEndpoint = (i: number, patch: Partial<Endpoint>) =>
    set({ endpoints: endpoints.map((e, j) => (j === i ? { ...e, ...patch } : e)) })
  const validity = (key: string) => (valid: boolean) =>
    setInvalid((prev) => {
      const next = new Set(prev)
      if (valid) next.delete(key)
      else next.add(key)
      return next
    })

  const impact = props.impact && props.impact.connectors.length > 0 ? props.impact : null
  const changesInheritance = !!impact && !!source && inherited(source.connector) !== inherited(draft)

  const save = async () => {
    // Antes de salvar o que os filhos herdam, quem será afetado.
    if (changesInheritance) {
      const n = impact!.connectors.length
      const ok = await dialog.confirm({
        title: `Salvar uma mudança herdada por ${n === 1 ? '1 conector' : `${n} conectores`}?`,
        message: `${impact!.connectors.join(', ')} ${n === 1 ? 'herda' : 'herdam'} a configuração de ${draft.name}: ${impact!.endpoints === 1 ? '1 endpoint muda' : `${impact!.endpoints} endpoints mudam`} junto.`,
        confirmLabel: 'Salvar'
      })
      if (!ok) return
    }
    setSaving(true)
    setError(null)
    try {
      const r = await window.vvpost.saveConnector(prune(draft), source?.file, source?.version)
      if (!r.ok) return setError(r.message)
      window.dispatchEvent(new Event(WORKSPACE_CHANGED))
      props.onSaved(draft.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {outside && (
        <div role="alert" className="mb-3 flex items-center gap-2 rounded-[var(--radius-card)] border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            Este conector mudou fora do app (um agente pelo MCP, o CLI ou outro editor) e o formulário tem mudanças não salvas.
          </span>
          <button type="button" className={smallButton} onClick={reload} title="Descarta as mudanças do formulário">
            Recarregar do disco
          </button>
          <button type="button" className={smallButton} onClick={keepMine} title="Salvar grava este formulário por cima do disco">
            Manter o meu
          </button>
        </div>
      )}
      <form
        ref={form}
        className="flex flex-col gap-3 text-xs"
        aria-label={props.connectorId ? `Editar ${props.connectorId}` : 'Novo conector'}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Section title="Conector">
          <div className="grid grid-cols-3 gap-3">
            <TextField
              label="Id"
              required
              mono
              value={draft.id}
              onChange={(v) => set({ id: v ?? '' })}
              placeholder="billing.v2"
            />
            <TextField label="Nome" required value={draft.name} onChange={(v) => set({ name: v ?? '' })} />
            <TextField
              label="Versão"
              required
              mono
              value={draft.version}
              onChange={(v) => set({ version: v ?? '' })}
              placeholder="1.0.0"
            />
          </div>
          <SelectField
            label="Herda de (extends)"
            value={draft.extends ?? ''}
            options={[
              { value: '', label: '(nenhum: conector raiz)' },
              ...props.connectorIds.filter((id) => id !== draft.id).map((id) => ({ value: id, label: id }))
            ]}
            onChange={(v) => set({ extends: v || undefined })}
          />
          <TextField
            label="Descrição (Markdown)"
            multiline
            value={draft.description}
            onChange={(v) => set({ description: v })}
          />
        </Section>

        <Section title="Configuração">
          {impact && (
            <p
              role="note"
              aria-label="Impacto nos filhos"
              className={changesInheritance ? 'text-warning' : 'text-muted'}
            >
              Herdada por {impact.connectors.length === 1 ? '1 conector' : `${impact.connectors.length} conectores`} (
              {impact.connectors.join(', ')}) e{' '}
              {impact.endpoints === 1 ? '1 endpoint' : `${impact.endpoints} endpoints`}
              {changesInheritance ? ': a mudança vale para todos eles.' : '.'}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div
              data-field="baseUrl"
              className="rounded data-[highlight]:outline data-[highlight]:outline-2 data-[highlight]:outline-accent"
            >
              <TextField
                label="URL base"
                mono
                value={config.baseUrl}
                onChange={(v) => setConfig({ baseUrl: v })}
                placeholder="{{BASE_URL}}"
                hint="Normalmente só no conector raiz; os filhos herdam."
              />
            </div>
            <div
              data-field="basePath"
              className="rounded data-[highlight]:outline data-[highlight]:outline-2 data-[highlight]:outline-accent"
            >
              <TextField
                label="basePath"
                mono
                value={config.basePath}
                onChange={(v) => setConfig({ basePath: v })}
                placeholder="/billing"
                hint="Somado ao basePath herdado."
              />
            </div>
          </div>
          <div
            data-field="headers"
            className="rounded data-[highlight]:outline data-[highlight]:outline-2 data-[highlight]:outline-accent"
          >
            <KeyValueEditor
              label="Header"
              value={config.headers}
              onChange={(v) => setConfig({ headers: v as Record<string, string> | undefined })}
            />
          </div>
          <div
            data-field="auth"
            className="rounded data-[highlight]:outline data-[highlight]:outline-2 data-[highlight]:outline-accent"
          >
            <AuthEditor auth={config.auth} onChange={(auth) => setConfig({ auth })} onValidity={validity('auth')} />
          </div>
          <details
            data-field="tls"
            className="rounded data-[highlight]:outline data-[highlight]:outline-2 data-[highlight]:outline-accent"
          >
            <summary className="cursor-pointer text-muted">Certificado de cliente (mTLS)</summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {(['cert', 'key', 'pfx', 'ca', 'passphrase'] as const).map((k) => (
                <TextField
                  key={k}
                  label={k}
                  mono
                  value={config.tls?.[k]}
                  onChange={(v) => setConfig({ tls: { ...config.tls, [k]: v } })}
                  placeholder={k === 'passphrase' ? '{{TLS_PASSPHRASE}}' : 'certs/cliente.pem'}
                />
              ))}
            </div>
          </details>
          <ScriptsField scope="do conector" value={config.scripts} onChange={(scripts) => setConfig({ scripts })} />
        </Section>

        <Section
          title={`Endpoints (${endpoints.length})`}
          actions={
            <button
              type="button"
              className={smallButton}
              onClick={() => {
                set({
                  endpoints: [
                    ...endpoints,
                    { id: `endpoint-${endpoints.length + 1}`, name: 'Novo endpoint', method: 'GET', path: '/' }
                  ]
                })
                setOpen(endpoints.length)
              }}
            >
              + Endpoint
            </button>
          }
        >
          {endpoints.length === 0 && <p className="text-muted">Nenhum endpoint.</p>}
          <ul className="flex flex-col gap-2">
            {endpoints.map((e, i) => (
              <li key={i} className="rounded-md border border-border">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <button
                    type="button"
                    className="flex flex-1 items-center gap-2 text-left"
                    onClick={() => setOpen(open === i ? null : i)}
                    aria-expanded={open === i}
                  >
                    <span className="w-14 font-mono font-semibold">{e.method}</span>
                    <span className="font-mono">{e.path}</span>
                    <span className="text-muted">{e.name}</span>
                    {e.requiresAuth !== undefined && <span className="text-muted">· {e.requiresAuth ? 'exige auth' : 'público'}</span>}
                    {!!e.scenarios?.length && <span className="text-muted">· {e.scenarios.length} cenário(s)</span>}
                    {!!e.examples?.length && <span className="text-muted">· {e.examples.length} exemplo(s)</span>}
                  </button>
                  <button
                    type="button"
                    className={smallButton}
                    onClick={() => {
                      set({ endpoints: endpoints.filter((_, j) => j !== i) })
                      setOpen(null)
                    }}
                  >
                    Apagar
                  </button>
                </div>
                {open === i && (
                  <div className="flex flex-col gap-3 border-t border-border p-3" aria-label={`Endpoint ${i + 1}`}>
                    <div className="grid grid-cols-[1fr_1fr_7rem_2fr] gap-3">
                      <TextField
                        label="Id"
                        required
                        mono
                        value={e.id}
                        onChange={(v) => setEndpoint(i, { id: v ?? '' })}
                      />
                      <TextField
                        label="Nome"
                        required
                        value={e.name}
                        onChange={(v) => setEndpoint(i, { name: v ?? '' })}
                      />
                      <SelectField<HttpMethod>
                        label="Método"
                        value={e.method}
                        options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                        onChange={(method) => setEndpoint(i, { method })}
                      />
                      <TextField
                        label="Caminho"
                        required
                        mono
                        value={e.path}
                        onChange={(v) => setEndpoint(i, { path: v ?? '' })}
                        hint="Parâmetros de rota como {id}."
                      />
                    </div>
                    <div className="max-w-sm">
                      <SelectField<'' | 'true' | 'false'>
                        label="Autenticação (o vvpost run confere sem credencial)"
                        value={e.requiresAuth === undefined ? '' : e.requiresAuth ? 'true' : 'false'}
                        options={[
                          { value: '', label: 'Não declarada' },
                          { value: 'true', label: 'Exige credencial (401/403 sem ela)' },
                          { value: 'false', label: 'Pública (funciona sem credencial)' }
                        ]}
                        onChange={(v) => setEndpoint(i, { requiresAuth: v === '' ? undefined : v === 'true' })}
                      />
                    </div>
                    <TextField
                      label="Descrição (Markdown)"
                      multiline
                      value={e.description}
                      onChange={(v) => setEndpoint(i, { description: v })}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <KeyValueEditor
                        label="Header do endpoint"
                        value={e.headers}
                        onChange={(v) => setEndpoint(i, { headers: v as Record<string, string> | undefined })}
                      />
                      <KeyValueEditor
                        label="Query"
                        value={e.query}
                        onChange={(v) => setEndpoint(i, { query: v as Record<string, string> | undefined })}
                      />
                    </div>
                    <JsonField
                      label="Corpo padrão (JSON)"
                      value={e.body}
                      onChange={(body) => setEndpoint(i, { body })}
                      onValidity={validity(`body-${i}`)}
                      rows={8}
                    />
                    <BodySchemaField
                      endpointName={e.name || e.id}
                      value={e.bodySchema}
                      body={e.body}
                      onChange={(bodySchema) => setEndpoint(i, { bodySchema })}
                      onValidity={validity(`schema-${i}`)}
                    />
                    <JsonField
                      label="Exemplos de resposta (mock server)"
                      value={e.examples}
                      onChange={(examples) =>
                        setEndpoint(i, { examples: Array.isArray(examples) && examples.length ? (examples as Endpoint['examples']) : undefined })
                      }
                      onValidity={validity(`examples-${i}`)}
                      hint='Lista de { "id", "name", "status", "headers"?, "body"?, "delayMs"? }. No Quick Request, "Salvar a resposta como exemplo do endpoint" cria um.'
                      rows={6}
                    />
                    <ScriptsField scope="do endpoint" value={e.scripts} onChange={(scripts) => setEndpoint(i, { scripts })} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>

        {error && (
          <ErrorNotice
            compact
            title="O conector não foi salvo"
            code="SCHEMA_INVALID"
            message={error}
            location={source?.file}
            hint="Corrija o que a mensagem aponta e salve de novo; nada foi gravado no arquivo."
          />
        )}
        <div className="flex items-center gap-2">
          {/* O caminho trunca: inteiro, numa janela estreita empurrava os botões para fora da tela. */}
          {source && (
            <span className="min-w-0 truncate font-mono text-muted" title={source.file}>
              {source.file}
            </span>
          )}
          <span className="ml-auto" />
          <button type="button" className={cx(smallButton, 'shrink-0')} onClick={props.onCancel}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving || invalid.size > 0 || !draft.id || !draft.name}
            className={cx(buttonClass('primary', 'md'), 'shrink-0')}
          >
            {props.connectorId ? 'Salvar conector' : 'Criar conector'}
          </button>
        </div>
      </form>
      {dialog.element}
    </>
  )
}

/** Auth do conector: campos por tipo; o login (pedido, extração e injeção do token) é editado em JSON. */
function AuthEditor(props: {
  auth: Auth | undefined
  onChange: (auth: Auth | undefined) => void
  onValidity: (valid: boolean) => void
}) {
  const { auth } = props
  const kind: AuthKind = auth?.type ?? 'inherit'
  const patch = (p: Record<string, unknown>) => props.onChange({ ...auth, ...p } as Auth)
  const field = (key: string, label: string, placeholder?: string) => (
    <TextField
      label={label}
      mono
      value={(auth as Record<string, string | undefined> | undefined)?.[key]}
      onChange={(v) => patch({ [key]: v })}
      placeholder={placeholder}
    />
  )
  return (
    <div className="flex flex-col gap-3">
      <SelectField<AuthKind>
        label="Autenticação"
        value={kind}
        options={AUTH_OPTIONS}
        onChange={(k) => {
          props.onValidity(true)
          props.onChange(k === 'inherit' ? undefined : NEW_AUTH[k])
        }}
      />
      {auth?.type === 'bearer' && (
        <div className="grid grid-cols-3 gap-3">
          {field('token', 'Token', '{{API_TOKEN}}')}
          {field('header', 'Header', 'Authorization')}
          {field('prefix', 'Prefixo', 'Bearer')}
        </div>
      )}
      {auth?.type === 'apiKey' && (
        <div className="grid grid-cols-3 gap-3">
          {field('name', 'Nome', 'X-Api-Key')}
          {field('value', 'Valor', '{{API_KEY}}')}
          <SelectField
            label="Em"
            value={auth.in ?? 'header'}
            options={[
              { value: 'header', label: 'Header' },
              { value: 'query', label: 'Query' }
            ]}
            onChange={(v) => patch({ in: v })}
          />
        </div>
      )}
      {auth?.type === 'basic' && (
        <div className="grid grid-cols-2 gap-3">
          {field('username', 'Usuário')}
          {field('password', 'Senha', '{{PASSWORD}}')}
        </div>
      )}
      {auth?.type === 'oauth2' && <OAuth2Fields auth={auth} onChange={props.onChange} />}
      {(auth?.type === 'digest' || auth?.type === 'ntlm') && (
        <div className="grid grid-cols-2 gap-3">
          {field('username', 'Usuário')}
          {field('password', 'Senha', '{{PASSWORD}}')}
          {auth.type === 'ntlm' && field('domain', 'Domínio', 'CORP')}
          {auth.type === 'ntlm' && field('workstation', 'Estação')}
        </div>
      )}
      {auth?.type === 'awsSigV4' && (
        <div className="grid grid-cols-3 gap-3">
          {field('accessKeyId', 'Access key id', '{{AWS_ACCESS_KEY_ID}}')}
          {field('secretAccessKey', 'Secret access key', '{{AWS_SECRET_ACCESS_KEY}}')}
          {field('sessionToken', 'Session token', '{{AWS_SESSION_TOKEN}}')}
          {field('region', 'Região', 'us-east-1')}
          {field('service', 'Serviço', 'execute-api')}
        </div>
      )}
      {auth?.type === 'oauth1' && (
        <div className="grid grid-cols-3 gap-3">
          {field('consumerKey', 'Consumer key')}
          {field('consumerSecret', 'Consumer secret', '{{CONSUMER_SECRET}}')}
          <SelectField
            label="Assinatura"
            value={auth.signatureMethod ?? 'HMAC-SHA1'}
            options={[
              { value: 'HMAC-SHA1', label: 'HMAC-SHA1' },
              { value: 'HMAC-SHA256', label: 'HMAC-SHA256' },
              { value: 'PLAINTEXT', label: 'PLAINTEXT' }
            ]}
            onChange={(v) => patch({ signatureMethod: v })}
          />
          {field('token', 'Token')}
          {field('tokenSecret', 'Token secret', '{{TOKEN_SECRET}}')}
          {field('realm', 'Realm')}
        </div>
      )}
      {auth?.type === 'login' && (
        <JsonField
          label="Login (request, token, expiresIn, ttlSeconds, inject)"
          value={auth}
          rows={10}
          onValidity={props.onValidity}
          onChange={(v) => {
            if (v && typeof v === 'object' && !Array.isArray(v))
              props.onChange({ ...(v as object), type: 'login' } as Auth)
          }}
          hint="Segredos como {{VAR}} de um ambiente. Veja o schema do conector."
        />
      )}
      <p className="text-[11px] text-muted">
        Credenciais entram como {'{{VAR}}'} de um ambiente marcado como segredo: o arquivo do conector vai para o Git, e
        o app recusa salvar valores literais.
      </p>
    </div>
  )
}

/**
 * Campos do corpo do endpoint (o bodySchema): editor visual por padrão, para montar o formulário
 * tipado sem importar OpenAPI, e o JSON Schema cru para o que o visual não cobre ($ref, oneOf).
 */
function BodySchemaField(props: {
  endpointName: string
  value: Endpoint['bodySchema']
  body: unknown
  onChange: (value: Endpoint['bodySchema']) => void
  onValidity: (valid: boolean) => void
}) {
  const [view, setView] = useState<'visual' | 'json'>('visual')
  const shared = sharedSchemaName(props.value)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Campos do corpo (schema)</span>
        <span className="flex-1" />
        <SegmentedControl<'visual' | 'json'>
          label={`Edição do schema de ${props.endpointName}`}
          size="xs"
          value={view}
          onChange={setView}
          options={[
            { value: 'visual', label: 'Campos' },
            { value: 'json', label: 'JSON Schema' }
          ]}
        />
      </div>
      {view === 'visual' && shared ? (
        <p className="rounded border border-border-subtle p-2 text-xs text-muted">
          O corpo é o schema compartilhado <code className="font-mono text-fg">{shared}</code> (schemas/{shared}.schema.json), o mesmo em todos os
          endpoints que o citam. Edite os campos pela documentação do endpoint no Catálogo, ou troque a citação no JSON Schema.
        </p>
      ) : view === 'visual' ? (
        <SchemaBuilder value={props.value} body={props.body} onChange={props.onChange} label={`Campos do corpo de ${props.endpointName}`} />
      ) : (
        <JsonField
          label="bodySchema (JSON Schema)"
          value={props.value}
          onChange={(v) => props.onChange(v as Endpoint['bodySchema'])}
          onValidity={props.onValidity}
          rows={10}
        />
      )}
      <span className="text-[11px] text-muted">
        Monta o formulário do Body no Quick Request e no Flow Studio, valida corpos e cenários e vira a tabela de campos da documentação.
      </span>
    </div>
  )
}
