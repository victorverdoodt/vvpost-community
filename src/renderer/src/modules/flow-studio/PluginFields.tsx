import { useState, type ReactNode } from 'react'
import type { PluginField } from '@shared/ipc'
import type { KnownOutputs } from './model'
import { TemplateInput } from './TemplateInput'

/**
 * Campo declarado por uma contribuição de plugin (manifesto, fields[]): o mesmo formulário no
 * inspector do Flow Studio e no Quick Request, quando o protocolo é o adapter de um plugin.
 */

const selectClass = 'w-full min-w-0 border px-2 py-1 text-xs disabled:opacity-50'

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  )
}

export function PluginFieldInput({
  field,
  value,
  ancestors,
  outputs,
  onChange
}: {
  field: PluginField
  value: unknown
  ancestors: readonly string[]
  outputs: KnownOutputs
  onChange(value: unknown): void
}) {
  const [jsonText, setJsonText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)))
  const label = `${field.label}${field.required ? ' *' : ''}`
  const hint = field.description
  const input = { ancestors, outputs, label: field.label, placeholder: field.placeholder ?? '' }
  switch (field.type) {
    case 'boolean':
      return (
        <label className="flex items-center gap-2 text-xs text-muted" title={hint}>
          <input
            type="checkbox"
            aria-label={field.label}
            checked={value === undefined ? field.default === true : value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.label}
        </label>
      )
    case 'select':
      return (
        <Field label={label} hint={hint}>
          <select
            aria-label={field.label}
            className={selectClass}
            value={typeof value === 'string' ? value : String(field.default ?? '')}
            onChange={(e) => onChange(e.target.value || undefined)}
          >
            {field.default === undefined && <option value="">—</option>}
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )
    case 'json': {
      let invalid = false
      try {
        if (jsonText.trim()) JSON.parse(jsonText)
      } catch {
        invalid = true
      }
      return (
        <Field label={label} hint={invalid ? <span className="text-danger">JSON inválido</span> : hint}>
          <TemplateInput
            {...input}
            multiline
            rows={4}
            value={jsonText}
            onChange={(text) => {
              setJsonText(text)
              if (!text.trim()) return onChange(undefined)
              try {
                onChange(JSON.parse(text))
              } catch {
                // Só grava quando o JSON fica válido.
              }
            }}
          />
        </Field>
      )
    }
    case 'number':
      return (
        <Field label={label} hint={hint}>
          <TemplateInput
            {...input}
            value={value === undefined ? '' : String(value)}
            onChange={(text) =>
              onChange(!text.trim() ? undefined : /^-?\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : text)
            }
          />
        </Field>
      )
    default: {
      // text, textarea e code. Um script que lê nodes direto recebe a referência em JavaScript.
      const multiline = field.type !== 'text'
      const format = field.templates === false && field.language === 'javascript' ? 'javascript' : 'template'
      return (
        <Field label={label} hint={hint}>
          <TemplateInput
            {...input}
            multiline={multiline}
            rows={field.type === 'code' ? 10 : 4}
            format={format}
            value={typeof value === 'string' ? value : ''}
            onChange={(text) => onChange(text === '' ? undefined : text)}
          />
        </Field>
      )
    }
  }
}
