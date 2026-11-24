import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Palette, Save, ScanSearch, TriangleAlert } from 'lucide-react'
import type { BrandFileView, BrandItem, BrandTokenView } from '@shared/ipc'
import { Badge, Button, CodeEditor, EmptyState, SegmentedControl, useToast } from '../../../design-system'
import { sameText, useDiskChange } from '../../../lib/disk-changes'
import { filesChanged, type DocTab } from '../docs'

const BASE = 'base'
type View = 'tokens' | 'json'

/** Só #rrggbb(aa) vai para o style: a amostra nunca leva outro texto do arquivo. */
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i

/**
 * Aba de um arquivo de tokens da marca (brand/*.tokens.json, docs/brand.md): os tokens por grupo
 * com a amostra da cor no modo escolhido, os pares de contraste, os problemas do arquivo e, sob
 * pedido, o código do frontend conferido contra eles. A visão JSON edita o arquivo (Ctrl+S salva).
 */
export default function BrandTab(props: { file: string; tab: DocTab }) {
  const notify = useToast()
  const [brand, setBrand] = useState<BrandFileView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('tokens')
  const [mode, setMode] = useState(BASE)
  const [text, setText] = useState('')
  const [outside, setOutside] = useState(false)
  const [findings, setFindings] = useState<{ items: BrandItem[]; scanned: number } | null>(null)
  const [scanning, setScanning] = useState(false)
  const latest = useRef({ text, saved: '' })
  latest.current = { text, saved: brand?.text ?? '' }
  const { setDirty } = props.tab

  const load = useCallback(() => {
    void window.vvpost.readBrandFile(props.file).then((r) => {
      if (!r.ok) return setError(r.message)
      setError(null)
      setOutside(false)
      setBrand(r.value)
      setText(r.value.text)
      // Os achados do código eram do arquivo anterior: conferir de novo.
      setFindings(null)
    })
  }, [props.file])
  useEffect(load, [load])

  const dirty = !!brand && !sameText(text, brand.text)
  useEffect(() => setDirty(dirty), [dirty, setDirty])

  // Gravado fora do app (um agente pelo MCP, outro editor): sem mudanças aqui, a aba relê sozinha.
  const tail = props.file.replace(/^(\.\.\/)+/, '')
  useDiskChange(
    (f) => f === props.file || f.endsWith(tail),
    () =>
      void window.vvpost.readBrandFile(props.file).then((r) => {
        if (!r.ok) return
        const { text: current, saved } = latest.current
        if (sameText(r.value.text, saved)) return
        if (sameText(current, saved)) load()
        else setOutside(true)
      })
  )

  const save = async () => {
    if (!brand || !dirty) return
    const r = await window.vvpost.saveBrandFile({ file: props.file, text, previous: brand.text })
    if (!r.ok) return notify(`Não foi possível salvar: ${r.message}`, 'danger')
    notify(`Salvo em ${r.value.file}`, 'success')
    filesChanged()
    load()
  }

  const scan = async () => {
    setScanning(true)
    const r = await window.vvpost.brandFindings()
    setScanning(false)
    if (!r.ok) return notify(`Não foi possível conferir o código: ${r.message}`, 'danger')
    setFindings(r.value)
  }

  if (error) return <EmptyState icon={<TriangleAlert size={20} aria-hidden />} title={`Não foi possível abrir ${props.file}`} description={error} />
  if (!brand) return <EmptyState icon={<Palette size={20} aria-hidden />} title={`Abrindo ${props.file}…`} />

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={`Tokens da marca ${props.file}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <Palette size={14} className="text-accent" aria-hidden />
        <span className="font-medium">{brand.name}</span>
        <span className="text-faint">{brand.tokens.length} tokens</span>
        <div className="flex-1" />
        {view === 'tokens' && brand.modes.length > 1 && (
          <SegmentedControl label="Modo" size="xs" value={mode} onChange={setMode} options={brand.modes.map((m) => ({ value: m, label: m === BASE ? 'padrão' : m }))} />
        )}
        <SegmentedControl<View>
          label="Visão"
          size="xs"
          value={view}
          onChange={setView}
          options={[
            { value: 'tokens', label: 'Tokens' },
            { value: 'json', label: 'JSON' }
          ]}
        />
        <Button size="sm" variant="primary" icon={<Save size={14} aria-hidden />} disabled={!dirty} onClick={() => void save()}>
          Salvar
        </Button>
      </div>
      {outside && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border bg-warning/10 px-4 py-1.5 text-xs">
          <TriangleAlert size={14} className="shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 flex-1">{props.file} mudou fora do app e a aba tem mudanças não salvas.</span>
          <Button size="sm" onClick={load} title="Descarta as mudanças da aba">
            Recarregar do disco
          </Button>
        </div>
      )}
      {view === 'json' ? (
        <div
          className="min-h-0 flex-1 p-3"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
              e.preventDefault()
              void save()
            }
          }}
        >
          <CodeEditor value={text} onChange={setText} language="json" ariaLabel={`JSON de ${props.file}`} validate className="h-full" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4 text-xs">
          {dirty && <p className="text-warning">A visão mostra o arquivo salvo; salve o JSON para ver as mudanças aqui.</p>}
          <Problems items={brand.problems.filter((p) => p.code === 'tokens-invalid')} />
          <Tokens tokens={brand.tokens} mode={mode} />
          <Contrast brand={brand} mode={mode} />
          <Code brand={brand} findings={findings} scanning={scanning} onScan={() => void scan()} />
        </div>
      )}
    </div>
  )
}

function Problems({ items }: { items: BrandItem[] }) {
  if (!items.length) return null
  return (
    <section aria-label="Problemas do arquivo" className="space-y-1">
      <h3 className="font-medium text-danger">Problemas do arquivo ({items.length})</h3>
      <ul className="space-y-0.5">
        {items.map((p, i) => (
          <li key={i}>
            {p.line ? <span className="mr-1 font-mono text-faint">linha {p.line}</span> : null}
            {p.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Tokens({ tokens, mode }: { tokens: BrandTokenView[]; mode: string }) {
  const groups = useMemo(() => {
    const map = new Map<string, BrandTokenView[]>()
    for (const t of tokens) {
      const g = t.name.includes('.') ? t.name.slice(0, t.name.indexOf('.')) : '(sem grupo)'
      map.set(g, [...(map.get(g) ?? []), t])
    }
    return [...map]
  }, [tokens])
  if (!tokens.length) return <p className="text-muted">O arquivo ainda não tem tokens. Use a visão JSON para criar (formato em docs/brand.md).</p>
  return (
    <>
      {groups.map(([group, list]) => (
        <section key={group} aria-label={`Grupo ${group}`}>
          <h3 className="mb-1 font-medium">{group}</h3>
          <table className="w-full border-collapse">
            <tbody>
              {list.map((t) => {
                const value = mode !== BASE && t.modes?.[mode] !== undefined ? t.modes[mode]! : t.value
                const color = t.swatch?.[mode] ?? t.swatch?.[BASE]
                return (
                  <tr key={t.name} className="border-b border-border/60 align-top">
                    <td className="w-8 py-1">
                      {color && HEX.test(color) && <span aria-hidden className="block size-5 rounded border border-border" style={{ background: color }} />}
                    </td>
                    <td className="py-1 pr-3 font-mono">{t.name}</td>
                    <td className="py-1 pr-3 text-faint">{t.type}</td>
                    <td className="py-1 pr-3 font-mono">
                      {value || <span className="text-danger">não resolve</span>}
                      {t.alias && <span className="ml-2 text-faint">{t.alias}</span>}
                      {mode !== BASE && t.modes?.[mode] !== undefined && <Badge className="ml-2">{mode}</Badge>}
                    </td>
                    <td className="py-1 text-muted">
                      {t.description}
                      {t.code && <span className="ml-2 font-mono text-faint">{t.code.join(', ')}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}
    </>
  )
}

function Contrast({ brand, mode }: { brand: BrandFileView; mode: string }) {
  const pairs = brand.contrast.filter((c) => c.mode === mode || (mode === BASE && !brand.contrast.some((x) => x.mode === BASE)))
  if (!brand.contrast.length) return null
  return (
    <section aria-label="Contraste">
      <h3 className="mb-1 font-medium">Contraste{mode === BASE ? '' : ` (${mode})`}</h3>
      {!pairs.length && <p className="text-muted">Nenhum par conferido neste modo.</p>}
      <table className="w-full border-collapse">
        <tbody>
          {pairs.map((c) => (
            <tr key={`${c.fg}/${c.bg}/${c.mode}`} className="border-b border-border/60">
              <td className="w-12 py-1">
                {c.fgValue && c.bgValue && HEX.test(c.fgValue) && HEX.test(c.bgValue) && (
                  <span aria-hidden className="inline-block rounded border border-border px-1.5 font-semibold" style={{ color: c.fgValue, background: c.bgValue }}>
                    Aa
                  </span>
                )}
              </td>
              <td className="py-1 pr-3 font-mono">
                {c.fg} / {c.bg}
              </td>
              <td className="py-1 pr-3 font-mono">{c.ratio === null ? '—' : `${c.ratio}:1`}</td>
              <td className="py-1 pr-3 text-faint">mínimo {c.min}:1</td>
              <td className="py-1">
                <Badge tone={c.ok ? 'success' : 'danger'}>{c.ok ? 'passa' : 'não passa'}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Code(props: { brand: BrandFileView; findings: { items: BrandItem[]; scanned: number } | null; scanning: boolean; onScan(): void }) {
  const { brand, findings } = props
  return (
    <section aria-label="Código do frontend" className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">Código do frontend</h3>
        <Button size="sm" icon={<ScanSearch size={14} aria-hidden />} disabled={!brand.sources.length || props.scanning} onClick={props.onScan}>
          {props.scanning ? 'Conferindo…' : 'Conferir o código'}
        </Button>
      </div>
      {!brand.sources.length && (
        <p className="text-muted">Diga em $extensions.vvpost.sources quais arquivos do frontend seguem esta marca (globs relativos ao projeto) para conferir cores, fontes e espaçamentos.</p>
      )}
      {findings && (
        <>
          <p className="text-muted">
            {findings.scanned} arquivo(s) lido(s), {findings.items.length} achado(s).
          </p>
          <ul className="space-y-1">
            {findings.items.map((f, i) => (
              <li key={i}>
                <Badge tone={f.code === 'brand-code-drift' ? 'danger' : 'warning'} mono>
                  {f.code}
                </Badge>{' '}
                <span className="font-mono text-faint">
                  {f.file}
                  {f.line ? `:${f.line}` : ''}
                </span>{' '}
                {f.message}
                {f.hint && <div className="pl-2 text-muted">{f.hint}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
