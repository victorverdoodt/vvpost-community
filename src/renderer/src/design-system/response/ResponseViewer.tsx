import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Copy, Download, FileJson, Timer } from 'lucide-react'
import type { HttpResult } from '@shared/ipc'
import { EmptyState } from '../feedback/EmptyState'
import { ErrorNotice } from '../feedback/ErrorNotice'
import { formatBytes, formatMs } from '../format'
import { Badge, statusTone } from '../primitives/Badge'
import { Tabs } from '../primitives/Tabs'
import { table } from '../tables/ResultsTable'
import { useToast } from '../feedback/Toast'
import { separator, useContextMenu, type ContextMenuEntries } from '../navigation/ContextMenu'
import { parseCookies, suggestedFileName } from './body'
import type { JsonValueActions } from './JsonValueMenu'
import { ScriptReport, scriptTabLabel } from './ScriptReport'

const ResponseBody = /* @__PURE__ */ lazy(() => import('./ResponseBody'))

type ResponseTab = 'body' | 'cookies' | 'headers' | 'timeline' | 'tests'

/**
 * Resposta de uma execução HTTP (Quick Request, cenários): status, duração e tamanho no topo, abas
 * de body, cookies, headers e timeline. O body tem os modos do Postman (Pretty com seleção de
 * linguagem, Raw, Preview, Visualize, Hex e Base64), busca, filtro JSONPath/XPath, quebra de
 * linha, copiar e salvar em arquivo. No Pretty de JSON, clicar num valor abre o DataPicker.
 * `meta` mostra de onde veio a auth e afins; `timeline` acrescenta etapas do motor (auth, retry).
 * Com scripts (fase 13), a aba Testes mostra os testes, o console e as variáveis deles.
 */
export function ResponseViewer(props: {
  result: HttpResult | null
  pending: boolean
  meta?: ReactNode
  /** Onde o erro aconteceu (ambiente, cenário), no padrão de erro. */
  errorLocation?: string
  /** Próxima ação de um erro (abrir Secrets, trocar de ambiente). */
  errorActions?: ReactNode
  timeline?: { label: string; ms: number; detail?: string }[]
  emptyHint?: string
  /** Rótulo da aba do corpo (padrão "Resposta"; o painel Webhooks mostra o que chegou). */
  bodyLabel?: string
  /** Template do modo Visualize; sem `onVisualizerChange`, o viewer guarda o template sozinho. */
  visualizer?: string
  onVisualizerChange?: (template: string) => void
  /** Ações do menu de valores do JSON que dependem do módulo (variável no ambiente, próxima requisição). */
  jsonActions?: JsonValueActions
  /** Itens do módulo no menu do painel (comparar com a anterior, gerar cenário). */
  menu?: () => ContextMenuEntries
}) {
  const [tab, setTab] = useState<ResponseTab>('body')
  const [ownTemplate, setOwnTemplate] = useState('')
  const { result } = props
  const ctx = useContextMenu()
  const notify = useToast()

  /** Menu do painel inteiro; o botão direito num valor do JSON abre o menu do valor (ResponseBody). */
  const panelEntries = (): ContextMenuEntries => {
    if (!result?.ok) return props.menu?.() ?? []
    const r = result.response
    const copy = (text: string, what: string) =>
      void navigator.clipboard.writeText(text).then(() => notify(`${what} na área de transferência.`, 'success'))
    const selection = window.getSelection()?.toString()
    return [
      selection && { id: 'copy-selection', label: 'Copiar a seleção', icon: <Copy size={14} aria-hidden />, run: () => copy(selection, 'Seleção copiada') },
      selection && separator,
      { id: 'copy-body', label: 'Copiar o corpo', icon: <Copy size={14} aria-hidden />, disabled: !r.body, run: () => copy(r.body, 'Corpo copiado') },
      {
        id: 'copy-headers',
        label: 'Copiar os headers',
        icon: <FileJson size={14} aria-hidden />,
        run: () => copy(r.headers.map((h) => `${h.name}: ${h.value}`).join('\n'), 'Headers copiados')
      },
      {
        id: 'copy-status',
        label: 'Copiar status e tempo',
        icon: <Timer size={14} aria-hidden />,
        run: () => copy(`${r.status} ${r.statusText} · ${formatMs(r.timings.totalMs)} · ${formatBytes(r.sizeBytes)}`, 'Status copiado')
      },
      {
        id: 'save',
        label: 'Salvar em arquivo…',
        icon: <Download size={14} aria-hidden />,
        run: () =>
          void window.vvpost
            .saveResponse({
              fileName: suggestedFileName(r.headers),
              data: r.bodyBase64 ?? r.body,
              encoding: r.bodyBase64 !== undefined ? 'base64' : 'utf8'
            })
            .then((s) => {
              if (s.ok) notify(`Resposta salva em ${s.path}`, 'success')
              else if (s.reason === 'error') notify(`Não deu para salvar: ${s.message}`, 'danger')
            })
      },
      ...(props.menu ? [separator, ...props.menu()] : [])
    ]
  }
  const menu = ctx.bind('Resposta', panelEntries)

  if (!result) {
    return (
      <EmptyState
        title={props.pending ? 'Enviando…' : 'Sem resposta ainda'}
        description={props.pending ? undefined : (props.emptyHint ?? 'A resposta aparecerá aqui.')}
      />
    )
  }

  if (!result.ok) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-4" {...menu}>
        {ctx.menu}
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted">{formatMs(result.timings.totalMs)}</span>
          {props.meta}
        </div>
        <ErrorNotice
          title={result.error.code === 'ABORTED' ? 'Requisição cancelada' : 'Falha ao executar a requisição'}
          code={result.error.code}
          message={result.error.message}
          location={props.errorLocation}
          actions={props.errorActions}
        />
        {result.scripts && (result.scripts.logs || result.scripts.ran.length > 1) && <ScriptReport scripts={result.scripts} />}
      </div>
    )
  }

  const { response } = result
  const t = response.timings
  const steps = [
    ...(props.timeline ?? []),
    { label: 'Primeiro byte (TTFB)', ms: t.ttfbMs },
    { label: 'Download', ms: t.downloadMs },
    { label: 'Total', ms: t.totalMs }
  ]
  const max = Math.max(...steps.map((s) => s.ms), 1)
  const cookies = parseCookies(response.headers)
  // A aba Testes só existe com scripts: numa resposta sem eles, volta para o corpo.
  const shown: ResponseTab = tab === 'tests' && !result.scripts ? 'body' : tab

  return (
    <section
      aria-label="Resposta"
      className={`flex min-h-0 flex-1 flex-col ${props.pending ? 'opacity-60' : ''}`}
      {...menu}
    >
      {ctx.menu}
      <Tabs
        label="Resposta"
        variant="segmented"
        value={shown}
        onChange={setTab}
        tabs={[
          { id: 'body', label: props.bodyLabel ?? 'Resposta' },
          { id: 'cookies', label: `Cookies (${cookies.length})` },
          { id: 'headers', label: `Headers (${response.headers.length})` },
          { id: 'timeline', label: 'Timeline' },
          ...(result.scripts ? [{ id: 'tests' as const, label: scriptTabLabel(result.scripts) }] : [])
        ]}
        right={
          <>
            <Badge tone={statusTone(response.status)} mono>
              {response.status} {response.statusText}
            </Badge>
            <span
              className="whitespace-nowrap font-mono text-xs text-muted"
              title={`TTFB ${formatMs(t.ttfbMs)} · download ${formatMs(t.downloadMs)}`}
            >
              {formatMs(t.totalMs)}
            </span>
            <span className="whitespace-nowrap font-mono text-xs text-muted">{formatBytes(response.sizeBytes)}</span>
            {props.meta && <span className="truncate text-xs">{props.meta}</span>}
          </>
        }
      />
      {shown === 'body' && (
        <Suspense fallback={<div className="flex-1" />}>
          <ResponseBody
          response={response}
          template={props.visualizer ?? ownTemplate}
            onTemplateChange={props.onVisualizerChange ?? setOwnTemplate}
            {...(props.jsonActions && { jsonActions: props.jsonActions })}
          />
        </Suspense>
      )}
      {shown === 'cookies' &&
        (cookies.length ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className={table.root} aria-label="Cookies da resposta">
              <thead className={table.head}>
                <tr>
                  {['Nome', 'Valor', 'Domain', 'Path', 'Expira', 'HttpOnly', 'Secure', 'SameSite'].map((h) => (
                    <th key={h} className={table.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                {cookies.map((c, i) => (
                  <tr key={i} className={table.row}>
                    <td className={table.td}>{c.name}</td>
                    <td className={`${table.td} break-all`}>{c.value}</td>
                    <td className={table.td}>{c.domain ?? ''}</td>
                    <td className={table.td}>{c.path ?? ''}</td>
                    <td className={table.td}>{c.expires ?? (c.maxAge !== undefined ? `max-age ${c.maxAge}` : 'Sessão')}</td>
                    <td className={table.td}>{c.httpOnly ? 'sim' : 'não'}</td>
                    <td className={table.td}>{c.secure ? 'sim' : 'não'}</td>
                    <td className={table.td}>{c.sameSite ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Sem cookies" description="A resposta não trouxe nenhum Set-Cookie." />
        ))}
      {shown === 'headers' && (
        <table className="w-full font-mono text-xs">
          <tbody>
            {response.headers.map((h, i) => (
              <tr key={i} className="border-b border-border-subtle">
                <td className="w-1/3 px-3 py-1 align-top text-muted">{h.name}</td>
                <td className="px-3 py-1 break-all">{h.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown === 'tests' && result.scripts && <ScriptReport scripts={result.scripts} />}
      {shown === 'timeline' && (
        <ol className="flex flex-col gap-2 p-3 text-xs">
          {steps.map((s) => (
            <li key={s.label} className="grid grid-cols-[10rem_1fr_4.5rem] items-center gap-3" title={s.detail}>
              <span className="truncate text-muted">{s.label}</span>
              <span className="h-1.5 rounded-full bg-elevated">
                <span
                  className="block h-full rounded-full bg-info"
                  style={{ width: `${Math.max(2, (s.ms / max) * 100)}%` }}
                />
              </span>
              <span className="text-right font-mono">{formatMs(s.ms)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
