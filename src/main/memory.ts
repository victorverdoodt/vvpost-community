import { readFile } from 'node:fs/promises'
import { app } from 'electron'
import type { ResourceUsage } from '@shared/ipc'

/**
 * Memória do app somando todos os processos do Electron.
 *
 * A métrica muda por plataforma para evitar contar a mesma página várias vezes:
 * somar o working set (RSS) conta de novo, em cada processo, as bibliotecas do
 * Chromium compartilhadas entre eles, e infla o total em ~2x no Linux.
 * - Linux: PSS (proportional set size) de /proc/<pid>/smaps_rollup.
 * - Windows: private bytes, o mesmo número da coluna "Memória" do Gerenciador de Tarefas.
 * - macOS: working set (o Electron não expõe nada melhor).
 */
export async function getResourceUsage(): Promise<ResourceUsage> {
  const metrics = app.getAppMetrics()
  const perProcessKB = await Promise.all(metrics.map((m) => processMemoryKB(m.pid, m.memory)))

  const byProcessType: Record<string, number> = {}
  let totalKB = 0
  metrics.forEach((metric, i) => {
    const kb = perProcessKB[i] ?? 0
    totalKB += kb
    byProcessType[metric.type] = round((byProcessType[metric.type] ?? 0) + kb / 1024)
  })

  return { totalMemoryMB: round(totalKB / 1024), metric: memoryMetric, byProcessType, engine: 'ready' }
}

const memoryMetric: ResourceUsage['metric'] =
  process.platform === 'linux' ? 'pss' : process.platform === 'win32' ? 'privateBytes' : 'workingSet'

async function processMemoryKB(pid: number, memory: Electron.MemoryInfo): Promise<number> {
  if (memoryMetric === 'pss') {
    try {
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
      const match = /^Pss:\s+(\d+) kB/m.exec(rollup)
      if (match) return Number(match[1])
    } catch {
      // Processo encerrou entre getAppMetrics() e a leitura: cai no working set.
    }
  }
  if (memoryMetric === 'privateBytes' && memory.privateBytes !== undefined) return memory.privateBytes
  return memory.workingSetSize
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
