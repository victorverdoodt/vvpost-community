import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Flow } from '@vvpost/schemas'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { ensureGitignored } from '../workspace/vault'

/**
 * Conectores que a IA alterou em auth, destino ou credenciais (guard.ts) e que o
 * usuário ainda não revisou. Fica fora do Git: é uma confirmação desta máquina.
 * Enquanto um conector estiver aqui, o MCP só monta as requisições dele (plan).
 */
export const REVIEW_FILE = '.vvpost/mcp-review.local.json'

export interface ReviewMark {
  /** Quando a IA alterou (ISO 8601). */
  at: string
  /** O que o usuário confirma ao revisar: a auth e o destino efetivos, ou os nós de código. */
  reason?: string
  /** Pedido de revisão aberto no console do Control Plane (revisão central), quando há um. */
  request?: number
}

export type ReviewMarks = Record<string, ReviewMark>

/**
 * Fluxos com nós de código (Python, plugin) escritos ou mudados pela IA também ficam
 * aqui, com o prefixo "flow:" (ids de conector não têm ":"). Até o usuário revisar
 * (salvar o fluxo no Flow Studio ou --approve-review), execute_flow só mostra o plano.
 */
export const flowReviewKey = (flowId: string): string => `flow:${flowId}`

/**
 * O código que o usuário já revisou em cada fluxo (hash do codeFingerprint), também só
 * desta máquina. Um fluxo com código fora daqui (escrito pela IA antes da marca de revisão
 * existir, ou vindo do Git) ganha a marca na próxima vez que o MCP olha os fluxos.
 */
export const REVIEWED_FILE = '.vvpost/mcp-reviewed.local.json'

/** O código dos nós Python e de plugin de um fluxo, pelo id do nó; "" sem nós com código. */
export function codeFingerprint(flow: Flow): string {
  const code = flow.nodes
    .filter((n) => n.type === 'python' || n.type === 'plugin')
    .map((n) => [n.id, n.type === 'python' ? n.python : n.plugin] as const)
    .sort(([a], [b]) => a.localeCompare(b))
  return code.length ? JSON.stringify(code) : ''
}

const hash = (fingerprint: string) => createHash('sha256').update(fingerprint).digest('base64url')

async function readReviewed(dir: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, REVIEWED_FILE), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** O usuário revisou o código destes fluxos (salvou no Flow Studio ou aprovou a marca). */
export async function recordReviewedFlows(dir: string, flows: readonly Flow[]): Promise<void> {
  const reviewed = await readReviewed(dir)
  let changed = false
  for (const flow of flows) {
    const fp = codeFingerprint(flow)
    const next = fp ? hash(fp) : undefined
    if (reviewed[flow.id] === next) continue
    if (next) reviewed[flow.id] = next
    else delete reviewed[flow.id]
    changed = true
  }
  if (changed) await writeJson(dir, REVIEWED_FILE, reviewed)
}

/**
 * Migração das marcas de fluxo: todo fluxo com nós de código que o usuário ainda não
 * revisou nesta máquina, e sem marca, ganha a marca (o MCP não sabe quem escreveu o
 * código antes de a marca existir). Devolve as chaves marcadas agora.
 */
export async function markUnreviewedFlows(dir: string, now = new Date()): Promise<string[]> {
  const [{ flows }, reviewed, marks] = await Promise.all([loadFlows(dir), readReviewed(dir), readReviewMarks(dir)])
  const added: string[] = []
  for (const { flow } of flows) {
    const fp = codeFingerprint(flow)
    const key = flowReviewKey(flow.id)
    if (!fp || marks[key] || reviewed[flow.id] === hash(fp)) continue
    const code = flow.nodes.filter((n) => n.type === 'python' || n.type === 'plugin').map((n) => n.name)
    marks[key] = { at: now.toISOString(), reason: `nós de código: ${code.join(', ')} (ainda não revisados nesta máquina)` }
    added.push(key)
  }
  if (added.length) await writeMarks(dir, marks)
  return added
}

export async function readReviewMarks(dir: string): Promise<ReviewMarks> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, REVIEW_FILE), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ReviewMarks) : {}
  } catch {
    return {}
  }
}

export async function addReviewMarks(
  dir: string,
  ids: string[],
  now = new Date(),
  reasons: Readonly<Record<string, string>> = {}
): Promise<void> {
  const marks = await readReviewMarks(dir)
  for (const id of ids) marks[id] = { at: now.toISOString(), ...(reasons[id] && { reason: reasons[id] }) }
  await writeMarks(dir, marks)
}

/** O usuário revisou (salvou no editor ou confirmou): sem `ids`, todos. Devolve os confirmados. */
export async function clearReviewMarks(dir: string, ids?: string[]): Promise<string[]> {
  const marks = await readReviewMarks(dir)
  const cleared = (ids ?? Object.keys(marks)).filter((id) => id in marks)
  if (!cleared.length) return []
  for (const id of cleared) delete marks[id]
  await writeMarks(dir, marks)
  // Aprovar a marca de um fluxo é revisar o código que ele tem agora.
  const flowIds = new Set(cleared.filter((k) => k.startsWith('flow:')).map((k) => k.slice('flow:'.length)))
  if (flowIds.size) {
    const { flows } = await loadFlows(dir)
    await recordReviewedFlows(dir, flows.map((f) => f.flow).filter((f) => flowIds.has(f.id)))
  }
  return cleared
}

/** Item pendente com o hash do que a aprovação cobre (revisão central no console). */
export interface ReviewSnapshotItem {
  key: string
  kind: 'connector' | 'flow'
  reason?: string
  hash: string
  /** Código dos nós do fluxo, para quem aprova ler. */
  detail?: string
  request?: number
}

/** Teto do código de um fluxo enviado para o console ler. */
const MAX_DETAIL_CHARS = 64 * 1024

/**
 * As marcas pendentes com o hash do conteúdo de agora: o documento do conector, ou o código dos
 * nós do fluxo. Uma aprovação vale para este hash; se a IA mudar o item depois, ela não se aplica.
 * Marca de algo que não existe mais fica de fora (hash vazio não se aprova).
 */
export async function reviewSnapshot(dir: string): Promise<ReviewSnapshotItem[]> {
  const marks = await readReviewMarks(dir)
  const keys = Object.keys(marks)
  if (!keys.length) return []
  const [{ loadWorkspace }, { flows }] = await Promise.all([import('@vvpost/core/connectors/workspace'), loadFlows(dir)])
  const ws = await loadWorkspace(dir)
  const out: ReviewSnapshotItem[] = []
  for (const key of keys.sort()) {
    const mark = marks[key]!
    const base = { key, ...(mark.reason && { reason: mark.reason }), ...(mark.request !== undefined && { request: mark.request }) }
    if (key.startsWith('flow:')) {
      const flow = flows.find((f) => f.flow.id === key.slice('flow:'.length))?.flow
      const fp = flow ? codeFingerprint(flow) : ''
      if (!flow || !fp) continue
      const detail = flow.nodes
        .filter((n) => n.type === 'python' || n.type === 'plugin')
        .map((n) =>
          n.type === 'python'
            ? `# ${n.name} (python, rede: ${n.python.network?.join(', ') || 'nenhuma'})\n${n.python.code}`
            : `# ${n.name} (plugin)\n${JSON.stringify(n.plugin, null, 2)}`
        )
        .join('\n\n')
      out.push({ ...base, kind: 'flow', hash: hash(fp), detail: detail.slice(0, MAX_DETAIL_CHARS) })
      continue
    }
    const connector = ws.connectors.get(key)
    if (!connector) continue
    out.push({ ...base, kind: 'connector', hash: hash(JSON.stringify(connector)) })
  }
  return out
}

/** Guarda nas marcas o pedido de revisão aberto no console para estas chaves. */
export async function setReviewRequest(dir: string, keys: readonly string[], request: number): Promise<void> {
  const marks = await readReviewMarks(dir)
  let changed = false
  for (const key of keys) {
    if (!marks[key] || marks[key].request === request) continue
    marks[key] = { ...marks[key], request }
    changed = true
  }
  if (changed) await writeMarks(dir, marks)
}

/**
 * Aplica uma aprovação do console: limpa só as marcas cujo conteúdo ainda tem o hash aprovado.
 * Devolve as chaves aprovadas agora e as que mudaram depois do pedido (continuam pendentes).
 */
export async function applyApprovedReview(dir: string, approved: readonly { key: string; hash: string }[]): Promise<{ applied: string[]; stale: string[] }> {
  const current = new Map((await reviewSnapshot(dir)).map((i) => [i.key, i.hash]))
  const applied: string[] = []
  const stale: string[] = []
  for (const { key, hash: h } of approved) {
    if (!current.has(key)) continue
    if (current.get(key) === h) applied.push(key)
    else stale.push(key)
  }
  if (applied.length) await clearReviewMarks(dir, applied)
  return { applied, stale }
}

function writeMarks(dir: string, marks: ReviewMarks): Promise<void> {
  return writeJson(dir, REVIEW_FILE, marks)
}

async function writeJson(dir: string, file: string, data: unknown): Promise<void> {
  const path = join(dir, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`)
  await rename(`${path}.tmp`, path)
  await ensureGitignored(dir, file)
}
