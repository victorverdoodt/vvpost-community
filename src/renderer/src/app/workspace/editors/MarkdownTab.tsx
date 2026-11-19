import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ListPlus, Save, Shapes, TriangleAlert } from 'lucide-react'
import type { DocDiagnostic, DocsProjectState } from '@shared/ipc'
import { splitDiagramOrigin } from '@vvpost/core/docs/diagram-origin'
import { Badge, Button, EmptyState, SplitHandle, useContextMenu, useSplit, useToast } from '../../../design-system'
import { MarkdownViewSwitch, useMarkdownView } from '../../../modules/docs/MarkdownView'
import { DiagramEditContext, Markdown } from '../../../design-system/content/Markdown'
import { directiveMenu, previewDirective, type DirectiveContext } from '../../../modules/docs/directives'
import { MarkdownToolbar } from '../../../modules/docs/MarkdownToolbar'
import type { DiagramTarget } from '../../../modules/docs/diagram/DiagramStudio'
import type { DocReferences, DocsEditorHandle, MonacoDocs } from '../../../modules/docs/monaco-docs'
import { sectionLine } from '../../../modules/docs/references'
import { navigate } from '../../../lib/navigate'
import { useWorkspace } from '../../../panels/useWorkspace'
import { filesChanged, openDoc, REVEAL_SECTION, takeSection, type DocTab } from '../docs'
import { sameText, useDiskChange } from '../../../lib/disk-changes'
import { useInlinePreviews, usePreviewSync, type SyncedPreview } from '../../../modules/docs/usePreviewSync'

const DiagramStudio = lazy(() => import('../../../modules/docs/diagram/DiagramStudio'))

let loading: Promise<MonacoDocs> | null = null
/** O Monaco só carrega quando o texto cru aparece. */
const loadMonaco = () => (loading ??= import('../../../modules/docs/monaco-docs').then((m) => m.monacoDocs))

const PREVIEW_MS = 400

/**
 * Aba de um documento .md: documentação viva. A prévia monta as diretivas {{> endpoint ...}},
 * {{> connector ...}}, {{> include ...}} e os diagramas Mermaid com o projeto de agora; o texto cru
 * é o mesmo editor do documento do projeto (barra de formatação, autocomplete das diretivas, prévia do
 * trecho de cada diretiva ao passar o mouse, Ctrl+clique abre o arquivo dela, Ctrl+S salva). Prévia,
 * texto ou os dois lado a lado. O documento do projeto também abre no editor com o PDF.
 */
export default function MarkdownTab(props: { file: string; tab: DocTab }) {
  const ws = useWorkspace()
  const notify = useToast()
  const menu = useContextMenu()
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [project, setProject] = useState<DocsProjectState | null>(null)
  const [view, setView] = useMarkdownView('preview')
  const split = useSplit('markdown.split')
  const row = useRef<HTMLDivElement>(null)
  const [compiled, setCompiled] = useState<(SyncedPreview & { diagnostics: DocDiagnostic[] }) | null>(null)
  const [inline, setInline] = useInlinePreviews()
  const [editorReady, setEditorReady] = useState(0)
  const [diagram, setDiagram] = useState<DiagramTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const editor = useRef<DocsEditorHandle | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ text, saved })
  latest.current = { text, saved }
  // O arquivo mudou no disco com mudanças não salvas aqui: a aba avisa em vez de descartar.
  const [outside, setOutside] = useState(false)
  // Uma mudança em qualquer arquivo (um include, o catálogo) remonta a prévia.
  const [diskTick, setDiskTick] = useState(0)

  const load = useCallback(() => {
    void window.vvpost.readMarkdownFile(props.file).then((r) => {
      if (!r.ok) return setError(r.message)
      setError(null)
      setOutside(false)
      setText(r.value)
      setSaved(r.value)
      editor.current?.setValue(r.value)
    })
  }, [props.file])
  useEffect(load, [load])

  // Gravado fora do app (um agente pelo MCP, outro editor): sem mudanças aqui, a aba relê sozinha.
  useDiskChange(
    (f) => f === props.file,
    () =>
      void window.vvpost.readMarkdownFile(props.file).then((r) => {
        if (!r.ok) return
        const { text: current, saved: before } = latest.current
        if (sameText(r.value, before)) return
        if (current === before) load()
        else setOutside(true)
      })
  )
  // Manter as mudanças desta aba: o disco de agora vira a base, e Salvar grava por cima dele.
  const keepMine = () =>
    void window.vvpost.readMarkdownFile(props.file).then((r) => {
      if (r.ok) setSaved(r.value)
      setOutside(false)
    })
  useDiskChange(
    () => true,
    () => setDiskTick((t) => t + 1)
  )
  const [projectRead, setProjectRead] = useState(false)
  useEffect(() => {
    void window.vvpost.docsProject().then((r) => {
      if (r.ok) setProject(r.value)
      setProjectRead(true)
    })
  }, [])

  const dirty = text !== null && text !== saved
  const { setDirty } = props.tab
  useEffect(() => setDirty(dirty), [dirty, setDirty])

  // Prévia viva: monta o documento com o projeto (sem título, sumário nem capa) depois de uma pausa.
  // Só com o texto, monta igual quando as prévias inline estão ligadas: elas saem dessa montagem.
  const sequence = useRef(0)
  useEffect(() => {
    if (text === null || (view === 'raw' && !inline)) return
    const id = ++sequence.current
    const t = setTimeout(() => {
      void window.vvpost.compileDocs({ config: { source: props.file, toc: false }, source: text }).then((r) => {
        if (id !== sequence.current) return
        if (!r.ok) return setCompiled({ markdown: '', from: text, diagnostics: [{ file: props.file, line: 1, severity: 'error', message: r.message }] })
        setCompiled({ markdown: r.value.printMarkdown, from: text, diagnostics: r.value.diagnostics, ...(r.value.sourceLines && { sourceLines: r.value.sourceLines }) })
      })
    }, compiled ? PREVIEW_MS : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, view, inline, props.file, diskTick])

  const save = useCallback(async () => {
    const { text: current, saved: before } = latest.current
    if (current === null || current === before) return
    setBusy(true)
    const r = await window.vvpost.saveMarkdownFile({ file: props.file, text: current, previous: before })
    setBusy(false)
    if (!r.ok) return notify(`Não foi possível salvar: ${r.message}`, 'danger')
    setSaved(current)
    filesChanged()
    notify(`Salvo em ${r.value.file}`, 'success')
  }, [props.file, notify])

  const context = useMemo<DirectiveContext>(
    () => ({ connectors: ws.workspace?.connectors ?? [], markdownFiles: project?.markdownFiles ?? [], directives: project?.directives ?? [] }),
    [ws.workspace, project]
  )
  const contextRef = useRef(context)
  contextRef.current = context
  const references = useMemo<DocReferences>(() => ({ preview: (d) => previewDirective(props.file, d.text), open: openDoc }), [props.file])
  const referencesRef = useRef(references)
  referencesRef.current = references

  // Ctrl+clique num {{> include arquivo#seção}} de outro documento: o texto abre no título da seção.
  const reveal = useRef<number | null>(null)
  const loaded = text !== null && projectRead
  useEffect(() => {
    if (!loaded) return
    const show = () => {
      const section = takeSection(props.file)
      const current = latest.current.text
      if (!section || current === null) return
      const line = sectionLine(current, section, project?.markdownFiles.find((f) => f.file === props.file)?.sections)
      if (!line) return notify(`A seção "${section}" não está em ${props.file}`, 'warning')
      if (view === 'preview') setView('split')
      if (editor.current) editor.current.revealLine(line)
      else reveal.current = line
    }
    show()
    const onReveal = (e: Event) => (e as CustomEvent<string>).detail === props.file && show()
    window.addEventListener(REVEAL_SECTION, onReveal)
    return () => window.removeEventListener(REVEAL_SECTION, onReveal)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, props.file, view])

  // O Monaco monta quando o texto cru aparece pela primeira vez e fica montado depois.
  const showRaw = view !== 'preview'
  const [rawSeen, setRawSeen] = useState(showRaw)
  useEffect(() => {
    if (showRaw) setRawSeen(true)
  }, [showRaw])
  const ready = text !== null
  useEffect(() => {
    if (!rawSeen || !ready || !host.current || editor.current) return
    let disposed = false
    void loadMonaco().then((monaco) => {
      if (disposed || !host.current) return
      editor.current = monaco.create(host.current, {
        value: latest.current.text ?? '',
        context: () => contextRef.current,
        onChange: setText,
        onSave: () => void save(),
        onCompile: () => undefined,
        references: referencesRef.current
      })
      if (reveal.current) editor.current.revealLine(reveal.current)
      reveal.current = null
      setEditorReady((n) => n + 1)
    })
    return () => {
      disposed = true
      editor.current?.dispose()
      editor.current = null
    }
  }, [rawSeen, ready, save])

  const sync = usePreviewSync({ editor, editorReady, compiled, split: view === 'split' && !diagram, inline })
  /** Duplo clique num bloco da prévia: o texto aparece com o cursor na linha dele. */
  const jumpToSource = (e: React.MouseEvent) => {
    const line = sync.lineAt(e)
    if (!line) return
    if (view === 'preview') setView('split')
    if (editor.current) requestAnimationFrame(() => editor.current?.revealLine(line))
    else reveal.current = line
  }

  const diagnostics = (compiled?.diagnostics ?? []).filter((d) => d.file === props.file)
  useEffect(() => {
    editor.current?.setDiagnostics(diagnostics)
  }, [diagnostics])

  const insert = (snippet: string) => {
    if (view === 'preview') setView('split')
    if (editor.current) editor.current.insertBlock(snippet)
    else setText((t) => `${(t ?? '').replace(/\n*$/, '\n\n')}${snippet}\n`)
  }

  /** Bloco ```mermaid do cursor (ou um novo no cursor) no editor de diagramas, com volta para o texto. */
  const openDiagram = () => {
    const e = editor.current
    const block = e?.mermaidAtCursor()
    setDiagram(
      block
        ? {
            code: block.code,
            label: `Diagrama de ${props.file}`,
            buffer: (code) => {
              const now = editor.current
              if (!now) return
              const lines = now.value().split('\n')
              const at = lines.findIndex((_, i) => lines.slice(i, i + block.to - block.from + 1).join('\n') === block.code)
              if (at >= 0 && block.to >= block.from) now.replaceLines(at + 1, at + 1 + block.to - block.from, code)
              else now.insertBlock(`\`\`\`mermaid\n${code}\n\`\`\``)
            }
          }
        : {
            code: 'flowchart LR\n  inicio([Início]) --> passo[Processo]',
            label: 'Diagrama novo no documento',
            buffer: (code) => insert(`\`\`\`mermaid\n${code}\n\`\`\``)
          }
    )
  }
  // "Editar" num diagrama da prévia: a marca de origem diz onde ele está escrito.
  const editFromPreview = useCallback((raw: string, label: string) => {
    const { origin, code } = splitDiagramOrigin(raw)
    setDiagram(origin ? { code, label: origin.line ? `${label} de ${origin.file}` : origin.file, origin, previous: code } : { code, label })
  }, [])

  if (error) return <EmptyState icon={<TriangleAlert size={20} aria-hidden />} title={`Não foi possível abrir ${props.file}`} description={error} />
  if (text === null) return <EmptyState icon={<BookOpen size={20} aria-hidden />} title={`Abrindo ${props.file}…`} />

  const errors = diagnostics.filter((d) => d.severity === 'error').length
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={`Documento ${props.file}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <span className="min-w-0 truncate font-mono text-muted" title={props.file}>
          {props.file}
        </span>
        {dirty && <Badge tone="warning">não salvo</Badge>}
        {diagnostics.length > 0 && (
          <Badge tone={errors ? 'danger' : 'warning'}>
            {diagnostics.length === 1 ? '1 problema' : `${diagnostics.length} problemas`}
          </Badge>
        )}
        <span className="flex-1" />
        <MarkdownViewSwitch value={view} onChange={setView} previewLabel="Prévia viva" />
        <span className="h-4 w-px bg-border" aria-hidden />
        <Button size="sm" icon={<ListPlus size={14} aria-hidden />} onClick={(e) => menu.open(e.currentTarget, 'Inserir no documento', directiveMenu(context, props.file, insert))}>
          Inserir
        </Button>
        <Button size="sm" icon={<Shapes size={14} aria-hidden />} disabled={view === 'preview'} title="Edita o diagrama Mermaid em que o cursor está, ou cria um novo no cursor" onClick={openDiagram}>
          Diagrama
        </Button>
        {project?.sourceFile === props.file && (
          <Button size="sm" icon={<BookOpen size={14} aria-hidden />} title="O documento do projeto, com o modelo e o PDF ao lado" onClick={() => navigate({ module: 'docs' })}>
            Editor com PDF
          </Button>
        )}
        <Button size="sm" variant="primary" icon={<Save size={14} aria-hidden />} disabled={busy || !dirty} onClick={() => void save()} title="Ctrl+S">
          {busy ? 'Salvando…' : 'Salvar'}
        </Button>
      </div>
      {menu.menu}
      {outside && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border bg-warning/10 px-4 py-1.5 text-xs">
          <TriangleAlert size={14} className="shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 flex-1">
            {props.file} mudou fora do app (um agente pelo MCP ou outro editor) e esta aba tem mudanças não salvas.
          </span>
          <Button size="sm" onClick={load} title="Descarta as mudanças desta aba">
            Recarregar do disco
          </Button>
          <Button size="sm" variant="ghost" onClick={keepMine} title="Salvar grava esta versão por cima da do disco">
            Manter o meu
          </Button>
        </div>
      )}
      {diagram ? (
        <div className="min-h-0 flex-1">
          <Suspense fallback={null}>
            <DiagramStudio
              target={diagram}
              diagramFiles={project?.diagramFiles ?? []}
              onBack={() => setDiagram(null)}
              onSaved={() => {
                filesChanged()
                if (!dirty) load()
              }}
            />
          </Suspense>
        </div>
      ) : (
        <div
          ref={row}
          className="flex min-h-0 flex-1"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
              e.preventDefault()
              void save()
            }
          }}
        >
          <div style={view === 'split' ? { flex: split.flex } : undefined} className={showRaw ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
            <MarkdownToolbar onFormat={(a) => editor.current?.format(a)} inline={{ on: inline, onChange: setInline }} />
            <div ref={host} aria-hidden={!showRaw} className="min-h-0 flex-1" />
          </div>
          {view !== 'raw' && (
            <div className={`relative flex min-h-0 min-w-0 flex-1 ${view === 'split' ? 'border-l border-border' : ''}`}>
              <div
                ref={sync.previewRef}
                className="min-h-0 min-w-0 flex-1 overflow-auto px-6 py-4"
                onClick={view === 'split' ? sync.onPreviewClick : undefined}
                onDoubleClick={jumpToSource}
              >
                <DiagramEditContext.Provider value={editFromPreview}>
                  {compiled ? <Markdown source={compiled.markdown} lines /> : <p className="text-xs text-muted">Montando a prévia…</p>}
                </DiagramEditContext.Provider>
              </div>
              {view === 'split' && <SplitHandle split={split} row={row} edge="left" label="Divisão entre o texto e a prévia" />}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
