import { useState } from 'react'
import { SegmentedControl } from '../../design-system'

/** Como um documento .md aparece, como no VS Code: só a prévia, só o texto ou os dois lado a lado. */
export type MarkdownView = 'preview' | 'raw' | 'split'

const VIEW_KEY = 'vvpost.markdown.view'

/** A visão escolhida, lembrada para todos os editores de .md (a aba do arquivo e o editor com PDF). */
export function useMarkdownView(fallback: MarkdownView): [MarkdownView, (v: MarkdownView) => void] {
  const [view, setView] = useState<MarkdownView>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY)
      return v === 'preview' || v === 'raw' || v === 'split' ? v : fallback
    } catch {
      return fallback
    }
  })
  return [
    view,
    (v) => {
      setView(v)
      try {
        localStorage.setItem(VIEW_KEY, v)
      } catch {
        // Sem armazenamento (janela privada): a escolha vale até fechar a aba.
      }
    }
  ]
}

/** O seletor Prévia | Raw | Lado a lado, no cabeçalho do editor. */
export function MarkdownViewSwitch(props: { value: MarkdownView; onChange: (v: MarkdownView) => void; previewLabel?: string }) {
  return (
    <SegmentedControl
      label="Visualização do documento"
      size="sm"
      value={props.value}
      onChange={props.onChange}
      options={[
        { value: 'preview', label: props.previewLabel ?? 'Prévia', title: 'Só a prévia montada' },
        { value: 'raw', label: 'Raw', title: 'Só o texto, com o autocomplete das diretivas' },
        { value: 'split', label: 'Lado a lado', title: 'O texto e a prévia lado a lado' }
      ]}
    />
  )
}

/** Como a prévia do editor do projeto aparece: a página montada (como em Visualizar) ou o PDF. */
export type PreviewFormat = 'page' | 'pdf'

const FORMAT_KEY = 'vvpost.docs.previewFormat'

export function usePreviewFormat(): [PreviewFormat, (v: PreviewFormat) => void] {
  const [format, setFormat] = useState<PreviewFormat>(() => {
    try {
      return localStorage.getItem(FORMAT_KEY) === 'page' ? 'page' : 'pdf'
    } catch {
      return 'pdf'
    }
  })
  return [
    format,
    (v) => {
      setFormat(v)
      try {
        localStorage.setItem(FORMAT_KEY, v)
      } catch {
        // Sem armazenamento: a escolha vale até fechar a aba.
      }
    }
  ]
}
