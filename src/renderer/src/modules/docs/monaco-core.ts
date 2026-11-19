// O núcleo do Monaco dos editores da documentação (documento e diagramas), com todas as
// contribuições que eles usam: os serviços do Monaco nascem no primeiro editor criado, então
// uma contribuição importada depois (o autocomplete) ficaria sem os serviços dela.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'
import 'monaco-editor/editor/contrib/links/browser/links'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export { monaco }
