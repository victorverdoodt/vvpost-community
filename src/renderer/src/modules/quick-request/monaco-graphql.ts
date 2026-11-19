// Só o núcleo do Monaco e um realce próprio de GraphQL (o Monaco não traz a linguagem), com
// o autocomplete pelo schema da introspecção. Carregado quando o corpo GraphQL é aberto.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { graphqlCompletionsAt, type GqlSchema } from './graphql'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

const LANG = 'graphql'
monaco.languages.register({ id: LANG })
monaco.languages.setLanguageConfiguration(LANG, {
  comments: { lineComment: '#' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] }
  ]
})
monaco.languages.setMonarchTokensProvider(LANG, {
  keywords: ['query', 'mutation', 'subscription', 'fragment', 'on', 'true', 'false', 'null'],
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/"""/, 'string', '@block'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/\$[_A-Za-z][_0-9A-Za-z]*/, 'variable'],
      [/@[_A-Za-z][_0-9A-Za-z]*/, 'annotation'],
      [/[_A-Za-z][_0-9A-Za-z]*(?=\s*:)/, 'attribute.name'],
      [/[_A-Za-z][_0-9A-Za-z]*/, { cases: { '@keywords': 'keyword', '[A-Z]\\w*': 'type', '@default': 'identifier' } }],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      [/\.\.\.|[:!=|&]/, 'delimiter']
    ],
    block: [
      [/"""/, 'string', '@pop'],
      [/./, 'string']
    ]
  }
})

// Um provider para todos os editores: cada modelo aponta para o schema da aba dele.
const schemas = new WeakMap<monaco.editor.ITextModel, () => GqlSchema | null>()
monaco.languages.registerCompletionItemProvider(LANG, {
  triggerCharacters: ['{', '(', ' ', '\n'],
  provideCompletionItems(model, position) {
    const schema = schemas.get(model)?.()
    if (!schema) return { suggestions: [] }
    const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column })
    const found = graphqlCompletionsAt(before, schema)
    const range = new monaco.Range(position.lineNumber, position.column - found.typed.length, position.lineNumber, position.column)
    const Kind = monaco.languages.CompletionItemKind
    return {
      suggestions: found.items.map((item, i) => ({
        label: item.label,
        kind: item.kind === 'field' ? Kind.Field : item.kind === 'argument' ? Kind.Property : item.kind === 'type' ? Kind.Class : Kind.Keyword,
        insertText: item.selection ? `${item.label} {\n\t$0\n}` : item.kind === 'argument' ? `${item.label}: ` : item.label,
        ...(item.selection && { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }),
        ...(item.detail && { detail: item.detail }),
        ...(item.documentation && { documentation: item.documentation }),
        sortText: String(i).padStart(4, '0'),
        range
      }))
    }
  }
})

export interface GraphqlEditorHandle {
  value(): string
  setValue(value: string): void
  insert(text: string): void
  dispose(): void
}

export const monacoGraphql = {
  create(
    host: HTMLElement,
    options: { value: string; schema: () => GqlSchema | null; onChange(value: string): void; onRun(): void }
  ): GraphqlEditorHandle {
    const model = monaco.editor.createModel(options.value, LANG)
    schemas.set(model, options.schema)
    const editor = monaco.editor.create(host, {
      model,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
      suggest: { showIcons: false },
      folding: false,
      // O textarea clássico: com o EditContext do Chromium a digitação automatizada (e2e) não chega ao editor.
      editContext: false,
      glyphMargin: false,
      ariaLabel: 'Consulta GraphQL'
    })
    // Ctrl+Enter envia, como no resto do Quick Request.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, options.onRun)
    let external = false
    model.onDidChangeContent(() => !external && options.onChange(model.getValue()))
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
        editor.executeEdits('graphql-explorer', [{ range: selection, text, forceMoveMarkers: true }])
        editor.focus()
      },
      dispose() {
        editor.dispose()
        model.dispose()
      }
    }
  }
}

export type MonacoGraphql = typeof monacoGraphql
