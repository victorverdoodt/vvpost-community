import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Download, Filter, Search, WrapText, X } from 'lucide-react'
import type { HttpResponseData } from '@shared/ipc'
import { CodeEditor } from '../editors/CodeEditor'
import { wrapIndex } from '../find/find'
import { emptyFind, FindBar, isFindShortcut, type FindState } from '../find/FindBar'
import { useToast } from '../feedback/Toast'
import { formatBytes } from '../format'
import { IconButton, controlClass } from '../primitives/Button'
import { SegmentedControl } from '../primitives/SegmentedControl'
import {
  bodyBytes,
  bytesToBase64,
  detectLanguage,
  findMatches,
  formatXml,
  header,
  hexDump,
  LANGUAGE_LABELS,
  mediaKind,
  suggestedFileName,
  type BodyLanguage
} from './body'
import { evaluateJsonPath, toJsonPath, type JsonPathKey } from './jsonpath'
import { valueAt } from './json-locate'
import { useContextMenu } from '../navigation/ContextMenu'
import { jsonCommandFor, jsonValueEntries, useJsonCommand, VariableDialog, type JsonValueActions } from './JsonValueMenu'
import { ResponsePreview } from './ResponsePreview'
import { containerKeys, highlight, jsonHighlight, pathKey, type Highlight, type Segment } from './segments'
import { Visualizer } from './Visualizer'

/** Acima disso o corpo é mostrado como veio, sem formatar, para não travar a interface. */
const PRETTY_LIMIT = 2 * 1024 * 1024
/** Acima disso o texto vai sem realce (e sem DataPicker). */
const HIGHLIGHT_LIMIT = 256 * 1024
/** Hex e Base64 mostram só o começo de corpos grandes; salvar grava tudo. */
const HEX_LIMIT = 512 * 1024
const BASE64_LIMIT = 1536 * 1024

/** Os modos do corpo, como no Postman. */
export type BodyView = 'pretty' | 'raw' | 'hex' | 'base64' | 'preview' | 'visualize'

const VIEWS: { value: BodyView; label: string; title: string }[] = [
  { value: 'pretty', label: 'Pretty', title: 'Formatado e realçado pela linguagem' },
  { value: 'raw', label: 'Raw', title: 'O corpo exatamente como veio' },
  { value: 'preview', label: 'Preview', title: 'HTML, imagem, PDF, áudio e vídeo renderizados (isolado, sem scripts nem rede)' },
  { value: 'visualize', label: 'Visualize', title: 'Template seu sobre a resposta (como o pm.visualizer)' },
  { value: 'hex', label: 'Hex', title: 'Bytes em hexadecimal' },
  { value: 'base64', label: 'Base64', title: 'Bytes em Base64' }
]

interface Display extends Highlight {
  notice?: string
  /** Erro do filtro (sintaxe) ou aviso de resultado vazio. */
  filterError?: string
  /** O filtro se aplica a este modo e linguagem. */
  filterable: 'jsonpath' | 'xpath' | null
}

/** O corpo da resposta (carregado na primeira resposta, fora do cold start). */
export default function ResponseBody(props: {
  response: HttpResponseData
  template: string
  onTemplateChange: (template: string) => void
  jsonActions?: JsonValueActions
}) {
  const { response } = props
  const notify = useToast()
  const contentType = header(response.headers, 'content-type')
  const binary = response.bodyBase64 !== undefined
  const kind = useMemo(() => mediaKind(contentType, response.body, binary), [contentType, response.body, binary])
  const detected = useMemo(() => detectLanguage(contentType, response.body), [contentType, response.body])
  const autoView: BodyView =
    kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf' ? 'preview' : binary ? 'hex' : 'pretty'

  const [chosenView, setView] = useState<BodyView | null>(null)
  const view = chosenView ?? autoView
  const [chosenLanguage, setLanguage] = useState<BodyLanguage | 'auto'>('auto')
  const language = chosenLanguage === 'auto' ? detected : chosenLanguage
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const [search, setSearch] = useState<FindState | null>(null)
  const [filter, setFilter] = useState<string | null>(null)
  /** Valor selecionado (destacado; os atalhos agem nele) e o menu aberto sobre ele. */
  const [selected, setSelected] = useState<{ pick: number; path: JsonPathKey[] } | null>(null)
  const ctx = useContextMenu()
  const [variable, setVariable] = useState<{ x: number; y: number; path: JsonPathKey[] } | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const container = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  // Resposta nova: um corpo binário volta ao modo automático (prévia ou hex); texto mantém o escolhido.
  useEffect(() => {
    setSelected(null)
    setVariable(null)
    setCollapsed(new Set())
    if (binary && chosenView !== 'hex' && chosenView !== 'base64') setView(null)
  }, [response]) // eslint-disable-line react-hooks/exhaustive-deps

  const bytes = useMemo(
    () => (view === 'hex' || view === 'base64' || view === 'preview' ? bodyBytes(response) : new Uint8Array()),
    [view, response]
  )

  const parsedJson = useMemo(() => {
    if (view !== 'pretty' || language !== 'json' || response.body.length > PRETTY_LIMIT) return undefined
    try {
      return { value: JSON.parse(response.body) as unknown }
    } catch {
      return undefined
    }
  }, [view, language, response.body])

  const display = useMemo((): Display | null => {
    const plain = (text: string, extra: Partial<Display> = {}): Display => ({
      text,
      segments: [{ text }],
      paths: [],
      filterable: null,
      ...extra
    })
    if (view === 'raw') return plain(response.body)
    if (view === 'hex') {
      return plain(hexDump(bytes, HEX_LIMIT), {
        ...(bytes.length > HEX_LIMIT && {
          notice: `Mostrando os primeiros ${formatBytes(HEX_LIMIT)} de ${formatBytes(bytes.length)}. Salve a resposta para ter todos os bytes.`
        })
      })
    }
    if (view === 'base64') {
      return plain(bytesToBase64(bytes.subarray(0, BASE64_LIMIT)), {
        ...(bytes.length > BASE64_LIMIT && {
          notice: `Mostrando os primeiros ${formatBytes(BASE64_LIMIT)} de ${formatBytes(bytes.length)}.`
        })
      })
    }
    if (view !== 'pretty') return null
    if (response.body.length > PRETTY_LIMIT) {
      return plain(response.body, { notice: `Corpo acima de ${formatBytes(PRETTY_LIMIT)}: mostrado sem formatar.` })
    }
    if (language === 'json') {
      if (!parsedJson) return { ...highlightIfSmall(response.body, 'json'), filterable: null }
      if (filter?.trim()) {
        try {
          const matches = evaluateJsonPath(parsedJson.value, filter)
          const h = jsonHighlight(
            matches.map((m) => m.value),
            matches.map((m) => m.path),
            collapsed
          )
          return {
            ...(h.text.length > HIGHLIGHT_LIMIT ? { text: h.text, segments: [{ text: h.text }], paths: [] } : h),
            filterable: 'jsonpath',
            ...(!matches.length && { filterError: 'Nenhum resultado para este caminho' })
          }
        } catch (err) {
          return { ...jsonPretty(parsedJson.value, collapsed), filterable: 'jsonpath', filterError: (err as Error).message }
        }
      }
      return { ...jsonPretty(parsedJson.value, collapsed), filterable: 'jsonpath' }
    }
    if (language === 'xml' || language === 'html') {
      if (filter?.trim()) {
        const out = evaluateXPath(response.body, filter, language)
        if ('error' in out) return { ...highlightIfSmall(formatXml(response.body), language), filterable: 'xpath', filterError: out.error }
        return {
          ...highlightIfSmall(out.text, language),
          filterable: 'xpath',
          ...(!out.count && { filterError: 'Nenhum resultado para esta expressão' })
        }
      }
      return { ...highlightIfSmall(formatXml(response.body), language), filterable: 'xpath' }
    }
    return { ...highlightIfSmall(response.body, language), filterable: null }
  }, [view, language, response.body, bytes, parsedJson, filter, collapsed])

  const matches = useMemo(
    () => (display && search?.query ? findMatches(display.text, search.query, search.caseSensitive) : []),
    [display, search?.query, search?.caseSensitive]
  )
  const current = wrapIndex(search?.index ?? 0, matches.length)

  useEffect(() => {
    if (current < 0) return
    scroller.current?.querySelector('[data-match-current]')?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [current, matches])

  const content = useMemo(
    () => (display ? renderSegments(display.segments, matches, current, selected?.pick ?? -1) : null),
    [display, matches, current, selected]
  )

  const openSearch = () => {
    setSearch((s) => s ?? emptyFind)
    requestAnimationFrame(() => searchInput.current?.select())
  }

  const copy = () => {
    const text = display ? display.text : response.body
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  const save = () => {
    void window.vvpost
      .saveResponse({
        fileName: suggestedFileName(response.headers),
        data: response.bodyBase64 ?? response.body,
        encoding: response.bodyBase64 !== undefined ? 'base64' : 'utf8'
      })
      .then((r) => {
        if (r.ok) notify(`Resposta salva em ${r.path}`, 'success')
        else if (r.reason === 'error') notify(`Não deu para salvar: ${r.message}`, 'danger')
      })
  }

  const runCommand = useJsonCommand(props.jsonActions)
  const valueOf = (path: JsonPathKey[]) => (parsedJson ? valueAt(parsedJson.value, path) : undefined)

  // Clique ou botão direito num valor: seleciona e abre o menu; num nó recolhido, expande.
  const onPick = useCallback(
    (e: React.MouseEvent<HTMLPreElement>) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]')
      if (!el || !display) return
      if (e.type === 'click' && window.getSelection()?.toString()) return
      const pick = Number(el.dataset['pick'])
      const path = display.paths[pick]
      if (!path) return
      e.preventDefault()
      if (el.dataset['folded'] !== undefined && e.type === 'click') {
        setCollapsed((all) => {
          const next = new Set(all)
          next.delete(pathKey(path))
          return next
        })
        return
      }
      setSelected({ pick, path })
      const at = { x: e.clientX, y: e.clientY + 6 }
      ctx.openAt(
        at,
        toJsonPath(path),
        jsonValueEntries({
          ...(props.jsonActions && { actions: props.jsonActions }),
          run: (command) => runCommand(command, path, valueOf(path)),
          onUseAsVariable: () => setVariable({ ...at, path }),
          onFilter: () => setFilter(toJsonPath(path)),
          onExpandAll: () => setCollapsed(new Set()),
          onCollapseAll: () => setCollapsed(allContainers())
        })
      )
    },
    [display, parsedJson, filter, props.jsonActions] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const allContainers = (): Set<string> => {
    if (!parsedJson) return new Set()
    if (filter?.trim() && !display?.filterError) {
      return evaluateJsonPath(parsedJson.value, filter).reduce((acc, m) => containerKeys(m.value, m.path, acc), new Set<string>())
    }
    return containerKeys(parsedJson.value)
  }

  const textView = view === 'pretty' || view === 'raw' || view === 'hex' || view === 'base64'

  return (
    <div
      ref={container}
      className="relative flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        // Atalhos do menu de valores, com um valor selecionado e nenhum texto selecionado.
        const command = selected && !variable && !(e.target instanceof HTMLInputElement) ? jsonCommandFor(e) : null
        if (command && selected && !window.getSelection()?.toString()) {
          e.preventDefault()
          ctx.close()
          if (command === 'use-as-variable') {
            if (props.jsonActions?.variableTarget) {
              const box = scroller.current?.querySelector('[data-selected]')?.getBoundingClientRect()
              setVariable({ x: box?.left ?? 100, y: (box?.bottom ?? 100) + 4, path: selected.path })
            }
          } else runCommand(command, selected.path, valueOf(selected.path))
          return
        }
        if (e.key === 'Escape' && selected) setSelected(null)
        if (isFindShortcut(e) && textView) {
          e.preventDefault()
          openSearch()
        }
      }}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-2 text-xs text-muted">
        <SegmentedControl
          label="Modo de visualização do corpo"
          value={view}
          onChange={(v) => {
            setView(v)
            setSelected(null)
            setVariable(null)
          }}
          options={VIEWS.map((v) => ({ value: v.value, label: v.label, title: v.title }))}
        />
        {view === 'pretty' && (
          <select
            aria-label="Linguagem do Pretty"
            className={`${controlClass} h-6`}
            value={chosenLanguage}
            onChange={(e) => {
              setLanguage(e.target.value as BodyLanguage | 'auto')
              setFilter(null)
            }}
          >
            <option value="auto">Auto ({LANGUAGE_LABELS[detected]})</option>
            {(Object.keys(LANGUAGE_LABELS) as BodyLanguage[]).map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_LABELS[l]}
              </option>
            ))}
          </select>
        )}
        <span className="flex-1" />
        {display?.filterable && (
          <IconButton
            label={display.filterable === 'jsonpath' ? 'Filtrar com JSONPath' : 'Filtrar com XPath'}
            active={filter !== null}
            onClick={() => setFilter((f) => (f === null ? '' : null))}
          >
            <Filter size={14} aria-hidden />
          </IconButton>
        )}
        {textView && (
          <>
            <IconButton label="Buscar (Ctrl+F)" active={!!search} onClick={() => (search ? setSearch(null) : openSearch())}>
              <Search size={14} aria-hidden />
            </IconButton>
            <IconButton label={wrap ? 'Não quebrar linhas' : 'Quebrar linhas'} active={wrap} onClick={() => setWrap((w) => !w)}>
              <WrapText size={14} aria-hidden />
            </IconButton>
          </>
        )}
        <IconButton label={copied ? 'Copiado' : 'Copiar corpo'} onClick={copy}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </IconButton>
        <IconButton label="Salvar resposta em arquivo" onClick={save}>
          <Download size={14} aria-hidden />
        </IconButton>
      </div>

      {filter !== null && display?.filterable && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-2 text-xs">
          <Filter size={12} aria-hidden className={filter.trim() && !display.filterError ? 'text-success' : 'text-muted'} />
          <input
            aria-label={display.filterable === 'jsonpath' ? 'Filtro JSONPath' : 'Filtro XPath'}
            aria-invalid={display.filterError ? true : undefined}
            placeholder={display.filterable === 'jsonpath' ? '$.data[*].id' : '//item/name'}
            className={`${controlClass} h-6 flex-1 font-mono ${display.filterError ? 'border-warning' : ''}`}
            value={filter}
            autoFocus
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter(null)
            }}
          />
          {display.filterError && filter.trim() && <span className="truncate text-warning">{display.filterError}</span>}
          <IconButton label="Limpar filtro" onClick={() => setFilter(null)}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
      )}

      {search && textView && (
        <FindBar
          label="Buscar na resposta"
          state={search}
          onChange={setSearch}
          onClose={() => {
            setSearch(null)
            container.current?.querySelector<HTMLElement>('pre')?.focus()
          }}
          count={matches.length}
          current={current}
          inputRef={searchInput}
        />
      )}

      {display && content ? (
        <CodeEditor
          ariaLabel="Corpo da resposta"
          value={display.text}
          content={content}
          wrap={wrap}
          scrollRef={scroller}
          onCodeClick={display.paths.length ? onPick : undefined}
          onCodeContextMenu={display.paths.length ? onPick : undefined}
          className={display.paths.length ? '[&_[data-pick]]:cursor-pointer [&_[data-pick]:hover]:underline' : undefined}
          notice={
            (response.truncated || display.notice) && (
              <p className="px-3 pt-2 font-sans text-xs text-warning">
                {response.truncated
                  ? `Mostrando só o começo do corpo (${formatBytes(response.sizeBytes)} no total).`
                  : display.notice}
              </p>
            )
          }
        />
      ) : view === 'preview' ? (
        <ResponsePreview response={response} kind={kind} bytes={bytes} onHex={() => setView('hex')} onSave={save} />
      ) : view === 'visualize' ? (
        <Visualizer response={response} template={props.template} onTemplateChange={props.onTemplateChange} />
      ) : null}

      {ctx.menu}
      {variable && props.jsonActions && (
        <VariableDialog
          at={variable}
          path={variable.path}
          value={valueOf(variable.path)}
          actions={props.jsonActions}
          onClose={() => {
            setVariable(null)
            container.current?.querySelector<HTMLElement>('pre')?.focus()
          }}
        />
      )}
    </div>
  )
}

function jsonPretty(value: unknown, collapsed: ReadonlySet<string>): Highlight {
  const h = jsonHighlight(value, null, collapsed)
  return h.text.length > HIGHLIGHT_LIMIT ? { text: h.text, segments: [{ text: h.text }], paths: [] } : h
}

function highlightIfSmall(text: string, language: BodyLanguage): Highlight {
  return text.length > HIGHLIGHT_LIMIT ? { text, segments: [{ text }], paths: [] } : highlight(text, language)
}

/** XPath sobre XML ou HTML (o filtro do Postman para esses tipos), com o DOMParser do renderer. */
function evaluateXPath(text: string, expr: string, language: 'xml' | 'html'): { text: string; count: number } | { error: string } {
  const doc = new DOMParser().parseFromString(text, language === 'xml' ? 'application/xml' : 'text/html')
  if (language === 'xml' && doc.querySelector('parsererror')) return { error: 'O corpo não é XML válido' }
  let result: XPathResult
  try {
    result = doc.evaluate(expr, doc, doc.createNSResolver(doc.documentElement), XPathResult.ANY_TYPE, null)
  } catch (err) {
    return { error: (err as Error).message.replace(/^Failed to execute 'evaluate' on 'Document': /, '') }
  }
  switch (result.resultType) {
    case XPathResult.NUMBER_TYPE:
      return { text: String(result.numberValue), count: 1 }
    case XPathResult.STRING_TYPE:
      return { text: result.stringValue, count: 1 }
    case XPathResult.BOOLEAN_TYPE:
      return { text: String(result.booleanValue), count: 1 }
  }
  const parts: string[] = []
  const serializer = new XMLSerializer()
  for (let node = result.iterateNext(); node && parts.length < 5000; node = result.iterateNext()) {
    parts.push(
      node.nodeType === Node.ELEMENT_NODE
        ? formatXml(language === 'html' ? (node as Element).outerHTML : serializer.serializeToString(node))
        : (node.nodeValue ?? node.textContent ?? '')
    )
  }
  return { text: parts.join('\n'), count: parts.length }
}

/** Segmentos com as ocorrências da busca marcadas; a atual ganha `data-match-current`. */
function renderSegments(segments: Segment[], matches: [number, number][], current: number, selected: number): ReactNode[] {
  const out: ReactNode[] = []
  let offset = 0
  let m = 0
  let key = 0
  for (const seg of segments) {
    const end = offset + seg.text.length
    const pieces: ReactNode[] = []
    let pos = offset
    while (m < matches.length && matches[m]![0] < end) {
      const [ms, me] = matches[m]!
      if (me <= pos) {
        m++
        continue
      }
      const s = Math.max(ms, pos)
      const e = Math.min(me, end)
      if (s > pos) pieces.push(seg.text.slice(pos - offset, s - offset))
      pieces.push(
        <mark
          key={key++}
          {...(m === current && { 'data-match-current': '' })}
          className={m === current ? 'rounded-sm bg-warning text-surface' : 'rounded-sm bg-warning/30 text-fg'}
        >
          {seg.text.slice(s - offset, e - offset)}
        </mark>
      )
      pos = e
      if (me <= end) m++
      else break
    }
    if (pos < end) pieces.push(seg.text.slice(pos - offset))
    const inner = pieces.length === 1 ? pieces[0] : pieces
    out.push(
      seg.cls || seg.pick !== undefined ? (
        <span
          key={key++}
          className={seg.pick !== undefined && seg.pick === selected ? `${seg.cls ?? ''} rounded-sm bg-accent/20 outline outline-1 outline-accent/50` : seg.cls}
          {...(seg.pick !== undefined && { 'data-pick': seg.pick })}
          {...(seg.folded && { 'data-folded': '', title: 'Expandir' })}
          {...(seg.pick !== undefined && seg.pick === selected && { 'data-selected': '' })}
        >
          {inner}
        </span>
      ) : pieces.length === 1 && typeof pieces[0] === 'string' ? (
        pieces[0]
      ) : (
        <span key={key++}>{inner}</span>
      )
    )
    offset = end
  }
  return out
}
