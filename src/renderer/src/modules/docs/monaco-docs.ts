// Só o núcleo do editor e a gramática de Markdown (monaco-core), como o editor do nó Python.
import { monaco } from './monaco-core'
import { directiveCompletions, type DirectiveContext } from './directives'
import { formatMarkdown, type MarkdownAction } from './markdown-format'
import { directiveAt, directiveTarget, targetLabel, type DirectiveSpan, type DocTarget } from './references'
import { inlinePreviewZones } from './monaco-inline'
import type { InlinePreview } from './source-sync'

const contexts = new WeakMap<monaco.editor.ITextModel, () => DirectiveContext>()

/** O que o editor sabe fazer com o trecho de uma diretiva: mostrar a prévia e abrir o arquivo dele. */
export interface DocReferences {
  /** O trecho montado com o projeto de agora, em Markdown, e os problemas dele. */
  preview(directive: DirectiveSpan): Promise<{ markdown: string; problems: string[] } | null>
  open(target: DocTarget): void
}
const references = new WeakMap<monaco.editor.ITextModel, DocReferences>()
/** O Ctrl+clique chega ao opener sem o editor: vale o último que teve o foco. */
let focused: DocReferences | null = null

const SCHEME = 'vvpost-doc'
/** A prévia na dica corta trechos longos (a referência inteira, um conector grande). */
const HOVER_CHARS = 6000
/** A prévia de uma diretiva vale por alguns segundos: o arquivo dela pode mudar a qualquer hora. */
const HOVER_TTL_MS = 5000

const targetOf = (model: monaco.editor.ITextModel, span: DirectiveSpan): DocTarget | null =>
  directiveTarget(span, contexts.get(model)?.() ?? { connectors: [] })

// Ctrl+clique numa diretiva com arquivo (include, conector, endpoint, request, diagrama) abre esse arquivo.
monaco.languages.registerLinkProvider('markdown', {
  provideLinks(model) {
    if (!references.has(model)) return { links: [] }
    const ctx = contexts.get(model)?.() ?? { connectors: [] }
    const links: monaco.languages.ILink[] = []
    let fence = false
    model.getLinesContent().forEach((line, i) => {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fence = !fence
      const span = !fence && line.includes('{{>') ? directiveAt(line) : null
      const target = span && directiveTarget(span, ctx)
      if (!span || !target) return
      links.push({
        range: new monaco.Range(i + 1, span.startColumn, i + 1, span.endColumn),
        url: monaco.Uri.from({ scheme: SCHEME, path: '/ref', query: JSON.stringify(target) }),
        tooltip: `Abrir ${targetLabel(target, ctx)} (Ctrl+clique)`
      })
    })
    return { links }
  }
})
monaco.editor.registerLinkOpener({
  open(resource) {
    if (resource.scheme !== SCHEME) return false
    try {
      focused?.open(JSON.parse(resource.query) as DocTarget)
    } catch {
      return false
    }
    return true
  }
})

// Passar o mouse numa diretiva mostra o trecho que ela monta: o texto do include, o conector com a herança.
const previews = new WeakMap<monaco.editor.ITextModel, Map<string, { at: number; value: ReturnType<DocReferences['preview']> }>>()
monaco.languages.registerHoverProvider('markdown', {
  async provideHover(model, position) {
    const refs = references.get(model)
    const span = refs ? directiveAt(model.getLineContent(position.lineNumber)) : null
    if (!refs || !span || position.column < span.startColumn || position.column > span.endColumn) return null
    let cache = previews.get(model)
    if (!cache) previews.set(model, (cache = new Map()))
    const hit = cache.get(span.text)
    const value = hit && Date.now() - hit.at < HOVER_TTL_MS ? hit.value : refs.preview(span)
    if (value !== hit?.value) cache.set(span.text, { at: Date.now(), value })
    const result = await value.catch(() => null)
    if (!result) return null
    const target = targetOf(model, span)
    const ctx = contexts.get(model)?.() ?? { connectors: [] }
    let body = result.markdown.trim() || '_A diretiva não monta nenhum texto._'
    if (body.length > HOVER_CHARS) body = `${body.slice(0, body.lastIndexOf('\n', HOVER_CHARS))}\n\n_… o trecho continua._`
    const head = `**Prévia de \`${span.text}\`**${target ? ` · Ctrl+clique abre ${targetLabel(target, ctx)}` : ''}`
    return {
      range: new monaco.Range(position.lineNumber, span.startColumn, position.lineNumber, span.endColumn),
      contents: [
        { value: head },
        ...(result.problems.length ? [{ value: result.problems.map((p) => `⚠ ${p}`).join('\n\n') }] : []),
        { value: body, supportHtml: false }
      ]
    }
  }
})
monaco.languages.registerCompletionItemProvider('markdown', {
  triggerCharacters: ['>', ' ', '/', '#'],
  provideCompletionItems(model, position) {
    const context = contexts.get(model)?.()
    if (!context) return { suggestions: [] }
    const before = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column
    })
    const found = directiveCompletions(before, context)
    if (!found) return { suggestions: [] }
    const range = new monaco.Range(position.lineNumber, position.column - found.typed.length, position.lineNumber, position.column)
    return {
      suggestions: found.items.map((item, i) => ({
        label: item.label,
        kind: monaco.languages.CompletionItemKind.Reference,
        insertText: item.insert,
        ...(item.detail && { detail: item.detail }),
        sortText: String(i).padStart(4, '0'),
        filterText: item.label,
        range
      }))
    }
  }
})

export interface DocsEditorHandle {
  value(): string
  setValue(value: string): void
  /** Insere na posição do cursor, numa linha própria. */
  insertBlock(text: string): void
  revealLine(line: number): void
  /** O bloco ```mermaid em que o cursor está: linhas do conteúdo (sem as cercas) e o código. */
  mermaidAtCursor(): { from: number; to: number; code: string } | null
  /** Troca as linhas from..to (inclusive) pelo texto; from > to insere antes de from. */
  replaceLines(from: number, to: number, text: string): void
  setDiagnostics(list: { line: number; severity: 'error' | 'warning'; message: string }[]): void
  /** As prévias inline das diretivas (o trecho embaixo de cada uma); null tira todas. */
  setInlinePreviews(list: InlinePreview[] | null): void
  /** A linha (fracionária) no topo do editor: a linha 10 pela metade é 10.5. */
  topLine(): number
  /** Rola até deixar a linha (fracionária) no topo, sem mexer no cursor. Devolve a nova rolagem (null: não mudou). */
  scrollToLine(line: number): number | null
  /** atEnd: rolado até o fim (a prévia vai para o fim dela também). */
  onScroll(listener: (topLine: number, atEnd: boolean, scrollTop: number) => void): () => void
  onCursorLine(listener: (line: number) => void): () => void
  /** Mostra e destaca por um instante as linhas from..to (o bloco clicado na prévia), sem tirar o foco. */
  flash(from: number, to: number): void
  /** Uma ação da barra de formatação (negrito, título, lista...) sobre a seleção. */
  format(action: MarkdownAction): void
  focus(): void
  dispose(): void
}

export const monacoDocs = {
  create(
    host: HTMLElement,
    options: {
      value: string
      context: () => DirectiveContext
      onChange(value: string): void
      onSave(): void
      onCompile(): void
      /** Prévia das diretivas ao passar o mouse e Ctrl+clique para abrir o arquivo de cada uma. */
      references?: DocReferences
    }
  ): DocsEditorHandle {
    const model = monaco.editor.createModel(options.value, 'markdown')
    contexts.set(model, options.context)
    if (options.references) references.set(model, options.references)
    const editor = monaco.editor.create(host, {
      model,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
      suggest: { showIcons: false },
      quickSuggestions: { other: true, comments: false, strings: false },
      folding: false,
      editContext: false,
      glyphMargin: false,
      renderLineHighlight: 'line',
      ariaLabel: 'Documento-fonte em Markdown'
    })
    if (options.references) {
      const refs = options.references
      focused ??= refs
      editor.onDidFocusEditorText(() => (focused = refs))
    }
    const inline = inlinePreviewZones(editor, {
      canOpen(line) {
        const span = options.references && directiveAt(model.getLineContent(line))
        const target = span && targetOf(model, span)
        return target ? targetLabel(target, options.context()) : null
      },
      open(line) {
        const span = directiveAt(model.getLineContent(line))
        const target = span && targetOf(model, span)
        if (target) options.references?.open(target)
      }
    })
  const topLine = () => {
      const top = editor.getScrollTop()
      const first = editor.getVisibleRanges()[0]?.startLineNumber ?? 1
      // A linha do topo e a altura dela com a prévia inline de baixo: rolar pela prévia de um
      // include anda dentro dele, como do lado da prévia.
      let line = first
      while (line < model.getLineCount() && editor.getTopForLineNumber(line + 1) <= top) line++
      const a = editor.getTopForLineNumber(line)
      const b = line < model.getLineCount() ? editor.getTopForLineNumber(line + 1) : a + editor.getOption(monaco.editor.EditorOption.lineHeight)
      return line + (b > a ? Math.max(0, Math.min(1, (top - a) / (b - a))) : 0)
    }
    let flashed: string[] = []
    let flashTimer: ReturnType<typeof setTimeout> | undefined
    let external = false
    model.onDidChangeContent(() => !external && options.onChange(model.getValue()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => options.onSave())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => options.onCompile())
    const format = (action: MarkdownAction) => {
      const sel = editor.getSelection()
      if (!sel) return
      const e = formatMarkdown(model.getValue(), model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition()), action)
      const a = model.getPositionAt(e.from)
      const b = model.getPositionAt(e.to)
      editor.pushUndoStop()
      editor.executeEdits('docs-format', [{ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: e.insert, forceMoveMarkers: true }])
      editor.pushUndoStop()
      const s = model.getPositionAt(e.selection[0])
      const t = model.getPositionAt(e.selection[1])
      editor.setSelection(new monaco.Selection(s.lineNumber, s.column, t.lineNumber, t.column))
      editor.revealPosition(t)
      editor.focus()
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => format('bold'))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => format('italic'))
    return {
      value: () => model.getValue(),
      setValue(value) {
        external = true
        model.setValue(value)
        external = false
      },
      insertBlock(text) {
        const pos = editor.getPosition()
        if (!pos) return
        const filled = model.getLineContent(pos.lineNumber).trim() !== ''
        const end = model.getLineMaxColumn(pos.lineNumber)
        // Numa linha com texto, a diretiva vai para baixo dela; numa vazia, no lugar dela.
        const range = new monaco.Range(pos.lineNumber, filled ? end : 1, pos.lineNumber, end)
        editor.executeEdits('docs-insert', [{ range, text: filled ? `\n\n${text}\n` : `${text}\n`, forceMoveMarkers: true }])
        // O que entrou fica à vista, mesmo no fim de um documento mais alto que o editor.
        const at = editor.getPosition()
        if (at) editor.revealPosition(at)
        editor.focus()
      },
      mermaidAtCursor() {
        const pos = editor.getPosition()
        if (!pos) return null
        const lines = model.getLinesContent()
        let open = -1
        let fence = ''
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (open < 0) {
            const m = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line)
            if (!m) continue
            if (m[2]!.toLowerCase() === 'mermaid') {
              open = i
              fence = m[1]!
            } else {
              // Outro bloco de código: pula até a cerca que fecha.
              const close = lines.findIndex((l, j) => j > i && new RegExp(`^\\s{0,3}${m[1]![0] === '`' ? '`' : '~'}{${m[1]!.length},}\\s*$`).test(l))
              if (close < 0) return null
              i = close
            }
            continue
          }
          if (new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) {
            // Linhas do Monaco começam em 1: o conteúdo vai de open+2 até i.
            if (pos.lineNumber >= open + 1 && pos.lineNumber <= i + 1) return { from: open + 2, to: i, code: lines.slice(open + 1, i).join('\n') }
            open = -1
          }
        }
        return null
      },
      replaceLines(from, to, text) {
        const range =
          from > to
            ? new monaco.Range(from, 1, from, 1)
            : new monaco.Range(from, 1, to, model.getLineMaxColumn(to))
        editor.executeEdits('docs-diagram', [{ range, text: from > to ? `${text}\n` : text, forceMoveMarkers: true }])
        editor.revealLineInCenter(from)
        editor.focus()
      },
      revealLine(line) {
        editor.revealLineInCenter(line)
        editor.setPosition({ lineNumber: line, column: 1 })
        editor.focus()
      },
      setDiagnostics(list) {
        monaco.editor.setModelMarkers(
          model,
          'vvpost-docs',
          list.map((d) => ({
            startLineNumber: d.line,
            endLineNumber: d.line,
            startColumn: 1,
            endColumn: model.getLineMaxColumn(Math.min(Math.max(1, d.line), model.getLineCount())),
            severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
            message: d.message
          }))
        )
      },
      setInlinePreviews: (list) => inline.set(list),
      topLine,
      scrollToLine(line) {
        const before = editor.getScrollTop()
        if (line > model.getLineCount()) editor.setScrollTop(editor.getScrollHeight())
        else {
          const n = Math.max(1, Math.floor(line))
          const a = editor.getTopForLineNumber(n)
          const b = n < model.getLineCount() ? editor.getTopForLineNumber(n + 1) : a
          editor.setScrollTop(a + (line - n) * (b - a))
        }
        const after = editor.getScrollTop()
        return after !== before ? after : null
      },
      onScroll(listener) {
        const d = editor.onDidScrollChange(
          (e) => e.scrollTopChanged && listener(topLine(), e.scrollTop > 0 && e.scrollTop + editor.getLayoutInfo().height >= e.scrollHeight - 2, e.scrollTop)
        )
        return () => d.dispose()
      },
      onCursorLine(listener) {
        const d = editor.onDidChangeCursorPosition((e) => listener(e.position.lineNumber))
        return () => d.dispose()
      },
      flash(from, to) {
        const last = Math.min(Math.max(from, to), model.getLineCount())
        editor.revealLinesInCenterIfOutsideViewport(from, last, monaco.editor.ScrollType.Smooth)
        flashed = model.deltaDecorations(flashed, [
          { range: new monaco.Range(from, 1, last, 1), options: { isWholeLine: true, className: 'doc-source-flash', linesDecorationsClassName: 'doc-source-flash-bar' } }
        ])
        clearTimeout(flashTimer)
        flashTimer = setTimeout(() => (flashed = model.deltaDecorations(flashed, [])), 1500)
      },
      format,
      focus: () => editor.focus(),
      dispose() {
        if (focused === options.references) focused = null
        clearTimeout(flashTimer)
        inline.dispose()
        editor.dispose()
        model.dispose()
      }
    }
  }
}

export type MonacoDocs = typeof monacoDocs
