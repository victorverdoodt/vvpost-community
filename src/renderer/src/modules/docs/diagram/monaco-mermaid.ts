// Monaco do editor de diagramas: o mesmo núcleo do editor do documento, com uma gramática curta
// de Mermaid (palavras-chave, setas, comentários e textos).
import { monaco } from '../monaco-core'

const LANGUAGE = 'vvpost-mermaid'
if (!monaco.languages.getLanguages().some((l) => l.id === LANGUAGE)) {
  monaco.languages.register({ id: LANGUAGE })
  monaco.languages.setMonarchTokensProvider(LANGUAGE, {
    keywords: [
      'flowchart',
      'graph',
      'subgraph',
      'end',
      'direction',
      'sequenceDiagram',
      'participant',
      'actor',
      'loop',
      'alt',
      'else',
      'opt',
      'par',
      'and',
      'critical',
      'break',
      'rect',
      'note',
      'Note',
      'over',
      'activate',
      'deactivate',
      'classDiagram',
      'class',
      'classDef',
      'style',
      'linkStyle',
      'stateDiagram-v2',
      'stateDiagram',
      'state',
      'erDiagram',
      'gantt',
      'section',
      'title',
      'dateFormat',
      'mindmap',
      'timeline',
      'pie',
      'architecture-beta',
      'group',
      'service',
      'junction',
      'in',
      'C4Context',
      'C4Container',
      'C4Component',
      'C4Dynamic',
      'C4Deployment'
    ],
    tokenizer: {
      root: [
        [/^\s*%%.*$/, 'comment'],
        [/"[^"]*"/, 'string'],
        [/(-{2,}>|-\.->|={2,}>|-{2,}|->>|-->>|-\)|--\)|<\|--|\*--|o--|\|\|--o\{|\}o--\|\||:[LRTB]\s*-->\s*[LRTB]:)/, 'operator'],
        [/[A-Za-z_][\w-]*:[\w-]+/, 'type'],
        [/[A-Z][A-Za-z_]*(?=\()/, 'type'],
        [/[A-Za-z][\w-]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/[[\](){}|]/, 'delimiter']
      ]
    }
  })
}

export interface MermaidEditorHandle {
  value(): string
  setValue(value: string): void
  /** Insere o bloco numa linha própria, abaixo da linha do cursor (ou de onde caiu o arraste). */
  insertBlock(text: string, at?: { x: number; y: number }): void
  /** Seleciona a primeira ocorrência de um id do diagrama (clique num nó da prévia). */
  selectId(id: string): boolean
  focus(): void
  dispose(): void
}

export const monacoMermaid = {
  create(host: HTMLElement, options: { value: string; onChange(value: string): void; onSave(): void }): MermaidEditorHandle {
    const model = monaco.editor.createModel(options.value, LANGUAGE)
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
      folding: false,
      editContext: false,
      glyphMargin: false,
      renderLineHighlight: 'line',
      dragAndDrop: true,
      ariaLabel: 'Código do diagrama Mermaid'
    })
    let external = false
    model.onDidChangeContent(() => !external && options.onChange(model.getValue()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => options.onSave())
    return {
      value: () => model.getValue(),
      setValue(value) {
        external = true
        model.setValue(value)
        external = false
      },
      insertBlock(text, at) {
        const target = at ? editor.getTargetAtClientPoint(at.x, at.y)?.position : editor.getPosition()
        const line = Math.min(target?.lineNumber ?? model.getLineCount(), model.getLineCount())
        const end = model.getLineMaxColumn(line)
        const filled = model.getLineContent(line).trim() !== ''
        const range = new monaco.Range(line, filled ? end : 1, line, end)
        editor.executeEdits('diagram-insert', [{ range, text: filled ? `\n${text}` : text, forceMoveMarkers: true }])
        const last = line + (filled ? 1 : 0) + text.split('\n').length - 1
        editor.setPosition({
          lineNumber: last,
          column: model.getLineMaxColumn(last)
        })
        editor.revealLineInCenterIfOutsideViewport(last)
        editor.focus()
      },
      selectId(id) {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const match = model.findNextMatch(`(?<![\\w-])${escaped}(?![\\w-])`, { lineNumber: 1, column: 1 }, true, true, null, false)
        if (!match) return false
        editor.setSelection(match.range)
        editor.revealRangeInCenterIfOutsideViewport(match.range)
        editor.focus()
        return true
      },
      focus: () => editor.focus(),
      dispose() {
        editor.dispose()
        model.dispose()
      }
    }
  }
}
