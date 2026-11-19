import { useEffect } from 'react'
import { ClipboardPaste, Copy, Redo2, Scissors, TextSelect, Undo2 } from 'lucide-react'
import type { EditCommand } from '@shared/ipc'
import { separator, useContextMenu, type ContextMenuEntries } from './ContextMenu'
import { isEditableTarget, Shortcut } from './shortcuts'

const icon = { size: 14, 'aria-hidden': true } as const

/**
 * Desfazer, recortar, copiar, colar e selecionar tudo para um campo de texto. O comando
 * roda no main (webContents), sobre o campo focado: o Electron não mostra o menu nativo.
 */
export function textEditEntries(field: HTMLElement): ContextMenuEntries {
  const input = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null
  const readOnly = !!input && (input.readOnly || input.disabled)
  const selected = input
    ? (input.selectionStart ?? 0) !== (input.selectionEnd ?? 0)
    : !!window.getSelection()?.toString()
  const run = (command: EditCommand) => () => {
    field.focus()
    window.vvpost.editCommand(command)
  }
  return [
    { id: 'undo', label: 'Desfazer', icon: <Undo2 {...icon} />, shortcut: Shortcut.undo, disabled: readOnly, run: run('undo') },
    { id: 'redo', label: 'Refazer', icon: <Redo2 {...icon} />, shortcut: Shortcut.redo, disabled: readOnly, run: run('redo') },
    separator,
    { id: 'cut', label: 'Recortar', icon: <Scissors {...icon} />, shortcut: Shortcut.cut, disabled: readOnly || !selected, run: run('cut') },
    { id: 'copy', label: 'Copiar', icon: <Copy {...icon} />, shortcut: Shortcut.copy, disabled: !selected, run: run('copy') },
    { id: 'paste', label: 'Colar', icon: <ClipboardPaste {...icon} />, shortcut: Shortcut.paste, disabled: readOnly, run: run('paste') },
    separator,
    { id: 'select-all', label: 'Selecionar tudo', icon: <TextSelect {...icon} />, shortcut: Shortcut.selectAll, run: run('selectAll') }
  ]
}

/**
 * Menu de texto do app inteiro: botão direito num campo sem menu próprio, ou num texto
 * selecionado (documentação, resposta), abre Recortar/Copiar/Colar. Montado uma vez no App.
 */
export function TextEditMenu() {
  const ctx = useContextMenu()
  const { open } = ctx
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target && isEditableTarget(target) && !(target instanceof HTMLSelectElement)) {
        e.preventDefault()
        open({ x: e.clientX, y: e.clientY }, 'Edição de texto', textEditEntries(target), target)
        return
      }
      const text = window.getSelection()?.toString()
      if (text) {
        e.preventDefault()
        open({ x: e.clientX, y: e.clientY }, 'Texto selecionado', [
          {
            id: 'copy',
            label: 'Copiar',
            icon: <Copy {...icon} />,
            shortcut: Shortcut.copy,
            run: () => void navigator.clipboard.writeText(text)
          }
        ])
      }
    }
    window.addEventListener('contextmenu', onMenu)
    return () => window.removeEventListener('contextmenu', onMenu)
  }, [open])
  return ctx.menu
}
