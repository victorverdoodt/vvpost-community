import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Check, Copy, FileDown, Lock, Play, RefreshCw, TriangleAlert, Workflow, X } from 'lucide-react'
import type {
  ApiDocument,
  DocConnector,
  DocEndpoint,
  DocHeader,
  DocScenario,
  DocScope,
  DocsSaveResult,
  DocsTemplate,
  GeneratedDocs,
  WorkspaceResult
} from '@shared/ipc'
import {
  Badge,
  Button,
  CodeEditor,
  cx,
  EmptyState,
  IconButton,
  InheritanceBadge,
  MethodBadge,
  SegmentedControl,
  statusTone,
  table,
  useToast,
  DockablePane
} from '../../design-system'
import { Markdown, markdownToPrintHtml, MermaidDiagram } from '../../design-system/content/Markdown'
import type React from 'react'
import { openFlow, runScenario, testEndpoint } from './test-actions'
import { DocsOutline } from './DocsOutline'

/** Origem dos headers do próprio endpoint no modelo (ENDPOINT_ORIGIN do core). */
const ENDPOINT_ORIGIN = '(endpoint)'

const connectorAnchor = (ci: number) => `doc-c${ci}`
const endpointAnchor = (ci: number, ei: number) => `doc-c${ci}-e${ei}`

/**
 * Documentação rica de um nível da hierarquia (projeto, conector, endpoint ou request),
 * aberta pelo menu de contexto por cima do módulo ativo: diagramas de herança, auth,
 * sequência e fluxos, herança efetiva com a origem de cada valor, schemas, exemplos,
 * cenários com asserções e a documentação escrita. Exporta o mesmo conteúdo em .md
 * (Mermaid em blocos de código) e em PDF.
 */
export default function DocsViewer({ scope, onClose }: { scope: DocScope; /** Sem onClose (módulo Documentação), não há botão de fechar. */ onClose?: () => void }) {
  const [result, setResult] = useState<WorkspaceResult<GeneratedDocs> | null>(null)
  const [busy, setBusy] = useState<'md' | 'pdf' | null>(null)
  // No projeto com documento escrito (editor), ele é a documentação; a referência gerada fica a um clique.
  const [variant, setVariant] = useState<'composed' | 'generated'>('composed')
  const notify = useToast()
  const scroller = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)

  const load = useCallback(() => {
    setResult(null)
    void window.vvpost.generateDocs(scope).then(setResult)
  }, [scope])
  useEffect(load, [load])

  const doc = result?.ok ? result.value.document : null
  const composed = result?.ok && variant === 'composed' ? result.value.composed : undefined
  const title = composed?.title ?? doc?.title
  const saved = (r: DocsSaveResult, what: string) => {
    if (r.ok) notify(`${what} salva em ${r.path}`, 'success')
    else if (r.reason === 'error') notify(`Não foi possível salvar: ${r.message}`, 'danger')
  }
  const saveMarkdown = () => {
    setBusy('md')
    void window.vvpost
      .saveDocsMarkdown(scope, variant === 'generated')
      .then((r) => saved(r, 'Documentação em Markdown'))
      .finally(() => setBusy(null))
  }
  const savePdf = () => {
    if (!result?.ok) return
    setBusy('pdf')
    void markdownToPrintHtml(composed?.printMarkdown ?? result.value.markdown)
      .then((html) => window.vvpost.saveDocsPdf(composed?.title ?? result.value.document.title, html, !!composed))
      .then((r) => saved(r, 'Documentação em PDF'))
      .catch((err: Error) => notify(`Não foi possível gerar o PDF: ${err.message}`, 'danger'))
      .finally(() => setBusy(null))
  }
  const copy = () => {
    if (!result?.ok) return
    void navigator.clipboard.writeText(composed?.markdown ?? result.value.markdown).then(
      () => notify('Markdown copiado', 'success'),
      () => notify('Não foi possível copiar', 'danger')
    )
  }

  return (
    <section
      className="flex h-full flex-col bg-surface"
      aria-label="Documentação gerada"
      onKeyDown={(e) => {
        if (onClose && e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 text-xs">
        <BookOpen size={15} className="shrink-0 text-accent" aria-hidden />
        {doc && <Badge tone="accent">{composed ? 'Documento do projeto' : doc.scopeLabel}</Badge>}
        <h2 className="min-w-0 truncate text-[13px] font-semibold" title={title}>
          {title ?? 'Gerando documentação…'}
        </h2>
        <span className="flex-1" />
        {result?.ok && result.value.composed && (
          <SegmentedControl
            label="Qual documentação"
            size="xs"
            value={variant}
            onChange={setVariant}
            options={[
              { value: 'composed', label: 'Documento do projeto' },
              { value: 'generated', label: 'Referência gerada' }
            ]}
          />
        )}
        <Button size="sm" icon={<Copy size={14} aria-hidden />} disabled={!doc} onClick={copy}>
          Copiar Markdown
        </Button>
        <Button size="sm" icon={<FileDown size={14} aria-hidden />} disabled={!doc || !!busy} onClick={saveMarkdown}>
          {busy === 'md' ? 'Salvando…' : 'Salvar .md'}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<FileDown size={14} aria-hidden />}
          disabled={!doc || !!busy}
          onClick={savePdf}
        >
          {busy === 'pdf' ? 'Gerando PDF…' : 'Salvar PDF'}
        </Button>
        <IconButton label="Gerar de novo" onClick={load}>
          <RefreshCw size={14} aria-hidden />
        </IconButton>
        {onClose && (
          <IconButton label="Fechar a documentação" onClick={onClose} autoFocus>
            <X size={14} aria-hidden />
          </IconButton>
        )}
      </header>
      {!result ? (
        <EmptyState icon={<BookOpen size={20} aria-hidden />} title="Gerando documentação…" />
      ) : !result.ok ? (
        <EmptyState
          icon={<TriangleAlert size={20} aria-hidden />}
          title="Não foi possível gerar a documentação"
          description={result.message}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          {composed ? (
            <DocsOutline scroller={scroller} content={article} source={composed.printMarkdown} />
          ) : (
            <Toc doc={result.value.document} />
          )}
          <div ref={scroller} className="min-w-0 flex-1 overflow-auto" id="doc-scroll">
            <article
              ref={article}
              className="mx-auto flex max-w-[1040px] flex-col gap-8 px-6 py-6"
              aria-label={title}
              style={accentStyle(result.value.template)}
            >
              <Masthead template={result.value.template} title={title!} />
              {composed ? (
                <>
                  {composed.diagnostics.some((d) => d.severity === 'error') && (
                    <p role="alert" className="text-xs text-warning">
                      O documento do projeto tem {composed.diagnostics.filter((d) => d.severity === 'error').length} problema(s); veja o log na aba
                      Editor do módulo Documentação.
                    </p>
                  )}
                  <ComposedDocument source={composed.printMarkdown} doc={result.value.document} />
                </>
              ) : (
                <DocumentBody doc={result.value.document} />
              )}
            </article>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * O documento do projeto na tela: o Markdown montado, com um "Testar" ao lado de cada endpoint
 * (o título dele no documento, numerado ou não) que abre a chamada no Quick Request.
 */
function ComposedDocument({ source, doc }: { source: string; doc: ApiDocument }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const endpoints = new Map<string, { c: DocConnector; e: DocEndpoint }>(
      doc.connectors.flatMap((c) => c.endpoints.map((e) => [`${e.method} ${e.path} · ${e.name}`, { c, e }] as const))
    )
    for (const h of root.current?.querySelectorAll<HTMLElement>('h2, h3, h4, h5, h6') ?? []) {
      const text = (h.textContent ?? '').replace(/^\d+(\.\d+)*\.?\s+/, '').trim()
      const hit = endpoints.get(text)
      if (!hit || h.querySelector('button')) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'doc-test-button'
      button.textContent = 'Testar'
      button.setAttribute('aria-label', `Testar ${hit.e.name} no Quick Request`)
      button.dataset['connector'] = hit.c.id
      button.dataset['endpoint'] = hit.e.id
      h.append(' ', button)
    }
  }, [source, doc])
  const onClick = (event: React.MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button.doc-test-button')
    if (!button) return
    const c = doc.connectors.find((x) => x.id === button.dataset['connector'])
    const e = c?.endpoints.find((x) => x.id === button.dataset['endpoint'])
    if (c && e) testEndpoint(c.id, e)
  }
  return (
    <div ref={root} onClick={onClick}>
      <Markdown source={source} className="doc-composed" />
    </div>
  )
}

/** A cor de destaque do modelo nos títulos e citações da visualização (o resto segue o tema do app). */
function accentStyle(template: DocsTemplate | undefined): React.CSSProperties | undefined {
  const c = template?.config
  const primary = c?.theme?.primary ?? (c?.theme?.tokens ? template?.brand?.primary : undefined)
  return primary && /^#[0-9A-Fa-f]{6}$/.test(primary) ? ({ '--doc-accent': primary } as React.CSSProperties) : undefined
}

/**
 * Cabeça do documento no formato do modelo do projeto: logo, título, subtítulo, organização e
 * versão. Só aparece quando o projeto tem modelo; o cabeçalho e o rodapé por página ficam no PDF.
 */
function Masthead({ template, title }: { template: DocsTemplate | undefined; title: string }) {
  const c = template?.config
  if (!c || !(template.logo || c.subtitle || c.organization || c.version || c.title)) return null
  const meta = [c.organization, c.version && `versão ${c.version}`].filter(Boolean).join(' · ')
  return (
    <header
      className="flex items-center gap-4 border-l-4 pl-4"
      style={{ borderColor: 'var(--doc-accent, var(--color-accent))' }}
      aria-label="Cabeçalho do modelo da documentação"
    >
      {template.logo && <img src={template.logo} alt="Logo" className="max-h-14 max-w-48 object-contain" />}
      <div className="flex min-w-0 flex-col">
        <span className="text-base font-semibold">{title}</span>
        {c.subtitle && <span className="text-xs text-muted">{c.subtitle}</span>}
        {meta && <span className="text-[11px] text-faint">{meta}</span>}
      </div>
    </header>
  )
}

function Toc({ doc }: { doc: ApiDocument }) {
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' })
  const link = (id: string, children: ReactNode, depth = 0) => (
    <li key={id}>
      <button
        type="button"
        onClick={() => go(id)}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
        className="flex w-full items-center gap-2 rounded-[var(--radius-control)] py-1 pr-2 text-left text-muted hover:bg-elevated hover:text-fg"
      >
        {children}
      </button>
    </li>
  )
  return (
    <DockablePane
      as="nav"
      id="docs.toc"
      title="Sumário"
      dockLabel="o sumário"
      label="Largura do sumário"
      defaultSize={256}
      min={180}
      max={560}
      className="overflow-auto border-r border-border-subtle p-2 text-xs"
      aria-label="Sumário da documentação"
    >
      <ul className="flex flex-col gap-0.5">
        {link('doc-project', <span className="truncate">Projeto {doc.project.name}</span>)}
        {doc.connectors.map((c, ci) => (
          <li key={c.id}>
            <ul className="flex flex-col gap-0.5">
              {link(connectorAnchor(ci), <span className="truncate text-fg">{c.name}</span>)}
              {c.endpoints.map((e, ei) =>
                link(
                  endpointAnchor(ci, ei),
                  <>
                    <MethodBadge method={e.method} className="w-14" />
                    <span className="truncate" title={`${e.path} · ${e.name}`}>
                      {e.name}
                    </span>
                  </>,
                  1
                )
              )}
            </ul>
          </li>
        ))}
        {doc.issues.length > 0 && link('doc-issues', <span>Avisos ({doc.issues.length})</span>)}
      </ul>
    </DockablePane>
  )
}

function DocumentBody({ doc }: { doc: ApiDocument }) {
  const names = new Map(doc.connectors.flatMap((c) => c.chain.map((x) => [x.id, x.name] as const)))
  const name = (id: string) => names.get(id) ?? id
  const p = doc.project
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">{doc.title}</h1>
        <p className="text-xs text-muted">
          {doc.scope.kind === 'project' ? 'Projeto' : `${doc.scopeLabel} do projeto`} <span className="text-fg">{p.name}</span> · gerado em{' '}
          {new Date(doc.generatedAt).toLocaleString('pt-BR')} por {doc.generator}. Variáveis secretas aparecem só pelo
          nome: nenhum valor de segredo entra neste documento.
        </p>
      </div>

      <Section id="doc-project" title="Projeto">
        <dl className="grid grid-cols-5 overflow-hidden rounded-[var(--radius-card)] border border-border text-xs">
          {(
            [
              ['Conectores', p.connectors],
              ['Endpoints', p.endpoints],
              ['Requests', p.scenarios],
              ['Fluxos', p.flows],
              ['Ambientes', p.environments.length]
            ] as const
          ).map(([label, value], i) => (
            <div key={label} className={cx('flex flex-col gap-0.5 bg-panel px-3 py-2', i > 0 && 'border-l border-border')}>
              <dt className="text-muted">{label}</dt>
              <dd className="font-mono text-sm text-fg">{value}</dd>
            </div>
          ))}
        </dl>
        {p.map && (
          <Sub title="Mapa do projeto">
            <MermaidDiagram source={p.map} label={`Mapa do projeto ${p.name}`} />
          </Sub>
        )}
        {p.environments.length > 0 && (
          <Sub title="Ambientes">
            <table className={table.root} aria-label="Ambientes">
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Ambiente</th>
                  <th className={table.th}>Id</th>
                  <th className={`${table.th} text-right`}>Variáveis</th>
                  <th className={`${table.th} text-right`}>Segredos</th>
                </tr>
              </thead>
              <tbody>
                {p.environments.map((env) => (
                  <tr key={env.id} className={table.row}>
                    <td className={table.td}>{env.name}</td>
                    <td className={`${table.td} font-mono text-muted`}>{env.id}</td>
                    <td className={`${table.td} text-right font-mono`}>{env.variables}</td>
                    <td className={`${table.td} text-right font-mono`}>{env.secrets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Sub>
        )}
        {doc.variables.length > 0 && (
          <Sub title="Variáveis usadas">
            <table className={table.root} aria-label="Variáveis usadas">
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Variável</th>
                  <th className={table.th}>Tipo</th>
                  <th className={table.th}>Valor por ambiente</th>
                  <th className={table.th}>Ausente em</th>
                </tr>
              </thead>
              <tbody>
                {doc.variables.map((v) => (
                  <tr key={v.name} className={table.row}>
                    <td className={table.td}>
                      <code className="font-mono text-cyan">{`{{${v.name}}}`}</code>
                      {v.description && <div className="text-muted">{v.description}</div>}
                    </td>
                    <td className={table.td}>
                      {v.secret ? (
                        <Badge tone="warning">
                          <Lock size={11} aria-hidden /> Segredo
                        </Badge>
                      ) : (
                        <Badge>Valor</Badge>
                      )}
                    </td>
                    <td className={`${table.td} font-mono break-all`}>
                      {v.secret ? (
                        <span className="font-sans text-muted">no vault, nunca exportado</span>
                      ) : Object.keys(v.values).length ? (
                        Object.entries(v.values).map(([env, value]) => (
                          <div key={env}>
                            <span className="text-muted">{env}:</span> {value}
                          </div>
                        ))
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className={`${table.td} font-mono`}>
                      {v.missingIn.length ? (
                        <span className="text-warning">{v.missingIn.join(', ')}</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Sub>
        )}
        {p.flowList.length > 0 && (
          <Sub title="Fluxos">
            <table className={table.root} aria-label="Fluxos">
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Fluxo</th>
                  <th className={table.th}>Arquivo</th>
                  <th className={`${table.th} text-right`}>Nós</th>
                  <th className={table.th}>Conectores</th>
                </tr>
              </thead>
              <tbody>
                {p.flowList.map((f) => (
                  <tr key={f.id} className={table.row}>
                    <td className={table.td}>
                      {f.name}
                      {f.description && <div className="text-muted">{f.description}</div>}
                    </td>
                    <td className={`${table.td} font-mono text-muted`}>{f.file}</td>
                    <td className={`${table.td} text-right font-mono`}>{f.nodes}</td>
                    <td className={`${table.td} font-mono`}>{f.connectors.map(name).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Sub>
        )}
      </Section>

      {doc.connectors.map((c, ci) => (
        <ConnectorDoc key={c.id} connector={c} index={ci} name={name} />
      ))}

      {doc.issues.length > 0 && (
        <Section id="doc-issues" title="Avisos">
          <ul className="flex flex-col gap-1 text-xs">
            {doc.issues.map((i, n) => (
              <li key={n} className="text-warning">
                <span className="font-mono">{i.file}</span>: {i.message}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

function ConnectorDoc({ connector: c, index, name }: { connector: DocConnector; index: number; name: (id: string) => string }) {
  const r = c.effective
  const origin = (from: string) =>
    from === c.id ? <InheritanceBadge kind="local" /> : <InheritanceBadge kind="inherited" from={name(from)} />
  return (
    <Section id={connectorAnchor(index)} title={c.name} kicker="Conector" aside={<span className="font-mono text-[11px] text-muted">v{c.version}</span>}>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-xs">
        <Meta term="Id" mono>
          {c.id}
        </Meta>
        <Meta term="Arquivo" mono>
          {c.file}
        </Meta>
        <Meta term="Cadeia de herança">
          {c.chain.map((x, i) => (
            <span key={x.id}>
              {i > 0 && <span className="px-1 text-faint">→</span>}
              <span className={x.id === c.id ? 'text-fg' : 'text-cyan'}>{x.name}</span>
            </span>
          ))}
        </Meta>
        {c.children.length > 0 && <Meta term="Filhos">{c.children.join(', ')}</Meta>}
        {c.shared && <Meta term="Origem">Catálogo compartilhado {c.shared} (somente leitura)</Meta>}
        {c.docsFile && (
          <Meta term="Documentação escrita" mono>
            {c.docsFile}
          </Meta>
        )}
      </dl>
      {c.error && <p className="text-xs text-danger">Herança quebrada: {c.error}</p>}
      {(c.description || c.overview) && (
        <Sub title="Documentação escrita">
          {c.description && <Markdown source={c.description} />}
          {c.overview && <Markdown source={c.overview} />}
        </Sub>
      )}

      <Sub title="Hierarquia e herança">
        <MermaidDiagram source={c.diagrams.hierarchy} label={`Hierarquia de ${c.name}`} />
        {r && (
          <table className={table.root} aria-label={`Configuração efetiva de ${c.name}`}>
            <thead className={table.head}>
              <tr>
                <th className={`${table.th} w-36`}>Campo</th>
                <th className={table.th}>Valor efetivo</th>
                <th className={`${table.th} w-72`}>Origem</th>
              </tr>
            </thead>
            <tbody>
              <Row label="URL base" value={r.baseUrl ? <code>{r.baseUrl.value}</code> : <Muted>nenhum conector define</Muted>}>
                {r.baseUrl && origin(r.baseUrl.from)}
              </Row>
              <Row label="basePath" value={r.basePath ? <code>{r.basePath}</code> : <Muted>—</Muted>}>
                <Muted>acumulado na cadeia</Muted>
              </Row>
              {r.headers.map((h) => (
                <Row key={h.name} label={`Header ${h.name}`} value={<code>{h.value}</code>}>
                  <HeaderOrigin header={h} self={c.id} name={name} />
                </Row>
              ))}
              <Row label="Auth" value={r.auth ? r.auth.summary : r.authDisabledBy ? 'Desligada' : <Muted>nenhuma</Muted>}>
                {r.auth ? origin(r.auth.from) : r.authDisabledBy ? origin(r.authDisabledBy) : null}
              </Row>
              <Row label="mTLS" value={r.tlsFrom ? 'Certificado de cliente' : <Muted>nenhum</Muted>}>
                {r.tlsFrom && origin(r.tlsFrom)}
              </Row>
            </tbody>
          </table>
        )}
      </Sub>

      {r?.auth && (
        <Sub title="Autenticação">
          <p className="text-xs">
            {r.auth.summary}, {r.auth.from === c.id ? 'definida neste conector' : `herdada de ${name(r.auth.from)}`}.
          </p>
          {r.auth.details.length > 0 && (
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-xs">
              {r.auth.details.map((d) => (
                <Meta key={d.name} term={d.name} mono>
                  {d.value}
                </Meta>
              ))}
            </dl>
          )}
          {c.diagrams.auth && <MermaidDiagram source={c.diagrams.auth} label={`Fluxo de autenticação de ${c.name}`} />}
        </Sub>
      )}

      <Sub title="Endpoints">
        {c.endpoints.length === 0 ? (
          <Muted>Este conector não declara endpoints.</Muted>
        ) : (
          <div className="flex flex-col gap-4">
            {c.endpoints.map((e, ei) => (
              <EndpointDocView key={e.id} endpoint={e} connector={c} anchor={endpointAnchor(index, ei)} name={name} />
            ))}
          </div>
        )}
        {c.omittedEndpoints > 0 && <Muted>Mais {c.omittedEndpoints} endpoint(s) do conector fora deste documento.</Muted>}
      </Sub>
    </Section>
  )
}

function EndpointDocView(props: {
  endpoint: DocEndpoint
  connector: DocConnector
  anchor: string
  name: (id: string) => string
}) {
  const { endpoint: e, connector: c, name } = props
  return (
    <section
      id={props.anchor}
      className="flex scroll-mt-4 flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-panel p-4"
      aria-label={`Endpoint ${e.name}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <MethodBadge method={e.method} />
        <h3 className="font-mono text-[13px] font-semibold">{e.path}</h3>
        <span className="text-xs text-muted">{e.name}</span>
        <span className="ml-auto text-[11px] text-faint">
          {e.scenarios.length} {e.scenarios.length === 1 ? 'request' : 'requests'}
        </span>
        <Button
          size="sm"
          icon={<Play size={13} aria-hidden />}
          title="Abrir no Quick Request, com a herança do conector"
          aria-label={`Testar ${e.name} no Quick Request`}
          onClick={() => testEndpoint(c.id, e)}
        >
          Testar
        </Button>
      </div>
      {e.url && <code className="font-mono text-xs break-all text-cyan">{e.url}</code>}
      {e.description && <Markdown source={e.description} />}
      {e.docs && <Markdown source={e.docs} />}

      <Sub title="Sequência" small>
        <MermaidDiagram source={e.diagrams.sequence} label={`Sequência de ${e.name}`} />
      </Sub>

      {e.pathParams.length > 0 && (
        <Sub title="Parâmetros de rota" small>
          <div className="flex flex-wrap gap-1">
            {e.pathParams.map((p) => (
              <Badge key={p} mono>{`{${p}}`}</Badge>
            ))}
          </div>
        </Sub>
      )}

      <Sub title="Headers efetivos" small>
        {e.headers.length === 0 ? (
          <Muted>Nenhum header além dos da auth.</Muted>
        ) : (
          <table className={table.root} aria-label={`Headers efetivos de ${e.name}`}>
            <thead className={table.head}>
              <tr>
                <th className={table.th}>Header</th>
                <th className={table.th}>Valor</th>
                <th className={`${table.th} w-72`}>Origem</th>
              </tr>
            </thead>
            <tbody>
              {e.headers.map((h) => (
                <tr key={h.name} className={table.row}>
                  <td className={`${table.td} font-mono`}>{h.name}</td>
                  <td className={`${table.td} font-mono break-all`}>{h.value}</td>
                  <td className={table.td}>
                    <HeaderOrigin header={h} self={c.id} name={name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {c.effective?.auth && <Muted>A auth ({c.effective.auth.summary}) entra em cada chamada, depois dos headers.</Muted>}
      </Sub>

      {e.query.length > 0 && (
        <Sub title="Query" small>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-xs">
            {e.query.map((q) => (
              <Meta key={q.name} term={q.name} mono>
                {q.value}
              </Meta>
            ))}
          </dl>
        </Sub>
      )}

      {(e.fields.length > 0 || e.bodySchema || e.body !== undefined) && (
        <Sub title="Corpo" small>
          {e.sharedSchema && (
            <p className="text-xs text-muted">
              Schema compartilhado <code className="font-mono text-fg">{e.sharedSchema.name}</code> ({e.sharedSchema.file}), o mesmo em todos os endpoints que o
              citam.
            </p>
          )}
          {e.fields.length > 0 && (
            <table className={table.root} aria-label={`Campos do corpo de ${e.name}`}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Campo</th>
                  <th className={table.th}>Tipo</th>
                  <th className={table.th}>Obrigatório</th>
                  <th className={table.th}>Descrição</th>
                </tr>
              </thead>
              <tbody>
                {e.fields.map((f) => (
                  <tr key={f.path} className={table.row}>
                    <td className={`${table.td} font-mono`}>{f.path}</td>
                    <td className={`${table.td} font-mono text-muted`}>{f.values ? f.values.join(' | ') : f.type}</td>
                    <td className={table.td}>{f.required ? 'sim' : ''}</td>
                    <td className={table.td}>{f.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {e.bodySchema && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted hover:text-fg">JSON Schema do corpo</summary>
              <CodeBlock label={`JSON Schema de ${e.name}`} value={e.bodySchema} />
            </details>
          )}
          {e.body !== undefined && (
            <>
              <span className="text-[11px] text-muted">Exemplo (corpo padrão)</span>
              <CodeBlock label={`Corpo padrão de ${e.name}`} value={e.body} />
            </>
          )}
        </Sub>
      )}

      {e.checks.length > 0 && (
        <Sub title="Validação dos corpos com o schema" small>
          <ul className="flex flex-col gap-1 text-xs">
            {e.checks.map((k) => (
              <li key={k.source}>
                <span className={cx('inline-flex align-[-2px]', k.issues.length ? 'text-warning' : 'text-success')}>
                  {k.issues.length ? <X size={12} aria-label="fora do schema" /> : <Check size={12} aria-label="de acordo" />}
                </span>{' '}
                {k.label}
                {k.issues.length > 0 && (
                  <ul className="mt-1 ml-4 list-disc text-muted">
                    {k.issues.map((i, n) => (
                      <li key={n}>
                        <span className="font-mono">{i.path || '/'}</span> {i.message}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Sub>
      )}

      {e.scenarios.length > 0 && (
        <Sub title="Requests (cenários de teste)" small>
          <div className="flex flex-col gap-3">
            {e.scenarios.map((s) => (
              <ScenarioDoc key={s.id} scenario={s} onRun={() => runScenario(c.id, e.id, s.id)} />
            ))}
          </div>
        </Sub>
      )}

      {e.flows.length > 0 && (
        <Sub title="Fluxos que usam este endpoint" small>
          {e.flows.map((f) => (
            <div key={f.id} className="flex flex-col gap-2">
              <p className="flex flex-wrap items-center gap-x-1 text-xs">
                <span className="font-semibold">{f.name}</span> <span className="font-mono text-muted">{f.file}</span>, nós{' '}
                <span className="font-mono">{f.nodes.join(', ')}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  icon={<Workflow size={13} aria-hidden />}
                  aria-label={`Testar o fluxo ${f.name} no Flow Studio`}
                  onClick={() => openFlow(f.id)}
                >
                  Testar o fluxo
                </Button>
              </p>
              {f.description && <Muted>{f.description}</Muted>}
              <MermaidDiagram source={f.diagram} label={`Fluxo ${f.name}`} />
            </div>
          ))}
        </Sub>
      )}
    </section>
  )
}

function ScenarioDoc({ scenario: s, onRun }: { scenario: DocScenario; onRun: () => void }) {
  const o = s.overrides
  const rows: [string, ReactNode][] = []
  if (o.headers === null) rows.push(['Headers', <Muted key="h">todos os herdados removidos</Muted>])
  for (const h of o.headers ?? []) rows.push([`Header ${h.name}`, h.value === null ? <Muted key={h.name}>removido</Muted> : h.value])
  for (const q of o.query ?? []) rows.push([`Query ${q.name}`, q.value === null ? <Muted key={q.name}>removido</Muted> : q.value])
  for (const p of o.pathParams ?? []) rows.push([`Rota {${p.name}}`, p.value])
  return (
    <div role="group" className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-border-subtle p-3" aria-label={`Request ${s.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">{s.name}</span>
        <span className="font-mono text-[11px] text-faint">{s.id}</span>
        {s.expectedStatus !== undefined && (
          <Badge tone={statusTone(s.expectedStatus)} mono className="ml-auto">
            espera {s.expectedStatus}
          </Badge>
        )}
        <Button
          size="sm"
          variant="ghost"
          className={s.expectedStatus === undefined ? 'ml-auto' : undefined}
          icon={<Play size={13} aria-hidden />}
          aria-label={`Rodar a request ${s.name} nos Testes`}
          onClick={onRun}
        >
          Rodar
        </Button>
      </div>
      {s.description && <Markdown source={s.description} />}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-xs">
          {rows.map(([term, value]) => (
            <Meta key={term} term={term} mono>
              {value}
            </Meta>
          ))}
        </dl>
      )}
      {o.body !== undefined && <CodeBlock label={`Corpo de ${s.name}`} value={o.body} />}
      {s.check && s.check.issues.length > 0 && (
        <p className="text-xs text-warning">
          Corpo fora do schema: {s.check.issues.map((i) => `${i.path || '/'} ${i.message}`).join('; ')}
        </p>
      )}
      <table className={table.root} aria-label={`Asserções de ${s.name}`}>
        <thead className={table.head}>
          <tr>
            <th className={table.th}>Asserção</th>
            <th className={table.th}>Operador</th>
            <th className={table.th}>Esperado</th>
          </tr>
        </thead>
        <tbody>
          {s.assertions.map((a, i) => (
            <tr key={i} className={table.row}>
              <td className={`${table.td} font-mono`}>{a.target}</td>
              <td className={`${table.td} font-mono text-muted`}>{a.operator}</td>
              <td className={`${table.td} font-mono break-all`}>{a.expected ?? <Muted>—</Muted>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HeaderOrigin({ header: h, self, name }: { header: DocHeader; self: string; name: (id: string) => string }) {
  const label = (id: string) => (id === ENDPOINT_ORIGIN ? 'endpoint' : name(id))
  const own = h.from === ENDPOINT_ORIGIN || h.from === self
  return (
    <span className="flex flex-wrap gap-1">
      {own ? (
        h.overrides.length ? (
          <InheritanceBadge kind="overridden" from={h.overrides.map(label).join(', ')} />
        ) : (
          <InheritanceBadge kind="local" />
        )
      ) : (
        <>
          <InheritanceBadge kind="inherited" from={name(h.from)} />
          {h.overrides.length > 0 && <InheritanceBadge kind="overridden" from={h.overrides.map(label).join(', ')} />}
        </>
      )}
      {h.from === ENDPOINT_ORIGIN && <Badge>endpoint</Badge>}
    </span>
  )
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  const lines = value.split('\n').length
  return (
    <div
      className="mt-1 flex overflow-hidden rounded-[var(--radius-control)] border border-border"
      style={{ height: `${Math.min(20, Math.max(3, lines)) * 1.25 + 1}rem` }}
    >
      <CodeEditor ariaLabel={label} language={/^\s*[[{]/.test(value) ? 'json' : 'text'} value={value} />
    </div>
  )
}

function Section(props: { id: string; title: string; kicker?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={props.id} className="flex scroll-mt-4 flex-col gap-4" aria-label={props.title}>
      <div className="flex items-baseline gap-3 border-b border-border pb-2">
        {props.kicker && <span className="text-[11px] tracking-wide text-faint uppercase">{props.kicker}</span>}
        <h2 className="text-[15px] font-semibold">{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  )
}

function Sub({ title, small, children }: { title: string; small?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className={cx('font-semibold', small ? 'text-xs text-muted' : 'text-[13px]')}>{title}</h4>
      {children}
    </div>
  )
}

function Meta({ term, mono, children }: { term: string; mono?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className={cx('text-muted', mono && 'font-mono')}>{term}</dt>
      <dd className={cx('break-all', mono && 'font-mono')}>{children}</dd>
    </>
  )
}

function Row({ label, value, children }: { label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <tr className={table.row}>
      <td className={`${table.td} text-muted`}>{label}</td>
      <td className={`${table.td} font-mono break-all`}>{value}</td>
      <td className={table.td}>{children}</td>
    </tr>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted">{children}</span>
}
