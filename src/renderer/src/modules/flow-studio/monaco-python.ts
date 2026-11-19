// Só o núcleo do editor e a gramática de Python, não o pacote inteiro do Monaco (JSON,
// TypeScript e CSS têm workers e linguagens que o nó Python não usa).
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/python/register'
// As contribuições que um campo de script usa: sugestões, comentário, indentação, múltiplos cursores.
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo'
import 'monaco-editor/editor/contrib/indentation/browser/indentation'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { pythonCompletionsAt, type KnownOutputs } from './model'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

interface Context {
  ancestors: readonly string[]
  outputs: KnownOutputs
}

// Um provider para todos os editores: cada modelo aponta para o contexto do nó dele.
const contexts = new WeakMap<monaco.editor.ITextModel, () => Context>()
monaco.languages.registerCompletionItemProvider('python', {
  triggerCharacters: ['[', "'", '"'],
  provideCompletionItems(model, position) {
    const context = contexts.get(model)?.()
    if (!context) return { suggestions: [] }
    const before = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column
    })
    const found = pythonCompletionsAt(before, context.ancestors, context.outputs)
    if (!found) return { suggestions: [] }
    const range = new monaco.Range(
      position.lineNumber,
      position.column - found.typed.length,
      position.lineNumber,
      position.column
    )
    return {
      suggestions: found.items.map((item, i) => ({
        label: item.label,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: item.insert,
        ...(item.detail && { detail: item.detail }),
        sortText: String(i).padStart(4, '0'),
        range
      }))
    }
  }
})

export interface PythonEditorHandle {
  value(): string
  setValue(value: string): void
  insert(text: string): void
  dispose(): void
}

export const monacoPython = {
  create(
    host: HTMLElement,
    options: { value: string; context: () => Context; onChange(value: string): void; onFocus(): void }
  ): PythonEditorHandle {
    const model = monaco.editor.createModel(options.value, 'python')
    contexts.set(model, options.context)
    const editor = monaco.editor.create(host, {
      model,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      tabSize: 4,
      insertSpaces: true,
      wordWrap: 'on',
      // Sem a fonte de ícones do Monaco (codicons) no pacote: sem ícones nas sugestões e sem dobras.
      suggest: { showIcons: false },
      folding: false,
      // O textarea clássico: com o EditContext do Chromium a digitação automatizada (e2e) não chega ao editor.
      editContext: false,
      glyphMargin: false,
      ariaLabel: 'Script Python'
    })
    let external = false
    model.onDidChangeContent(() => !external && options.onChange(model.getValue()))
    editor.onDidFocusEditorText(options.onFocus)
    return {
      value: () => model.getValue(),
      setValue(value) {
        external = true
        model.setValue(value)
        external = false
      },
      insert(text) {
        const selection = editor.getSelection()
        if (!selection) return
        editor.executeEdits('data-picker', [{ range: selection, text, forceMoveMarkers: true }])
        editor.focus()
      },
      dispose() {
        editor.dispose()
        model.dispose()
      }
    }
  }
}

export type MonacoPython = typeof monacoPython
