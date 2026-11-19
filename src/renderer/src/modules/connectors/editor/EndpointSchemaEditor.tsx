import { useEffect, useState } from 'react'
import type { ConnectorSource, SharedSchemaSource } from '@shared/ipc'
import { Button, ErrorNotice, SchemaBuilder } from '../../../design-system'
import { WORKSPACE_CHANGED } from '../../../panels/useWorkspace'
import { prune } from './fields'

type Schema = Record<string, unknown>

/** O nome do schema compartilhado que o bodySchema inteiro cita ({"$ref": "schema:<nome>"}). */
export function sharedSchemaName(schema: Schema | undefined): string | undefined {
  const ref = schema?.['$ref']
  return typeof ref === 'string' && ref.startsWith('schema:') ? ref.slice('schema:'.length) : undefined
}

/**
 * Editor dos campos do corpo direto na documentação do endpoint: lê o arquivo do conector, troca só
 * o bodySchema daquele endpoint e grava (o mesmo saveConnector do editor do conector). Um corpo que é
 * um schema compartilhado edita o schema (schemas/<nome>.schema.json), que vale para todos os usos.
 */
export function EndpointSchemaEditor(props: { connectorId: string; endpointId: string; onClose: () => void; onSaved: () => void }) {
  const [source, setSource] = useState<ConnectorSource | null>(null)
  const [schema, setSchema] = useState<Schema | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [shared, setShared] = useState<SharedSchemaSource | null>(null)
  useEffect(() => {
    void window.vvpost.readConnector(props.connectorId).then(async (r) => {
      if (!r.ok) return setError(r.message)
      const own = r.value.connector.endpoints?.find((e) => e.id === props.endpointId)?.bodySchema
      const name = sharedSchemaName(own)
      if (name) {
        const s = await window.vvpost.readSharedSchema(name)
        if (!s.ok) return setError(s.message)
        setShared(s.value)
        setSchema(s.value.schema)
      } else setSchema(own)
      setSource(r.value)
    })
  }, [props.connectorId, props.endpointId])

  const endpoint = source?.connector.endpoints?.find((e) => e.id === props.endpointId)
  if (error && !source) return <ErrorNotice compact title="Não deu para abrir o conector" code="CONFIG_ERROR" message={error} />
  if (!source) return null
  if (!endpoint) return <p className="text-xs text-muted">O endpoint não está no arquivo deste conector: edite onde ele foi declarado.</p>

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      if (shared) {
        const r = await window.vvpost.saveSharedSchema(shared.name, schema ?? { type: 'object' }, shared.version)
        if (!r.ok) return setError(r.message)
        window.dispatchEvent(new Event(WORKSPACE_CHANGED))
        props.onSaved()
        return
      }
      const connector = {
        ...source.connector,
        endpoints: source.connector.endpoints!.map((e) => {
          if (e.id !== props.endpointId) return e
          const { bodySchema: _, ...rest } = e
          return schema ? { ...rest, bodySchema: schema } : rest
        })
      }
      const r = await window.vvpost.saveConnector(prune(connector), source.file, source.version)
      if (!r.ok) return setError(r.message)
      // O Quick Request e o Flow Studio releem o catálogo: o formulário tipado já sai com os campos novos.
      window.dispatchEvent(new Event(WORKSPACE_CHANGED))
      props.onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-border-subtle p-2" aria-label={`Editar os campos do corpo de ${endpoint.name}`} role="region">
      {shared && (
        <p className="text-xs text-muted">
          Schema compartilhado <code className="font-mono text-fg">{shared.name}</code> ({shared.file}):{' '}
          {shared.readOnly
            ? `é de ${shared.readOnly} e aqui é só leitura.`
            : `a mudança vale para ${shared.uses.length === 1 ? 'o único uso' : `os ${shared.uses.length} usos`} (${shared.uses.join(', ')}).`}
        </p>
      )}
      <SchemaBuilder value={schema} body={endpoint.body} onChange={setSchema} label={`Campos do corpo de ${endpoint.name}`} />
      {error && <ErrorNotice compact title="Os campos não foram salvos" code="SCHEMA_INVALID" message={error} />}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={saving || !!shared?.readOnly} onClick={() => void save()}>
          Salvar os campos
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
