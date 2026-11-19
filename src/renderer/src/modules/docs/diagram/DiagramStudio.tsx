import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { ArrowLeft, ClipboardCopy, FilePlus2, FolderOpen, Minus, Plus, Save, Scan, Search } from 'lucide-react'
import type { DiagramBlock, DiagramIconPack } from '@shared/ipc'
import { diagramSlug, DIAGRAMS_DIR } from '@vvpost/core/docs/diagram-origin'
import {
  Badge,
  Button,
  CodeEditor,
  controlClass,
  cx,
  IconButton,
  SegmentedControl,
  usePromptDialog,
  useToast
} from '../../../design-system'
import { cleanSvgBody, diagramIconPacks, reloadDiagramIcons, renderMermaid } from '../../../design-system/content/Markdown'
import { BUILTIN_BLOCKS, categoryForKind, DIAGRAM_TEMPLATES, diagramKind } from './blocks'
import type { MermaidEditorHandle } from './monaco-mermaid'

let loading: Promise<(typeof import('./monaco-mermaid'))['monacoMermaid']> | null = null
const loadMonaco = () => (loading ??= import('./monaco-mermaid').then((m) => m.monacoMermaid))

/** Espera depois da última tecla antes de desenhar de novo. */
const RENDER_MS = 250
const BLOCK_MIME = 'application/x-vvpost-diagram-block'

/** O que o editor de diagramas abre e para onde grava. */
export interface DiagramTarget {
  code: string
  /** Como o diagrama aparece no título ("docs/arquitetura.md, linha 7", "Mapa do projeto"). */
  label: string
  /** Onde ele vive no workspace: Salvar grava lá. Sem origem e sem buffer, só "Salvar como". */
  origin?: { file: string; line?: number }
  /** O que estava lá quando abriu (para não sobrescrever uma mudança feita fora). */
  previous?: string
  /** Diagrama do editor do documento: Salvar devolve o código ao texto ainda não salvo. */
  buffer?: (code: string) => void
}

interface IconEntry {
  name: string
  svg: string
  width: number
  height: number
}

/**
 * Editor de diagramas Mermaid ao vivo, no espírito do Mermaid Live Editor e do draw.io: paleta de
 * blocos e de ícones (os do VVPost e os dos plugins) que entram no cursor ou são arrastados para o
 * código, o código no Monaco e a prévia redesenhada a cada pausa na digitação, com zoom e clique
 * no nó para achar o trecho. Grava de volta onde o diagrama vive (bloco de um Markdown, arquivo
 * .mmd ou o texto do editor do documento) ou num .mmd novo em docs/diagramas.
 */
export default function DiagramStudio(props: {
  target: DiagramTarget | null
  diagramFiles: string[]
  onBack(): void
  onSaved(file?: string): void
  /** O código mudou em relação ao salvo (ou voltou a ele). */
  onDirty?(dirty: boolean): void
}) {
  const notify = useToast()
  const dialog = usePromptDialog()
  const [target, setTarget] = useState<DiagramTarget>(
    () =>
      props.target ?? {
        code: DIAGRAM_TEMPLATES[0]!.code,
        label: 'Diagrama novo'
      }
  )
  const [code, setCode] = useState(target.code)
  const [saved, setSaved] = useState(target.code)
  const [preview, setPreview] = useState<{ svg: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'blocks' | 'icons'>('blocks')
  const [query, setQuery] = useState('')
  const [pluginBlocks, setPluginBlocks] = useState<DiagramBlock[]>([])
  const [packs, setPacks] = useState<{ prefix: string; title: string; icons: IconEntry[] }[]>([])
  const handle = useRef<MermaidEditorHandle | null>(null)
  const latest = useRef({ code, target, saved })
  latest.current = { code, target, saved }
  const dirty = code !== saved
  const { onDirty } = props
  useEffect(() => {
    onDirty?.(dirty)
  }, [dirty, onDirty])

  // Um diagrama novo pedido de fora (outro botão Editar) troca o que está aberto.
  useEffect(() => {
    if (!props.target) return
    setTarget(props.target)
    setCode(props.target.code)
    setSaved(props.target.code)
    handle.current?.setValue(props.target.code)
  }, [props.target])

  // Paleta: os blocos e os ícones dos plugins ligados (lidos de novo ao abrir o editor).
  useEffect(() => {
    let cancelled = false
    reloadDiagramIcons()
    void window.vvpost.diagramCatalog().then((r) => {
      if (cancelled || !r.ok) return
      setPluginBlocks(r.value.blocks)
      for (const issue of r.value.issues) notify(`Plugin ${issue.pluginId}: ${issue.message}`, 'warning')
    })
    void diagramIconPacks().then(async (loaded) => {
      const titles = new Map<string, string>([['vv', 'VVPost']])
      const r = await window.vvpost.diagramCatalog()
      if (r.ok) for (const p of r.value.iconPacks) titles.set(p.prefix, p.title)
      if (cancelled) return
      setPacks(
        loaded.map((p) => {
          const json = (p as unknown as { icons: DiagramIconPack['icons'] }).icons
          return {
            prefix: p.name,
            title: titles.get(p.name) ?? p.name,
            icons: Object.entries(json.icons).map(([name, icon]) => ({
              name,
              svg: p.name === 'vv' ? icon.body : cleanSvgBody(icon.body),
              width: icon.width ?? json.width ?? 16,
              height: icon.height ?? json.height ?? 16
            }))
          }
        })
      )
    })
    return () => {
      cancelled = true
    }
  }, [notify])

  // Prévia ao vivo: desenha depois de uma pausa; com erro, mantém o último desenho e mostra a mensagem.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void renderMermaid(code).then((r) => {
        if (cancelled) return
        if ('svg' in r) {
          setPreview(r)
          setError(null)
        } else setError(r.error)
      })
    }, RENDER_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code])

  const kind = diagramKind(code)
  const blocks = useMemo(() => {
    const all = [...BUILTIN_BLOCKS, ...pluginBlocks]
    const q = query.trim().toLowerCase()
    const found = q ? all.filter((b) => `${b.title} ${b.category} ${b.description ?? ''} ${b.code}`.toLowerCase().includes(q)) : all
    const groups = new Map<string, DiagramBlock[]>()
    for (const b of found) groups.set(b.category, [...(groups.get(b.category) ?? []), b])
    // O grupo do tipo do diagrama aberto vem primeiro.
    const first = categoryForKind(kind)
    return [...groups].sort(([a], [b]) => Number(b === first) - Number(a === first))
  }, [pluginBlocks, query, kind])

  const icons = useMemo(() => {
    const q = query.trim().toLowerCase()
    return packs
      .map((p) => ({
        ...p,
        icons: q ? p.icons.filter((i) => `${p.prefix}:${i.name}`.includes(q)) : p.icons
      }))
      .filter((p) => p.icons.length)
  }, [packs, query])

  const insert = (text: string, at?: { x: number; y: number }) => {
    if (handle.current) handle.current.insertBlock(text, at)
    else setCode((c) => `${c.replace(/\s+$/, '')}\n${text}\n`)
  }

  const replaceAll = async (next: string, title: string) => {
    if (latest.current.code.trim() && latest.current.code !== next) {
      const ok = await dialog.confirm({
        title: `Trocar o diagrama por "${title}"?`,
        message: 'O código atual sai do editor (Ctrl+Z desfaz até você salvar).',
        confirmLabel: 'Trocar'
      })
      if (!ok) return
    }
    setCode(next)
    handle.current?.setValue(next)
  }

  const openFile = async (file: string) => {
    if (latest.current.code !== latest.current.saved) {
      const ok = await dialog.confirm({
        title: 'Abrir outro diagrama?',
        message: 'As mudanças deste diagrama ainda não foram salvas e vão se perder.',
        confirmLabel: 'Abrir',
        danger: true
      })
      if (!ok) return
    }
    const r = await window.vvpost.readDiagram(file)
    if (!r.ok) {
      notify(`Não foi possível abrir: ${r.message}`, 'danger')
      return
    }
    const text = r.value.replace(/\s+$/, '')
    setTarget({ code: text, label: file, origin: { file }, previous: r.value })
    setCode(text)
    setSaved(text)
    handle.current?.setValue(text)
  }

  const save = useCallback(async () => {
    const { code: current, target: t } = latest.current
    if (t.buffer) {
      t.buffer(current)
      setSaved(current)
      notify('Diagrama devolvido ao documento; salve o documento para gravar', 'success')
      props.onBack()
      return
    }
    if (!t.origin) return saveAs()
    setBusy(true)
    const r = await window.vvpost.saveDiagram({
      file: t.origin.file,
      ...(t.origin.line && { line: t.origin.line }),
      code: current,
      ...(t.previous !== undefined && { previous: t.previous })
    })
    setBusy(false)
    if (!r.ok) {
      notify(`Não foi possível salvar: ${r.message}`, 'danger')
      return
    }
    setSaved(current)
    setTarget((x) => ({ ...x, previous: current }))
    notify(`Diagrama salvo em ${r.value.file}${r.value.line ? `, linha ${r.value.line}` : ''}`, 'success')
    props.onSaved(r.value.file)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify, props.onBack, props.onSaved])

  const saveAs = async () => {
    const name = await dialog.prompt({
      title: 'Salvar como diagrama do projeto',
      message: `Vai para ${DIAGRAMS_DIR}/ e para o Git. No documento, ele entra com {{> diagram ${DIAGRAMS_DIR}/<nome>.mmd}}.`,
      label: 'Nome do diagrama',
      initial: latest.current.target.origin ? '' : latest.current.target.label,
      validate: (v) => (diagramSlug(v) ? undefined : 'Dê um nome com letras ou números')
    })
    if (!name) return
    const file = `${DIAGRAMS_DIR}/${diagramSlug(name)}.mmd`
    const current = latest.current.code
    setBusy(true)
    const r = await window.vvpost.saveDiagram({
      file,
      code: current,
      create: true
    })
    setBusy(false)
    if (!r.ok) {
      notify(`Não foi possível salvar: ${r.message}`, 'danger')
      return
    }
    setTarget({
      code: current,
      label: file,
      origin: { file },
      previous: current
    })
    setSaved(current)
    const directive = `{{> diagram ${file}}}`
    await navigator.clipboard.writeText(directive).catch(() => undefined)
    notify(`Salvo em ${file}. A diretiva ${directive} foi copiada: cole no documento.`, 'success')
    props.onSaved(file)
  }

  const back = async () => {
    if (latest.current.code !== latest.current.saved) {
      const ok = await dialog.confirm({
        title: 'Sair sem salvar o diagrama?',
        message: 'As mudanças deste diagrama vão se perder.',
        confirmLabel: 'Sair sem salvar',
        danger: true
      })
      if (!ok) return
    }
    props.onBack()
  }

  const copy = async (what: 'markdown' | 'svg') => {
    const text = what === 'markdown' ? `\`\`\`mermaid\n${latest.current.code.replace(/\s+$/, '')}\n\`\`\`\n` : preview?.svg
    if (!text) return
    await navigator.clipboard.writeText(text)
    notify(what === 'markdown' ? 'Bloco Markdown copiado' : 'SVG copiado', 'success')
  }

  // Clique num nó da prévia: seleciona o id dele no código.
  const pickNode = (el: Element | null) => {
    const node = el?.closest('[data-id], g.node, g.actor, g.architecture-service')
    if (!node) return
    const raw = node.getAttribute('data-id') ?? node.id
    const id = /flowchart-(.+)-\d+$/.exec(raw)?.[1] ?? raw.replace(/^vvpost-mermaid-\d+-/, '').replace(/^service-/, '')
    if (id) handle.current?.selectId(id)
  }

  const dragBlock = (e: DragEvent, text: string) => {
    e.dataTransfer.setData(BLOCK_MIME, text)
    e.dataTransfer.setData('text/plain', text)
    e.dataTransfer.effectAllowed = 'copy'
  }
  const dropBlock = (e: DragEvent) => {
    const text = e.dataTransfer.getData(BLOCK_MIME)
    if (!text) return
    e.preventDefault()
    e.stopPropagation()
    insert(text, { x: e.clientX, y: e.clientY })
  }

  const where = target.buffer
    ? 'no documento em edição'
    : target.origin
      ? target.origin.line
        ? `${target.origin.file}, linha ${target.origin.line}`
        : target.origin.file
      : 'novo (sem arquivo)'

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Editor de diagramas">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} aria-hidden />} onClick={() => void back()}>
          Voltar
        </Button>
        <span className="font-medium">{target.label}</span>
        <span className="text-muted">{where}</span>
        {dirty && <Badge tone="warning">não salvo</Badge>}
        <span className="flex-1" />
        <select
          aria-label="Começar de um modelo"
          className={`max-w-48 ${controlClass}`}
          value=""
          onChange={(e) => {
            const t = DIAGRAM_TEMPLATES.find((x) => x.id === e.target.value)
            if (t) void replaceAll(t.code, t.title)
          }}
        >
          <option value="">Modelo…</option>
          {DIAGRAM_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        {props.diagramFiles.length > 0 && (
          <select
            aria-label="Abrir diagrama do projeto"
            className={`max-w-56 ${controlClass}`}
            value=""
            onChange={(e) => e.target.value && void openFile(e.target.value)}
          >
            <option value="">Abrir .mmd…</option>
            {props.diagramFiles.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" icon={<ClipboardCopy size={14} aria-hidden />} onClick={() => void copy('markdown')}>
          Copiar Markdown
        </Button>
        <Button size="sm" icon={<ClipboardCopy size={14} aria-hidden />} disabled={!preview} onClick={() => void copy('svg')}>
          Copiar SVG
        </Button>
        <Button size="sm" icon={<FilePlus2 size={14} aria-hidden />} disabled={busy} onClick={() => void saveAs()}>
          Salvar como .mmd…
        </Button>
        {(target.origin || target.buffer) && (
          <Button size="sm" variant="primary" icon={<Save size={14} aria-hidden />} disabled={busy || !dirty} onClick={() => void save()}>
            {target.buffer ? 'Aplicar no documento' : 'Salvar'}
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[14rem_minmax(0,1fr)_minmax(0,1.2fr)]">
        <aside className="flex min-h-0 flex-col border-r border-border" aria-label="Paleta">
          <div className="flex flex-col gap-2 border-b border-border p-2">
            <SegmentedControl
              label="Paleta"
              size="xs"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'blocks', label: 'Blocos' },
                { value: 'icons', label: 'Ícones' }
              ]}
            />
            <label className="relative">
              <Search size={12} aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted" />
              <input
                aria-label="Buscar na paleta"
                className={`w-full pl-6 ${controlClass}`}
                value={query}
                placeholder="Buscar"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
            {tab === 'blocks' ? (
              blocks.map(([category, items]) => (
                <section key={category} className="mb-3" aria-label={`Blocos: ${category}`}>
                  <h3 className="mb-1 font-medium text-muted">{category}</h3>
                  <ul className="flex flex-col gap-0.5">
                    {items.map((b) => (
                      <li key={`${b.pluginId ?? ''}:${b.title}:${b.code}`}>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => dragBlock(e, b.code)}
                          onClick={() => insert(b.code)}
                          title={`${b.description ? `${b.description}\n` : ''}${b.code}${b.pluginName ? `\n(${b.pluginName})` : ''}`}
                          className="flex w-full cursor-grab items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-border/50"
                        >
                          {b.icon && <PaletteIcon id={b.icon} packs={packs} />}
                          <span className="truncate">{b.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            ) : icons.length ? (
              icons.map((p) => (
                <section key={p.prefix} className="mb-3" aria-label={`Ícones: ${p.title}`}>
                  <h3 className="mb-1 font-medium text-muted">
                    {p.title} <span className="font-mono">{p.prefix}:</span>
                  </h3>
                  <ul className="grid grid-cols-5 gap-1">
                    {p.icons.slice(0, 300).map((i) => (
                      <li key={i.name}>
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => dragBlock(e, `${p.prefix}:${i.name}`)}
                          onClick={() => insert(iconUsage(kind, `${p.prefix}:${i.name}`))}
                          title={`${p.prefix}:${i.name}`}
                          aria-label={`Ícone ${p.prefix}:${i.name}`}
                          className="flex aspect-square w-full items-center justify-center rounded text-fg hover:bg-border/50"
                        >
                          <svg
                            viewBox={`0 0 ${i.width} ${i.height}`}
                            width="18"
                            height="18"
                            aria-hidden
                            dangerouslySetInnerHTML={{ __html: i.svg }}
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <p className="text-muted">Nenhum ícone encontrado.</p>
            )}
          </div>
        </aside>
        <div
          className="min-h-0 border-r border-border"
          onDragOver={(e) => e.dataTransfer.types.includes(BLOCK_MIME) && e.preventDefault()}
          onDropCapture={dropBlock}
        >
          <MermaidSource value={code} onChange={setCode} onSave={() => void save()} handle={handle} />
        </div>
        <section
          className="flex min-h-0 flex-col"
          aria-label="Prévia do diagrama"
          onDragOver={(e) => e.dataTransfer.types.includes(BLOCK_MIME) && e.preventDefault()}
          onDrop={(e) => {
            const text = e.dataTransfer.getData(BLOCK_MIME)
            if (!text) return
            e.preventDefault()
            insert(text)
          }}
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1 text-xs text-muted">
            <span className="flex-1">Prévia ao vivo · clique num nó para achar no código</span>
            <IconButton label="Diminuir o zoom" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>
              <Minus size={12} aria-hidden />
            </IconButton>
            <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <IconButton label="Aumentar o zoom" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>
              <Plus size={12} aria-hidden />
            </IconButton>
            <IconButton label="Zoom 100%" onClick={() => setZoom(1)}>
              <Scan size={12} aria-hidden />
            </IconButton>
          </div>
          {error && (
            <pre
              role="alert"
              className="max-h-32 shrink-0 overflow-auto border-b border-danger/40 bg-danger/10 px-2 py-1 text-xs whitespace-pre-wrap text-danger"
            >
              {error}
            </pre>
          )}
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {preview ? (
              <div
                data-testid="diagram-preview"
                className={cx('mermaid-diagram origin-top-left transition-opacity', error && 'opacity-40')}
                style={{ transform: `scale(${zoom})`, width: `${100 / zoom}%` }}
                onClick={(e) => pickNode(e.target as Element)}
                dangerouslySetInnerHTML={{ __html: preview.svg }}
              />
            ) : (
              <p className="text-xs text-muted">{error ? 'O diagrama ainda não desenha.' : 'Desenhando…'}</p>
            )}
          </div>
        </section>
      </div>
      {dialog.element}
      {target.origin === undefined && !target.buffer && (
        <p className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted">
          <FolderOpen size={12} aria-hidden className="mr-1 inline" />
          Diagrama gerado do projeto ou novo: salve como .mmd para guardar no projeto e usar com {'{{> diagram ...}}'}.
        </p>
      )}
    </div>
  )
}

/** Como um ícone entra no código: nó com ícone no fluxograma, serviço na arquitetura, só o nome no resto. */
function iconUsage(kind: string, icon: string): string {
  const id = icon.split(':')[1]!.replace(/-/g, '_')
  if (kind === 'architecture') return `  service ${id}(${icon})[${id}]`
  if (kind === 'flowchart') return `  ${id}@{ icon: "${icon}", form: "rounded", label: "${id}", pos: "b" }`
  return icon
}

function PaletteIcon({ id, packs }: { id: string; packs: { prefix: string; icons: IconEntry[] }[] }) {
  const [prefix, name] = id.split(':')
  const icon = packs.find((p) => p.prefix === prefix)?.icons.find((i) => i.name === name)
  if (!icon) return null
  return (
    <svg
      viewBox={`0 0 ${icon.width} ${icon.height}`}
      width="14"
      height="14"
      aria-hidden
      className="shrink-0"
      dangerouslySetInnerHTML={{ __html: icon.svg }}
    />
  )
}

function MermaidSource(props: {
  value: string
  onChange(value: string): void
  onSave(): void
  handle: React.MutableRefObject<MermaidEditorHandle | null>
}) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((monaco) => {
        if (disposed || !host.current) return
        props.handle.current = monaco.create(host.current, {
          value: latest.current.value,
          onChange: (v) => latest.current.onChange(v),
          onSave: () => latest.current.onSave()
        })
        setReady(true)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      props.handle.current?.dispose()
      props.handle.current = null
    }
    // O editor é criado uma vez; mudanças de fora chegam pelo handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={host} data-editor={ready ? 'monaco' : 'loading'} className={ready ? 'min-h-0 flex-1' : 'hidden'} />
      {!ready && <CodeEditor value={props.value} onChange={props.onChange} language="text" ariaLabel="Código do diagrama Mermaid" />}
    </div>
  )
}
