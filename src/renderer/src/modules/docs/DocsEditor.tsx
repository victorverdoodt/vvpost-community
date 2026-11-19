import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, CircleAlert, FileDown, Hammer, LayoutTemplate, ListPlus, Save, Shapes, TriangleAlert } from 'lucide-react'
import type { DocsBand, DocsCompileResult, DocsConfig, DocsProjectState, DocsSaveResult } from '@shared/ipc'
import {
  Badge,
  Button,
  CodeEditor,
  controlClass,
  cx,
  EmptyState,
  menuHeader,
  SegmentedControl,
  separator,
  SplitHandle,
  useContextMenu,
  useSplit,
  usePromptDialog,
  useToast,
  type ContextMenuEntries
} from '../../design-system'
import { MarkdownViewSwitch, useMarkdownView, usePreviewFormat } from './MarkdownView'
import { Markdown, markdownToPrintHtml } from '../../design-system/content/Markdown'
import { MarkdownToolbar } from './MarkdownToolbar'
import { headingLine } from './markdown-format'
import { useWorkspace } from '../../panels/useWorkspace'
import { directiveMenu, previewDirective, type DirectiveContext } from './directives'
import type { DiagramTarget } from './diagram/DiagramStudio'
import type { DocReferences, DocsEditorHandle, MonacoDocs } from './monaco-docs'
import { openDoc } from '../../app/workspace/docs'
import { useInlinePreviews, usePreviewSync } from './usePreviewSync'

const PdfView = lazy(() => import('../../design-system/response/PdfView'))

let loading: Promise<MonacoDocs> | null = null
/** O Monaco só carrega quando o editor de documentação abre. */
const loadMonaco = () => (loading ??= import('./monaco-docs').then((m) => m.monacoDocs))

/** Espera depois da última tecla antes de recompilar sozinho. */
const AUTO_COMPILE_MS = 1200

type Pane = 'source' | 'template'
type Status = { kind: 'idle' } | { kind: 'compiling' } | { kind: 'error'; message: string }

/**
 * Editor da documentação do projeto, no espírito do Overleaf: o documento-fonte em Markdown à
 * esquerda, com a barra de formatação do editor simplificado (títulos, ênfase, listas, tabela,
 * link) e os trechos gerados {{> endpoint ...}}, {{> connector ...}}, {{> map}} e de outras docs
 * {{> include arquivo#seção}}; à direita, a prévia como página (a mesma da visualização, rápida
 * ao digitar) ou como o PDF no formato do modelo do projeto (logo, capa, cabeçalho, rodapé,
 * cores, página); embaixo, o log com os problemas por linha. Compila sozinho depois de uma pausa
 * na digitação, ou com Ctrl+Enter; Ctrl+S salva o vvpost.docs.json e o documento-fonte, que vão
 * para o Git com o resto do projeto.
 */
export default function DocsEditor(props: {
  onOpenDiagram?(target: DiagramTarget): void
  /** Gravou o documento: a visualização monta de novo. */
  onSaved?(): void
  /** Muda quando outro lugar grava os arquivos da documentação (o editor de diagramas). */
  externalChange?: number
  /** Muda quando a pessoa pede o estilo da documentação de fora do editor: abre o painel Estilo. */
  showStyle?: number
}) {
  const ws = useWorkspace()
  const notify = useToast()
  const menu = useContextMenu()
  const dialog = usePromptDialog()
  const [project, setProject] = useState<DocsProjectState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [config, setConfig] = useState<DocsConfig>({})
  const [source, setSource] = useState('')
  const [saved, setSaved] = useState<{ config: string; source: string } | null>(null)
  const [pane, setPane] = useState<Pane>(props.showStyle ? 'template' : 'source')
  const [view, setView] = useMarkdownView('split')
  const [format, setFormatState] = usePreviewFormat()
  const formatRef = useRef(format)
  formatRef.current = format
  const split = useSplit('docs.split')
  const row = useRef<HTMLDivElement>(null)
  // from: o texto que foi montado, para as prévias inline acharem as diretivas dele.
  const [compiled, setCompiled] = useState<(DocsCompileResult & { from: string }) | null>(null)
  const [pdf, setPdf] = useState<Uint8Array | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [auto, setAuto] = useState(true)
  const [busy, setBusy] = useState<'save' | 'pdf' | 'md' | null>(null)
  const sequence = useRef(0)

  const load = useCallback(() => {
    void window.vvpost.docsProject().then((r) => {
      if (!r.ok) {
        setLoadError(r.message)
        return
      }
      const text = r.value.source ?? r.value.starter
      setProject(r.value)
      setConfig(r.value.config)
      setSource(text)
      // Sem arquivo ainda, o rascunho de partida conta como não salvo.
      setSaved(r.value.source === null ? { config: '', source: '' } : { config: JSON.stringify(r.value.config), source: text })
    })
  }, [])
  useEffect(load, [load])

  const dirty = saved !== null && (saved.source !== source || saved.config !== JSON.stringify(config))

  // O editor de diagramas gravou no projeto: sem mudanças aqui, relê; com, avisa em vez de perder.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const firstChange = useRef(props.externalChange)
  useEffect(() => {
    if (props.externalChange === firstChange.current) return
    if (dirtyRef.current) notify('Um diagrama foi salvo nos arquivos do projeto; o texto aberto aqui tem mudanças e não foi relido', 'warning')
    else load()
  }, [props.externalChange, load, notify])

  const firstStyle = useRef(props.showStyle)
  useEffect(() => {
    if (props.showStyle !== firstStyle.current) setPane('template')
  }, [props.showStyle])

  const compile = useCallback(async (draft: { config: DocsConfig; source: string }) => {
    const id = ++sequence.current
    setStatus({ kind: 'compiling' })
    const result = await window.vvpost.compileDocs(draft)
    if (id !== sequence.current) return
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.message })
      return
    }
    setCompiled({ ...result.value, from: draft.source })
    // Na prévia como página, o PDF (Chromium imprimindo) só sai quando a pessoa volta para ele.
    if (formatRef.current !== 'pdf') {
      setStatus({ kind: 'idle' })
      return
    }
    try {
      const html = await markdownToPrintHtml(result.value.printMarkdown)
      const preview = await window.vvpost.previewDocsPdf(draft.config, result.value.title, html)
      if (id !== sequence.current) return
      if (!preview.ok) {
        setStatus({ kind: 'error', message: preview.message })
        return
      }
      setPdf(preview.value)
      setStatus({ kind: 'idle' })
    } catch (err) {
      if (id === sequence.current) setStatus({ kind: 'error', message: (err as Error).message })
    }
  }, [])

  // Compila ao abrir e, com a compilação automática, depois de cada pausa na digitação.
  const latest = useRef({ config, source })
  latest.current = { config, source }
  const onSaved = useRef(props.onSaved)
  onSaved.current = props.onSaved
  const compileNow = useCallback(() => void compile(latest.current), [compile])
  const setFormat = (next: typeof format) => {
    formatRef.current = next
    setFormatState(next)
    // O PDF pode estar atrás do texto: monta de novo ao voltar para ele.
    if (next === 'pdf') compileNow()
  }
  const first = useRef(true)
  useEffect(() => {
    if (!project) return
    if (first.current) {
      first.current = false
      compileNow()
      return
    }
    if (!auto) return
    const t = setTimeout(compileNow, AUTO_COMPILE_MS)
    return () => clearTimeout(t)
  }, [project, config, source, auto, compileNow])

  const save = useCallback(async (): Promise<boolean> => {
    setBusy('save')
    const { config: c, source: s } = latest.current
    const r = await window.vvpost.saveDocsProject({ config: c, source: s })
    setBusy(null)
    if (!r.ok) {
      notify(`Não foi possível salvar: ${r.message}`, 'danger')
      return false
    }
    setSaved({ config: JSON.stringify(c), source: s })
    notify(`Salvo em ${r.value.files.join(' e ')}`, 'success')
    onSaved.current?.()
    return true
  }, [notify])

  const done = (r: DocsSaveResult, what: string) => {
    if (r.ok) notify(`${what} salva em ${r.path}`, 'success')
    else if (r.reason === 'error') notify(`Não foi possível salvar: ${r.message}`, 'danger')
  }
  // Exportar grava antes: o PDF e o .md saem do que está no projeto, como no CLI e no MCP.
  const exportPdf = async () => {
    if (dirty && !(await save())) return
    setBusy('pdf')
    try {
      const r = await window.vvpost.compileDocs(latest.current)
      if (!r.ok) throw new Error(r.message)
      const html = await markdownToPrintHtml(r.value.printMarkdown)
      done(await window.vvpost.saveDocsPdf(r.value.title, html, true), 'Documentação em PDF')
    } catch (err) {
      notify(`Não foi possível gerar o PDF: ${(err as Error).message}`, 'danger')
    } finally {
      setBusy(null)
    }
  }
  const exportMarkdown = async () => {
    if (dirty && !(await save())) return
    setBusy('md')
    done(await window.vvpost.saveDocsMarkdown({ kind: 'project' }), 'Documentação em Markdown')
    setBusy(null)
  }

  // Ctrl+S e Ctrl+Enter também fora do Monaco (no formulário do modelo).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    if (e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      compileNow()
    }
  }

  const editor = useRef<DocsEditorHandle | null>(null)
  const context = useMemo<DirectiveContext>(
    () => ({
      connectors: ws.workspace?.connectors ?? [],
      markdownFiles: project?.markdownFiles ?? [],
      directives: project?.directives ?? []
    }),
    [ws.workspace, project]
  )

  const [inline, setInline] = useInlinePreviews()
  const [editorReady, setEditorReady] = useState(0)
  const syncedPreview = useMemo(
    () => (compiled ? { markdown: compiled.printMarkdown, from: compiled.from, ...(compiled.sourceLines && { sourceLines: compiled.sourceLines }) } : null),
    [compiled]
  )
  const sync = usePreviewSync({ editor, editorReady, compiled: syncedPreview, split: view === 'split' && pane === 'source', inline })

  /** Duplo clique num bloco da prévia: o cursor vai para a linha dele (um trecho montado, para a diretiva). */
  const jumpToSource = (e: React.MouseEvent) => {
    let line = sync.lineAt(e)
    if (!line) {
      // Sem o mapa das linhas (montagem antiga): o título pelo texto.
      const h = (e.target as HTMLElement).closest('h1, h2, h3, h4, h5, h6')
      if (!h) return
      const title = [...h.childNodes].filter((n) => !(n instanceof HTMLButtonElement)).map((n) => n.textContent).join('')
      line = headingLine(latest.current.source, title)
      if (!line) return notify('Esse trecho é gerado pela montagem (sumário), não vem do texto', 'info')
    }
    setPane('source')
    if (view === 'preview') setView('split')
    // O Monaco aparece no próximo quadro quando a prévia estava sozinha.
    const at = line
    requestAnimationFrame(() => editor.current?.revealLine(at))
  }

  const insert = (text: string) => {
    setPane('source')
    // Inserir mostra o texto: da prévia só, passa a lado a lado.
    if (view === 'preview') setView('split')
    if (editor.current) editor.current.insertBlock(text)
    else setSource((s) => `${s.replace(/\n*$/, '\n\n')}${text}\n`)
  }
  /** Abre o bloco ```mermaid do cursor no editor de diagramas, ou um diagrama novo que entra no cursor. */
  const openDiagram = () => {
    const e = editor.current
    if (!props.onOpenDiagram || !e) return
    const block = e.mermaidAtCursor()
    if (block) {
      props.onOpenDiagram({
        code: block.code,
        label: `Diagrama de ${sourceFile}`,
        buffer: (code) => {
          // O bloco pode ter mudado de linha enquanto o diagrama estava aberto: acha de novo pelo código.
          const now = editor.current
          if (!now) return
          const lines = now.value().split('\n')
          const at = lines.findIndex((_, i) => lines.slice(i, i + block.to - block.from + 1).join('\n') === block.code)
          if (at >= 0 && block.to >= block.from) now.replaceLines(at + 1, at + 1 + block.to - block.from, code)
          else now.insertBlock(`\`\`\`mermaid\n${code}\n\`\`\``)
        }
      })
      return
    }
    props.onOpenDiagram({
      code: 'flowchart LR\n  inicio([Início]) --> passo[Processo]',
      label: 'Diagrama novo no documento',
      buffer: (code) => editor.current?.insertBlock(`\`\`\`mermaid\n${code}\n\`\`\``)
    })
  }
  const insertEntries = (): ContextMenuEntries =>
    directiveMenu({ ...context, connectors: ws.workspace?.connectors ?? [] }, project?.sourceFile ?? '', insert)

  const pickTemplate = async (t: DocsProjectState['templates'][number]) => {
    const ok = await dialog.confirm({
      title: `Usar o modelo "${t.name}"?`,
      message: `${t.description} O texto e o formato do documento são trocados pelos do modelo; título, organização, versão, logo e o arquivo da fonte ficam. Dá para desfazer com Ctrl+Z no editor até salvar.`,
      confirmLabel: 'Usar o modelo'
    })
    if (!ok) return
    const r = await window.vvpost.applyDocsTemplate(t.id, latest.current.config)
    if (!r.ok) {
      notify(`Não foi possível usar o modelo: ${r.message}`, 'danger')
      return
    }
    setConfig(r.value.config)
    setSource(r.value.source)
    setPane('source')
    notify(`Modelo "${t.name}" aplicado; salve para gravar no projeto`, 'success')
  }
  const saveAsTemplate = async (origin: 'project' | 'user') => {
    const name = await dialog.prompt({
      title: origin === 'project' ? 'Salvar como modelo do projeto' : 'Salvar como meu modelo',
      message:
        origin === 'project'
          ? 'Vai para docs/templates/ e para o Git: o time inteiro passa a ver o modelo.'
          : 'Fica neste computador e aparece em todos os seus projetos.',
      label: 'Nome do modelo',
      initial: config.title ?? '',
      validate: (v) => (v.trim() ? undefined : 'Dê um nome ao modelo')
    })
    if (!name) return
    const { config: c, source: s } = latest.current
    const r = await window.vvpost.saveDocsTemplate({ name, origin, config: c, source: s })
    if (!r.ok) {
      notify(`Não foi possível salvar o modelo: ${r.message}`, 'danger')
      return
    }
    notify(`Modelo "${r.value.name}" salvo${r.value.file ? ` em ${r.value.file}` : ''}`, 'success')
    void window.vvpost.docsProject().then((p) => p.ok && setProject(p.value))
  }
  const templateEntries = (): ContextMenuEntries => {
    const all = project?.templates ?? []
    const group = (origin: string, title: string): ContextMenuEntries => {
      const list = all.filter((t) => t.origin === origin)
      return list.length ? [menuHeader(title), ...list.map((t) => ({ id: t.id, label: t.name, run: () => void pickTemplate(t) }))] : []
    }
    return [
      ...group('builtin', 'Metodologias'),
      ...group('project', 'Do projeto'),
      ...group('user', 'Meus modelos'),
      separator,
      { id: 'save-project', label: 'Salvar como modelo do projeto…', run: () => void saveAsTemplate('project') },
      { id: 'save-user', label: 'Salvar como meu modelo…', run: () => void saveAsTemplate('user') }
    ]
  }

  const diagnostics = compiled?.diagnostics ?? []
  const sourceFile = config.source || project?.sourceFile || 'docs/projeto.md'
  const sourceRef = useRef(sourceFile)
  sourceRef.current = sourceFile
  const references = useMemo<DocReferences>(() => ({ preview: (d) => previewDirective(sourceRef.current, d.text), open: openDoc }), [])
  useEffect(() => {
    editor.current?.setDiagnostics(diagnostics.filter((d) => d.file === sourceFile))
  }, [diagnostics, sourceFile])

  if (loadError) return <EmptyState icon={<TriangleAlert size={20} aria-hidden />} title="Não foi possível abrir a documentação do projeto" description={loadError} />
  if (!project) return <EmptyState icon={<BookOpen size={20} aria-hidden />} title="Abrindo a documentação do projeto…" />

  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.length - errors

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Editor da documentação do projeto" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <SegmentedControl
          label="Painel do editor"
          size="xs"
          value={pane}
          onChange={setPane}
          options={[
            { value: 'source', label: 'Documento' },
            { value: 'template', label: 'Estilo' }
          ]}
        />
        <span className="min-w-0 truncate font-mono text-muted" title={sourceFile}>
          {sourceFile}
        </span>
        {dirty && <Badge tone="warning">{saved?.source === '' ? 'novo, não salvo' : 'não salvo'}</Badge>}
        <Button
          size="sm"
          icon={<ListPlus size={14} aria-hidden />}
          onClick={(e) => menu.open(e.currentTarget, 'Inserir na documentação', insertEntries())}
        >
          Inserir
        </Button>
        <Button
          size="sm"
          icon={<LayoutTemplate size={14} aria-hidden />}
          onClick={(e) => menu.open(e.currentTarget, 'Modelos de documentação', templateEntries())}
        >
          Modelos
        </Button>
        {props.onOpenDiagram && (
          <Button
            size="sm"
            icon={<Shapes size={14} aria-hidden />}
            title="Edita o diagrama Mermaid em que o cursor está, ou cria um novo no cursor"
            disabled={pane !== 'source' || view === 'preview'}
            onClick={openDiagram}
          >
            Diagrama
          </Button>
        )}
        <span className="flex-1" />
        <MarkdownViewSwitch value={view} onChange={setView} />
        <span className="h-4 w-px bg-border" aria-hidden />
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Compilar ao digitar
        </label>
        <Button size="sm" icon={<Hammer size={14} aria-hidden />} onClick={compileNow} title="Ctrl+Enter">
          {status.kind === 'compiling' ? 'Compilando…' : 'Compilar'}
        </Button>
        <Button size="sm" icon={<Save size={14} aria-hidden />} disabled={!!busy || !dirty} onClick={() => void save()} title="Ctrl+S">
          {busy === 'save' ? 'Salvando…' : 'Salvar'}
        </Button>
        <Button size="sm" icon={<FileDown size={14} aria-hidden />} disabled={!!busy} onClick={() => void exportMarkdown()}>
          {busy === 'md' ? 'Salvando…' : 'Exportar .md'}
        </Button>
        <Button size="sm" variant="primary" icon={<FileDown size={14} aria-hidden />} disabled={!!busy} onClick={() => void exportPdf()}>
          {busy === 'pdf' ? 'Gerando PDF…' : 'Exportar PDF'}
        </Button>
      </div>
      {project.configIssues.length > 0 && (
        <p role="alert" className="shrink-0 border-b border-border-subtle bg-warning/10 px-4 py-1.5 text-xs text-warning">
          {project.configIssues.map((i) => `${i.file}: ${i.message}`).join(' · ')}
        </p>
      )}
      <div ref={row} className="flex min-h-0 flex-1">
        <div
          style={view === 'split' ? { flex: split.flex } : undefined}
          className={cx('relative flex min-w-0 flex-1 flex-col border-r border-border', view === 'preview' && 'hidden')}
        >
          {view === 'split' && <SplitHandle split={split} row={row} label="Divisão entre o editor e a prévia" />}
          <div className={cx('flex min-h-0 flex-1 flex-col', pane !== 'source' && 'hidden')}>
            <MarkdownToolbar onFormat={(a) => editor.current?.format(a)} inline={{ on: inline, onChange: setInline }} />
            <SourceEditor
              onReady={() => setEditorReady((n) => n + 1)}
              value={source}
              onChange={setSource}
              context={context}
              onSave={() => void save()}
              onCompile={compileNow}
              handle={editor}
              references={references}
            />
          </div>
          {pane === 'template' && (
            <TemplateForm
              config={config}
              onChange={setConfig}
              project={project}
              onPickMethodology={(anchor) => menu.open(anchor, 'Modelos de documentação', templateEntries())}
            />
          )}
          <DiagnosticsLog
            diagnostics={diagnostics}
            status={status}
            errors={errors}
            warnings={warnings}
            onJump={(d) => {
              if (d.file !== sourceFile) return
              setPane('source')
              editor.current?.revealLine(d.line)
            }}
            sourceFile={sourceFile}
          />
        </div>
        <div className={cx('flex min-w-0 flex-1 flex-col', view === 'raw' && 'hidden')}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-panel px-3 py-1 text-xs">
            <SegmentedControl
              label="Formato da prévia"
              size="xs"
              value={format}
              onChange={setFormat}
              options={[
                { value: 'page', label: 'Página', title: 'O documento como na visualização: atualiza rápido enquanto você digita' },
                { value: 'pdf', label: 'PDF', title: 'O PDF de verdade, com capa, cabeçalho, rodapé e quebras de página' }
              ]}
            />
            {format === 'page' && <span className="truncate text-faint">Clique num trecho mostra o texto dele; duplo clique põe o cursor lá</span>}
          </div>
          {format === 'page' ? (
            <div
              ref={sync.previewRef}
              className="min-h-0 flex-1 overflow-auto bg-surface px-6 py-4"
              role="region"
              aria-label="Prévia do documento"
              onClick={view === 'split' ? sync.onPreviewClick : undefined}
              onDoubleClick={jumpToSource}
              style={accentStyle(config.theme?.primary)}
            >
              {compiled ? (
                <Markdown source={compiled.printMarkdown} lines className="doc-composed mx-auto max-w-[860px]" />
              ) : (
                <p className="text-xs text-muted">{status.kind === 'error' ? `A compilação falhou: ${status.message}` : 'Montando a prévia…'}</p>
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col" aria-label="Prévia em PDF" role="region">
              {pdf ? (
                <Suspense fallback={null}>
                  <PdfView bytes={pdf} keepPages />
                </Suspense>
              ) : (
                <EmptyState
                  icon={<Hammer size={20} aria-hidden />}
                  title={status.kind === 'error' ? 'A compilação falhou' : 'Compilando a prévia…'}
                  {...(status.kind === 'error' && { description: status.message })}
                />
              )}
            </div>
          )}
        </div>
      </div>
      {menu.menu}
      {dialog.element}
    </section>
  )
}

function SourceEditor(props: {
  onReady(): void
  value: string
  onChange(value: string): void
  context: DirectiveContext
  onSave(): void
  onCompile(): void
  handle: React.MutableRefObject<DocsEditorHandle | null>
  references: DocReferences
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
          context: () => latest.current.context,
          onChange: (v) => latest.current.onChange(v),
          onSave: () => latest.current.onSave(),
          onCompile: () => latest.current.onCompile(),
          references: latest.current.references
        })
        setReady(true)
        latest.current.onReady()
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      props.handle.current?.dispose()
      props.handle.current = null
    }
    // O editor é criado uma vez; mudanças de fora chegam pelo efeito abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = props.handle.current
    if (editor && editor.value() !== props.value) editor.setValue(props.value)
  }, [props.value, props.handle])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={host} data-editor={ready ? 'monaco' : 'loading'} className={ready ? 'min-h-0 flex-1' : 'hidden'} />
      {!ready && (
        <CodeEditor value={props.value} onChange={props.onChange} language="text" ariaLabel="Documento-fonte em Markdown" />
      )}
    </div>
  )
}

function DiagnosticsLog(props: {
  diagnostics: DocsCompileResult['diagnostics']
  status: Status
  errors: number
  warnings: number
  sourceFile: string
  onJump(d: DocsCompileResult['diagnostics'][number]): void
}) {
  const { diagnostics, status } = props
  return (
    <div className="max-h-44 shrink-0 overflow-auto border-t border-border text-xs" role="log" aria-label="Log da compilação">
      <div className="sticky top-0 flex items-center gap-2 border-b border-border-subtle bg-panel px-3 py-1 text-muted">
        <span className="font-medium text-fg">Log</span>
        {props.errors > 0 && <Badge tone="danger">{props.errors} erro(s)</Badge>}
        {props.warnings > 0 && <Badge tone="warning">{props.warnings} aviso(s)</Badge>}
        {status.kind === 'error' && <span className="text-danger">{status.message}</span>}
        {status.kind === 'compiling' && <span>compilando…</span>}
        {status.kind === 'idle' && !diagnostics.length && <span>sem problemas</span>}
      </div>
      {diagnostics.length > 0 && (
        <ul className="flex flex-col py-1">
          {diagnostics.map((d, i) => (
            <li key={i}>
              <button
                type="button"
                className="flex w-full items-start gap-2 px-3 py-0.5 text-left hover:bg-elevated disabled:cursor-default"
                disabled={d.file !== props.sourceFile}
                onClick={() => props.onJump(d)}
              >
                {d.severity === 'error' ? (
                  <CircleAlert size={13} className="mt-0.5 shrink-0 text-danger" aria-label="Erro" />
                ) : (
                  <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warning" aria-label="Aviso" />
                )}
                <span className="shrink-0 font-mono text-muted">
                  {d.file}:{d.line}
                </span>
                <span className="min-w-0">{d.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A cor de destaque do modelo nos títulos da prévia como página, como na visualização. */
function accentStyle(primary: string | undefined): React.CSSProperties | undefined {
  return primary && /^#[0-9A-Fa-f]{6}$/.test(primary) ? ({ '--doc-accent': primary } as React.CSSProperties) : undefined
}

const PLACEHOLDERS = '{{title}}, {{subtitle}}, {{project}}, {{version}}, {{organization}}, {{date}}, {{page}}, {{pages}}'

/** O vvpost.docs.json num formulário: o formato que a documentação do projeto inteira segue. */
function TemplateForm({
  config,
  onChange,
  project,
  onPickMethodology
}: {
  config: DocsConfig
  onChange(c: DocsConfig): void
  project: DocsProjectState
  onPickMethodology(anchor: HTMLElement): void
}) {
  const set = <K extends keyof DocsConfig>(key: K, value: DocsConfig[K] | '' | undefined) => {
    const next = { ...config }
    if (value === undefined || value === '') delete next[key]
    else next[key] = value as DocsConfig[K]
    onChange(next)
  }
  const nested = <K extends 'theme' | 'page' | 'header' | 'footer'>(key: K, field: string, value: string | undefined) => {
    const inner: Record<string, unknown> = { ...(config[key] ?? {}) }
    if (value === undefined || value === '') delete inner[field]
    else inner[field] = value
    set(key, (Object.keys(inner).length ? inner : undefined) as DocsConfig[K])
  }
  const text = (label: string, value: string | undefined, onValue: (v: string) => void, placeholder?: string) => (
    <label className="grid grid-cols-[8rem_1fr] items-center gap-2">
      <span className="text-muted">{label}</span>
      <input aria-label={label} className={controlClass} value={value ?? ''} placeholder={placeholder} onChange={(e) => onValue(e.target.value)} />
    </label>
  )
  const select = (label: string, value: string, options: [string, string][], onValue: (v: string) => void) => (
    <label className="grid grid-cols-[8rem_1fr] items-center gap-2">
      <span className="text-muted">{label}</span>
      <select aria-label={label} className={controlClass} value={value} onChange={(e) => onValue(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
  const color = (label: string, field: 'primary' | 'heading' | 'text', fallback: string) => (
    <label className="grid grid-cols-[8rem_auto_1fr] items-center gap-2">
      <span className="text-muted">{label}</span>
      <input
        type="color"
        aria-label={label}
        className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
        value={config.theme?.[field] ?? fallback}
        onChange={(e) => nested('theme', field, e.target.value)}
      />
      {config.theme?.[field] ? (
        <button type="button" className="justify-self-start text-muted underline" onClick={() => nested('theme', field, undefined)}>
          usar o padrão
        </button>
      ) : (
        <span className="text-faint">padrão</span>
      )}
    </label>
  )
  const check = (label: string, value: boolean, onValue: (v: boolean) => void) => (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={value} onChange={(e) => onValue(e.target.checked)} />
      {label}
    </label>
  )
  const band = (key: 'header' | 'footer', title: string, defaults?: DocsBand) => {
    const value = config[key] ?? defaults ?? {}
    // Sem rodapé no arquivo vale o padrão (título e página); editar grava o rodapé inteiro.
    const edit = (field: keyof DocsBand, v: string) => set(key, cleanBand({ ...value, [field]: v }))
    return (
      <Group title={title}>
        {text('Esquerda', value.left, (v) => edit('left', v))}
        {text('Centro', value.center, (v) => edit('center', v))}
        {text('Direita', value.right, (v) => edit('right', v))}
        {select('Logo', value.logo ?? 'none', [['none', 'sem logo'], ['left', 'à esquerda'], ['right', 'à direita']], (v) => edit('logo', v))}
      </Group>
    )
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 text-xs" aria-label="Estilo da documentação" onSubmit={(e) => e.preventDefault()}>
      <p className="text-muted">
        O estilo fica em <code>vvpost.docs.json</code> e vale para a documentação do projeto e para o PDF de qualquer conector,
        endpoint ou request. Nos textos do cabeçalho e do rodapé: <code>{PLACEHOLDERS}</code>.
      </p>
      <Group title="Metodologia">
        <div className="grid grid-cols-[8rem_1fr_auto] items-center gap-2">
          <span className="text-muted">Em uso</span>
          <span className={config.methodology ? 'font-medium' : 'text-faint'}>{config.methodology ?? 'nenhuma escolhida (texto livre)'}</span>
          <Button size="sm" icon={<LayoutTemplate size={14} aria-hidden />} onClick={(e) => onPickMethodology(e.currentTarget)}>
            {config.methodology ? 'Trocar…' : 'Escolher…'}
          </Button>
        </div>
        <p className="text-faint">C4, arc42, Diátaxis, ADR, o Guia da API ou um modelo do time: troca o texto e o formato do documento e mantém título, organização, versão e logo.</p>
      </Group>
      <Group title="Documento">
        {text('Título', config.title, (v) => set('title', v), 'Documentação de <projeto>')}
        {text('Subtítulo', config.subtitle, (v) => set('subtitle', v))}
        {text('Organização', config.organization, (v) => set('organization', v))}
        {text('Versão', config.version, (v) => set('version', v))}
        {select(
          'Logo',
          config.logo ?? '',
          [['', 'sem logo'], ...project.imageFiles.map((f): [string, string] => [f, f])],
          (v) => set('logo', v)
        )}
        {project.imageFiles.length === 0 && <p className="text-faint">Ponha um PNG, JPEG, SVG ou WebP no projeto (ex.: docs/logo.svg) para usar como logo.</p>}
        {text('Documento-fonte', config.source, (v) => set('source', v), project.sourceFile)}
        <div className="flex flex-wrap gap-4">
          {check('Capa', config.cover !== false, (v) => set('cover', v ? undefined : false))}
          {check('Sumário', config.toc !== false, (v) => set('toc', v ? undefined : false))}
          {check('Numerar as seções', config.numberHeadings === true, (v) => set('numberHeadings', v || undefined))}
        </div>
      </Group>
      <Group title="Estilo">
        {color('Cor de destaque', 'primary', '#8b7cff')}
        {color('Cor dos títulos', 'heading', '#11141a')}
        {color('Cor do texto', 'text', '#1d2230')}
        {select('Fonte do texto', config.theme?.font ?? 'sans', FONT_OPTIONS, (v) => nested('theme', 'font', v === 'sans' ? undefined : v))}
        {select('Fonte dos títulos', config.theme?.headingFont ?? '', [['', 'a do texto'], ...FONT_OPTIONS], (v) => nested('theme', 'headingFont', v))}
      </Group>
      <Group title="Página">
        {select('Tamanho', config.page?.size ?? 'A4', [['A4', 'A4'], ['Letter', 'Carta'], ['Legal', 'Ofício']], (v) => nested('page', 'size', v === 'A4' ? undefined : v))}
        {select('Orientação', config.page?.orientation ?? 'portrait', [['portrait', 'retrato'], ['landscape', 'paisagem']], (v) =>
          nested('page', 'orientation', v === 'portrait' ? undefined : v)
        )}
        {select('Margens', config.page?.margins ?? 'normal', [['narrow', 'estreitas'], ['normal', 'normais'], ['wide', 'largas']], (v) =>
          nested('page', 'margins', v === 'normal' ? undefined : v)
        )}
      </Group>
      {band('header', 'Cabeçalho')}
      {band('footer', 'Rodapé', { left: '{{title}}', right: '{{page}} / {{pages}}' })}
    </form>
  )
}

const FONT_OPTIONS: [string, string][] = [
  ['sans', 'sem serifa'],
  ['serif', 'com serifa'],
  ['mono', 'monoespaçada']
]

function cleanBand(band: DocsBand): DocsBand {
  const out: DocsBand = {}
  if (band.left) out.left = band.left
  if (band.center) out.center = band.center
  if (band.right) out.right = band.right
  if (band.logo && band.logo !== 'none') out.logo = band.logo
  return out
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-border-subtle p-3">
      <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</legend>
      {children}
    </fieldset>
  )
}
