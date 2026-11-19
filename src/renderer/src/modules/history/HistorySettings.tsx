import { useEffect, useState } from 'react'
import { Save, Trash2 } from 'lucide-react'
import type { HistoryLevel, HistorySettings, HistoryStats } from '@shared/ipc'
import { Button, controlClass, cx, formatBytes, SegmentedControl, useToast } from '../../design-system'

export const LEVEL_LABEL: Record<HistoryLevel, string> = {
  off: 'Desligado',
  metadata: 'Metadados',
  headers: 'Headers',
  full: 'Completo'
}

const LEVEL_HINT: Record<HistoryLevel, string> = {
  off: 'Nada é gravado.',
  metadata: 'Método, URL como digitada, status, tempos, auth usada e asserções. Sem headers nem corpos.',
  headers: 'Mais os headers do modelo, a URL e os headers enviados (resolvidos) e os da resposta, e os logs.',
  full: 'Mais os corpos enviados e recebidos e os valores de $nodes: dá para reproduzir qualquer requisição.'
}

const SOURCES = [
  { key: 'request', label: 'Quick Request' },
  { key: 'scenarios', label: 'Cenários de teste' },
  { key: 'flow', label: 'Flow Studio' }
] as const

const NUMBERS = [
  { key: 'maxRuns', label: 'Execuções guardadas', unit: '', min: 10, max: 100000 },
  { key: 'maxAgeDays', label: 'Idade máxima', unit: 'dias (0: sem limite)', min: 0, max: 3650 },
  { key: 'maxBodyKB', label: 'Corpo por requisição', unit: 'KB', min: 1, max: 10240 },
  { key: 'maxSizeMB', label: 'Tamanho total', unit: 'MB', min: 1, max: 10240 }
] as const

/**
 * Configuração do histórico: o nível de riqueza de cada origem e os limites de retenção. Os
 * segredos são mascarados em qualquer nível; reproduzir resolve {{VAR}} de novo no envio.
 */
export function HistorySettingsView(props: { onChanged: () => void }) {
  const notify = useToast()
  const [saved, setSaved] = useState<HistorySettings | null>(null)
  const [draft, setDraft] = useState<HistorySettings | null>(null)
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const loadStats = () => void window.vvpost.getHistoryStats().then(setStats)
  useEffect(() => {
    void window.vvpost.getHistorySettings().then((s) => {
      setSaved(s)
      setDraft(s)
    })
    loadStats()
  }, [])

  if (!draft || !saved) return null
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  const save = async () => {
    const s = await window.vvpost.setHistorySettings(draft)
    setSaved(s)
    setDraft(s)
    loadStats()
    props.onChanged()
    notify('Configuração do histórico salva.', 'success')
  }

  const clear = async () => {
    if (!confirmClear) return setConfirmClear(true)
    await window.vvpost.clearHistory()
    setConfirmClear(false)
    loadStats()
    props.onChanged()
    notify('Histórico apagado.', 'success')
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex max-w-3xl flex-col gap-6">
        <section aria-labelledby="history-levels">
          <h2 id="history-levels" className="text-[13px] font-semibold">Nível de riqueza por origem</h2>
          <p className="mt-1 text-xs text-muted">
            Credenciais nunca vão em claro para o banco: headers, query e campos de nome sensível viram{' '}
            <span className="font-mono">__REQUIRED_SECRET__</span> no modelo, e o que foi enviado e recebido passa pelo
            Secret Sanitizer. Reproduzir resolve as {'{{VAR}}'} e a auth de novo.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {SOURCES.map((src) => {
              const level = draft.levels[src.key]
              return (
                <div key={src.key} className="grid grid-cols-[10rem_auto_1fr] items-center gap-3">
                  <span className="text-xs">{src.label}</span>
                  <SegmentedControl<HistoryLevel>
                    label={`Nível do histórico: ${src.label}`}
                    value={level}
                    onChange={(v) => setDraft({ ...draft, levels: { ...draft.levels, [src.key]: v } })}
                    options={(['off', 'metadata', 'headers', 'full'] as const).map((l) => ({ value: l, label: LEVEL_LABEL[l], title: LEVEL_HINT[l] }))}
                  />
                  <span className="text-xs text-muted">{LEVEL_HINT[level]}</span>
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-xs text-muted">
            O CLI grava só com <span className="font-mono">vvpost run --history metadata|headers|full</span>, no mesmo banco
            (ou em <span className="font-mono">--history-db</span>).
          </p>
        </section>

        <section aria-labelledby="history-retention">
          <h2 id="history-retention" className="text-[13px] font-semibold">Retenção</h2>
          <p className="mt-1 text-xs text-muted">Passou de um limite, as execuções mais antigas saem.</p>
          <div className="mt-3 grid grid-cols-[10rem_8rem_1fr] items-center gap-x-3 gap-y-2">
            {NUMBERS.map((n) => (
              <label key={n.key} className="contents">
                <span className="text-xs">{n.label}</span>
                <input
                  type="number"
                  min={n.min}
                  max={n.max}
                  value={draft[n.key]}
                  onChange={(e) => setDraft({ ...draft, [n.key]: Number(e.target.value) })}
                  className={cx(controlClass, 'font-mono')}
                />
                <span className="text-xs text-muted">{n.unit}</span>
              </label>
            ))}
          </div>
        </section>

        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" icon={<Save size={14} aria-hidden />} disabled={!dirty} onClick={() => void save()}>
            Salvar
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              Descartar
            </Button>
          )}
        </div>

        <section aria-labelledby="history-usage" className="border-t border-border-subtle pt-4">
          <h2 id="history-usage" className="text-[13px] font-semibold">Uso</h2>
          {stats && (
            <p className="mt-1 font-mono text-xs text-muted" role="status">
              {stats.runs} execuções · {stats.exchanges} requisições · {formatBytes(stats.bytes)} guardados ·{' '}
              {formatBytes(stats.fileBytes)} no disco
            </p>
          )}
          <Button className="mt-3" size="sm" variant="danger" icon={<Trash2 size={14} aria-hidden />} onClick={() => void clear()}>
            {confirmClear ? 'Confirmar: apagar todo o histórico' : 'Apagar todo o histórico'}
          </Button>
        </section>
      </div>
    </div>
  )
}
