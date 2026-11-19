import { File, FolderOpen, X } from 'lucide-react'
import { Button, controlClass, IconButton } from '../../design-system'
import { emptyFormRow, type BodyMode, type FormRow } from './draft'

const icon = { size: 13, 'aria-hidden': true } as const
const fileName = (path: string) => path.split(/[\\/]/).pop() || path

/**
 * Corpo em form (urlencoded ou multipart/form-data, com arquivos) ou binário na aba Body.
 * Os arquivos são escolhidos pelo diálogo do sistema e vão como caminho absoluto: o main lê os
 * bytes no envio, então o renderer nunca carrega o arquivo.
 */
export function FormBodyEditor(props: {
  mode: Exclude<BodyMode, 'raw'>
  rows: FormRow[]
  binaryFile: string
  binaryType: string
  onRows: (rows: FormRow[]) => void
  onBinary: (patch: { binaryFile?: string; binaryType?: string }) => void
}) {
  const pick = () => window.vvpost.pickFile('body')

  if (props.mode === 'binary') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 text-xs">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void pick().then((file) => file && props.onBinary({ binaryFile: file }))}>
            <FolderOpen {...icon} /> {props.binaryFile ? 'Trocar arquivo' : 'Escolher arquivo'}
          </Button>
          {props.binaryFile ? (
            <span className="flex min-w-0 items-center gap-1 font-mono" title={props.binaryFile}>
              <File {...icon} className="shrink-0 text-muted" />
              <span className="truncate">{props.binaryFile}</span>
              <IconButton label="Tirar o arquivo" onClick={() => props.onBinary({ binaryFile: '' })}>
                <X {...icon} />
              </IconButton>
            </span>
          ) : (
            <span className="text-muted">O arquivo inteiro vai como corpo da requisição.</span>
          )}
        </div>
        <label className="flex items-center gap-2">
          <span className="w-28 text-muted">Content-Type</span>
          <input
            className={`${controlClass} w-64 font-mono`}
            placeholder="pela extensão do arquivo"
            value={props.binaryType}
            onChange={(e) => props.onBinary({ binaryType: e.target.value })}
            spellCheck={false}
          />
        </label>
      </div>
    )
  }

  const multipart = props.mode === 'multipart'
  const update = (key: number, patch: Partial<FormRow>) => {
    const next = props.rows.map((r) => (r.key === key ? { ...r, ...patch } : r))
    const last = next.at(-1)
    props.onRows(last && (last.name || last.value || last.file !== undefined) ? [...next, emptyFormRow()] : next)
  }
  const remove = (key: number) => props.onRows(props.rows.filter((r) => r.key !== key))

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div className="flex flex-col gap-1" role="list" aria-label={multipart ? 'Campos do form-data' : 'Campos do form'}>
        {props.rows.map((r) => {
          const isFile = multipart && r.file !== undefined
          const last = r === props.rows.at(-1)
          return (
            <div key={r.key} role="listitem" className="flex items-center gap-2">
              <input type="checkbox" aria-label="Ativar campo" checked={r.enabled} onChange={(e) => update(r.key, { enabled: e.target.checked })} />
              <input
                aria-label="Nome do campo"
                placeholder="Nome"
                className="h-7 w-1/4 border px-2 font-mono text-xs"
                value={r.name}
                onChange={(e) => update(r.key, { name: e.target.value })}
                spellCheck={false}
              />
              {multipart && (
                <select
                  aria-label="Tipo do campo"
                  className={`${controlClass} w-20`}
                  value={isFile ? 'file' : 'text'}
                  onChange={(e) => update(r.key, e.target.value === 'file' ? { file: '', value: '' } : { file: undefined })}
                >
                  <option value="text">Texto</option>
                  <option value="file">Arquivo</option>
                </select>
              )}
              {isFile ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Button size="sm" onClick={() => void pick().then((file) => file && update(r.key, { file }))}>
                    <FolderOpen {...icon} /> {r.file ? 'Trocar' : 'Escolher arquivo'}
                  </Button>
                  {r.file && (
                    <span className="truncate font-mono text-xs" title={r.file}>
                      {fileName(r.file)}
                    </span>
                  )}
                </span>
              ) : !multipart && r.file !== undefined ? (
                <span className="flex-1 text-muted" title={r.file}>
                  Arquivo {r.file ? fileName(r.file) : ''}: só vai no form-data
                </span>
              ) : (
                <input
                  aria-label="Valor do campo"
                  placeholder="Valor"
                  className="h-7 flex-1 border px-2 font-mono text-xs"
                  value={r.value}
                  onChange={(e) => update(r.key, { value: e.target.value })}
                  spellCheck={false}
                />
              )}
              {multipart && (
                <input
                  aria-label="Content-Type do campo"
                  placeholder={isFile ? 'tipo (auto)' : 'tipo'}
                  className="h-7 w-28 border px-2 font-mono text-xs"
                  value={r.contentType ?? ''}
                  onChange={(e) => update(r.key, { contentType: e.target.value || undefined })}
                  spellCheck={false}
                />
              )}
              <IconButton label="Remover campo" disabled={last} onClick={() => remove(r.key)} className="disabled:invisible">
                <X {...icon} />
              </IconButton>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted">
        {multipart
          ? 'Enviado como multipart/form-data; o VVPost gera o boundary. Valores aceitam {{VAR}}.'
          : 'Enviado como application/x-www-form-urlencoded. Valores aceitam {{VAR}}.'}
      </p>
    </div>
  )
}
