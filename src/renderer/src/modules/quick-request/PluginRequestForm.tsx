import type { PluginContribution } from '@shared/ipc'
import { PluginFieldInput } from '../flow-studio/PluginFields'

const NO_OUTPUTS = new Map()

/**
 * Os campos do adapter de um plugin (gRPC, Kafka...) no lugar de params, headers e body.
 * Carregado sob demanda: só quem escolhe um protocolo de plugin paga pelo formulário.
 */
export default function PluginRequestForm({
  contribution,
  config,
  onChange
}: {
  contribution: PluginContribution & { pluginName: string }
  config: Record<string, unknown>
  onChange(config: Record<string, unknown>): void
}) {
  return (
    <div role="group" aria-label={`Campos de ${contribution.title}`} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <p className="text-[11px] text-muted">
        {contribution.description ?? contribution.title} · plugin {contribution.pluginName}. A baseUrl, os headers e a auth do conector escolhido
        valem para o adapter; {'{{VAR}}'} do ambiente só é resolvido quando o plugin envia pelo host.
      </p>
      {contribution.fields.map((field) => (
        <PluginFieldInput
          key={field.key}
          field={field}
          value={Object.hasOwn(config, field.key) ? config[field.key] : undefined}
          ancestors={[]}
          outputs={NO_OUTPUTS}
          onChange={(value) => {
            const { [field.key]: _, ...rest } = config
            onChange(value === undefined ? rest : { ...rest, [field.key]: value })
          }}
        />
      ))}
    </div>
  )
}
