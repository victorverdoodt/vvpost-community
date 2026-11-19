import { useContext, useEffect, useRef, useState } from 'react'
import type { KnownOutputs } from './model'
import { PickTargetContext, TemplateInput } from './TemplateInput'
import type { MonacoPython, PythonEditorHandle } from './monaco-python'

interface Props {
  value: string
  onChange(value: string): void
  ancestors: readonly string[]
  outputs: KnownOutputs
}

let loading: Promise<MonacoPython> | null = null
/** O Monaco (alguns MB) só carrega quando um nó Python é aberto no inspector. */
const loadMonaco = () => (loading ??= import('./monaco-python').then((m) => m.monacoPython))

/**
 * Editor do script do nó Python: Monaco com realce de Python e autocomplete de nodes['Nome'],
 * carregado sob demanda. Enquanto carrega (ou se falhar), o campo de texto com o mesmo
 * autocomplete fica no lugar. Focado, é o destino do Visual Data Picker.
 */
export function PythonEditor({ value, onChange, ancestors, outputs }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const setTarget = useContext(PickTargetContext)
  const editor = useRef<PythonEditorHandle | null>(null)
  // O autocomplete e o onChange leem a versão mais recente sem recriar o editor.
  const latest = useRef({ ancestors, outputs, onChange })
  latest.current = { ancestors, outputs, onChange }

  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((monaco) => {
        if (disposed || !host.current) return
        editor.current = monaco.create(host.current, {
          value,
          context: () => latest.current,
          onChange: (code) => latest.current.onChange(code),
          onFocus: () =>
            setTarget({ format: 'python', label: 'Script Python', insert: (text) => editor.current?.insert(text) })
        })
        setReady(true)
      })
      .catch(() => !disposed && setFailed(true))
    return () => {
      disposed = true
      editor.current?.dispose()
      editor.current = null
    }
    // O editor é criado uma vez por nó (o inspector remonta com key={node.id}).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mudança de fora (renomear um nó troca nodes['Antigo'] no script): leva para o editor.
  useEffect(() => {
    if (editor.current && editor.current.value() !== value) editor.current.setValue(value)
  }, [value])

  return (
    <>
      <div
        ref={host}
        role="group"
        aria-label="Editor do script Python"
        data-editor={ready ? 'monaco' : 'loading'}
        className={ready ? 'h-60 overflow-hidden rounded border border-border' : 'hidden'}
      />
      {!ready && (
        <>
          <TemplateInput
            label="Script Python"
            format="python"
            multiline
            rows={10}
            value={value}
            ancestors={ancestors}
            outputs={outputs}
            onChange={onChange}
          />
          {failed && (
            <p className="text-xs text-warning">
              O editor completo não carregou; o campo de texto continua editando o script.
            </p>
          )}
        </>
      )}
    </>
  )
}
