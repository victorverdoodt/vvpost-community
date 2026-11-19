import type { ReactNode } from 'react'
import {
  Bold,
  Code,
  Eye,
  EyeOff,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  SquareCode,
  Strikethrough,
  Table
} from 'lucide-react'
import { IconButton } from '../../design-system'
import type { MarkdownAction } from './markdown-format'

const GROUPS: [MarkdownAction, string, ReactNode][][] = [
  [
    ['h1', 'Título 1', <Heading1 size={14} aria-hidden />],
    ['h2', 'Título 2', <Heading2 size={14} aria-hidden />],
    ['h3', 'Título 3', <Heading3 size={14} aria-hidden />]
  ],
  [
    ['bold', 'Negrito (Ctrl+B)', <Bold size={14} aria-hidden />],
    ['italic', 'Itálico (Ctrl+I)', <Italic size={14} aria-hidden />],
    ['strike', 'Riscado', <Strikethrough size={14} aria-hidden />],
    ['code', 'Código no texto', <Code size={14} aria-hidden />],
    ['link', 'Link', <Link size={14} aria-hidden />]
  ],
  [
    ['bullet', 'Lista', <List size={14} aria-hidden />],
    ['numbered', 'Lista numerada', <ListOrdered size={14} aria-hidden />],
    ['task', 'Lista de tarefas', <ListChecks size={14} aria-hidden />],
    ['quote', 'Citação', <Quote size={14} aria-hidden />]
  ],
  [
    ['codeblock', 'Bloco de código', <SquareCode size={14} aria-hidden />],
    ['table', 'Tabela', <Table size={14} aria-hidden />],
    ['rule', 'Linha horizontal', <Minus size={14} aria-hidden />]
  ]
]

/**
 * A barra do editor de Markdown simplificado: títulos, ênfase, listas, citação, código, tabela e
 * link sobre a seleção do texto, sem precisar lembrar a sintaxe. O clique não tira o foco do editor.
 */
export function MarkdownToolbar(props: {
  onFormat(action: MarkdownAction): void
  disabled?: boolean
  children?: ReactNode
  /** O botão das prévias inline: o trecho de cada diretiva embaixo dela, no próprio texto. */
  inline?: { on: boolean; onChange(on: boolean): void }
}) {
  return (
    <div
      role="toolbar"
      aria-label="Formatação do Markdown"
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border-subtle bg-panel px-2 py-0.5"
      onMouseDown={(e) => e.preventDefault()}
    >
      {GROUPS.map((group, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 && <span className="mx-1 h-4 w-px bg-border" aria-hidden />}
          {group.map(([action, label, icon]) => (
            <IconButton key={action} label={label} disabled={props.disabled} onClick={() => props.onFormat(action)}>
              {icon}
            </IconButton>
          ))}
        </span>
      ))}
      {props.children}
      {props.inline && (
        <>
          <span className="flex-1" />
          <IconButton
            label={props.inline.on ? 'Esconder as prévias das diretivas no texto' : 'Mostrar no texto o trecho que cada diretiva monta'}
            aria-pressed={props.inline.on}
            active={props.inline.on}
            onClick={() => props.inline!.onChange(!props.inline!.on)}
          >
            {props.inline.on ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
          </IconButton>
        </>
      )}
    </div>
  )
}
