import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Binary, Download } from 'lucide-react'
import type { HttpResponseData } from '@shared/ipc'
import { EmptyState } from '../feedback/EmptyState'
import { formatBytes } from '../format'
import { Button } from '../primitives/Button'
import { table } from '../tables/ResultsTable'
import { bytesToBase64, header, mimeOf, previewMime, sandboxedHtml, type MediaKind } from './body'

const PdfView = /* @__PURE__ */ lazy(() => import('./PdfView'))

/**
 * Modo Preview: HTML e Markdown renderizados num iframe sandbox sem scripts e sem rede; imagem,
 * áudio, vídeo e PDF a partir dos bytes; JSON como tabela; o resto como texto.
 */
export function ResponsePreview(props: {
  response: HttpResponseData
  kind: MediaKind
  bytes: Uint8Array
  onHex: () => void
  onSave: () => void
}) {
  const { response, kind, bytes } = props
  const mime = previewMime(header(response.headers, 'content-type'), bytes)
  const dataUrl = useMemo(
    () =>
      kind === 'image' || kind === 'audio' || kind === 'video'
        ? `data:${mime};base64,${response.bodyBase64 ?? bytesToBase64(bytes)}`
        : '',
    [kind, mime, response, bytes]
  )

  if (response.truncated && (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf')) {
    return (
      <EmptyState
        title="Resposta grande demais para a prévia"
        description={`O app guarda até 10 MB do corpo e este tem ${formatBytes(response.sizeBytes)}.`}
      />
    )
  }

  switch (kind) {
    case 'image':
      return <ImagePreview src={dataUrl} mime={mime} size={response.sizeBytes} />
    case 'audio':
      return (
        <div className="flex flex-1 items-center justify-center p-6">
          <audio controls src={dataUrl} aria-label="Áudio da resposta" />
        </div>
      )
    case 'video':
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-elevated p-4">
          <video controls src={dataUrl} aria-label="Vídeo da resposta" className="max-h-full max-w-full" />
        </div>
      )
    case 'pdf':
      return (
        <Suspense fallback={<p className="p-3 text-xs text-muted">Abrindo o PDF…</p>}>
          <PdfView bytes={bytes} />
        </Suspense>
      )
    case 'html':
      return <HtmlFrame html={response.body} />
    case 'markdown':
      return <MarkdownFrame text={response.body} />
    case 'json':
      return <JsonTable text={response.body} />
    case 'xml':
    case 'text':
      return (
        <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-words">
          {response.body}
        </div>
      )
    default:
      return (
        <EmptyState
          icon={<Binary size={20} aria-hidden />}
          title="Sem prévia para este tipo"
          description={`${mimeOf(header(response.headers, 'content-type')) || 'Sem content-type'} · ${formatBytes(response.sizeBytes)}`}
        >
          <Button size="sm" onClick={props.onHex}>
            Ver em hex
          </Button>
          <Button size="sm" icon={<Download size={14} aria-hidden />} onClick={props.onSave}>
            Salvar em arquivo
          </Button>
        </EmptyState>
      )
  }
}

function ImagePreview(props: { src: string; mime: string; size: number }) {
  const [dims, setDims] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  if (failed) return <EmptyState title="Não deu para abrir a imagem" description={`${props.mime} · ${formatBytes(props.size)}`} />
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-border-subtle px-3 py-1 text-[11px] text-muted">
        {props.mime}
        {dims && ` · ${dims}`} · {formatBytes(props.size)}
      </p>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={props.src}
          alt="Imagem da resposta"
          className="max-h-full max-w-full rounded-[var(--radius-control)] border border-border-subtle bg-[repeating-conic-gradient(var(--color-elevated)_0_25%,var(--color-panel)_0_50%)] bg-[length:16px_16px] object-contain"
          onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  )
}

/**
 * HTML da resposta isolado: sandbox sem allow-scripts nem allow-same-origin (origem opaca, sem
 * JavaScript, sem acesso ao app nem ao Node) e um CSP que corta a rede.
 */
function HtmlFrame(props: { html: string }) {
  const doc = useMemo(() => sandboxedHtml(props.html), [props.html])
  return (
    <iframe
      title="Prévia do HTML"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className="min-h-0 w-full flex-1 border-0 bg-fg"
    />
  )
}

function MarkdownFrame(props: { text: string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void Promise.all([import('marked'), import('dompurify')]).then(([{ marked }, { default: DOMPurify }]) => {
      const raw = marked.parse(props.text, { async: false })
      if (alive) {
        setHtml(
          `<style>body{font:14px system-ui,sans-serif;line-height:1.5;margin:16px;color:#11141a}pre,code{background:#e7eaf0;border-radius:4px}pre{padding:8px;overflow:auto}</style>` +
            DOMPurify.sanitize(raw)
        )
      }
    })
    return () => {
      alive = false
    }
  }, [props.text])
  return html === null ? <p className="p-3 text-xs text-muted">Renderizando…</p> : <HtmlFrame html={html} />
}

/** JSON como tabela (lista de objetos) ou como pares chave e valor. */
function JsonTable(props: { text: string }) {
  const parsed = useMemo(() => {
    try {
      return { value: JSON.parse(props.text) as unknown }
    } catch {
      return null
    }
  }, [props.text])
  if (!parsed) return <EmptyState title="JSON inválido" description="Use o modo Raw para ver o corpo como veio." />
  const value = parsed.value
  const rows = Array.isArray(value) ? value : null
  const objectRows = rows?.every((r) => r && typeof r === 'object' && !Array.isArray(r)) ? (rows as Record<string, unknown>[]) : null
  if (objectRows && objectRows.length) {
    const columns = [...new Set(objectRows.slice(0, 500).flatMap((r) => Object.keys(r)))].slice(0, 50)
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <table className={table.root} aria-label="Resposta em tabela">
          <thead className={table.head}>
            <tr>
              <th className={table.th}>#</th>
              {columns.map((c) => (
                <th key={c} className={table.th}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {objectRows.slice(0, 500).map((r, i) => (
              <tr key={i} className={table.row}>
                <td className={`${table.td} text-muted`}>{i}</td>
                {columns.map((c) => (
                  <td key={c} className={`${table.td} font-mono`}>
                    {cell(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {objectRows.length > 500 && <p className="p-3 text-xs text-muted">Mostrando 500 de {objectRows.length} itens.</p>}
      </div>
    )
  }
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : value && typeof value === 'object'
      ? Object.entries(value)
      : [['valor', value]]
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className={table.root} aria-label="Resposta em tabela">
        <tbody>
          {entries.slice(0, 1000).map(([k, v]) => (
            <tr key={k} className={table.row}>
              <th scope="row" className={`${table.td} w-1/3 text-left font-mono font-normal text-muted`}>
                {k}
              </th>
              <td className={`${table.td} font-mono break-all`}>{cell(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function cell(v: unknown): string {
  if (v === undefined) return ''
  if (v === null || typeof v !== 'object') return String(v)
  const text = JSON.stringify(v)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
