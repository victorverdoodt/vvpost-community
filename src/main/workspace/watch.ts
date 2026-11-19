import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

/** Pastas que nunca têm arquivos do VVPost: Git, dependências, saídas de build e estado local. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.vvpost', 'target', 'bin', 'obj'])
/** Arquivos que as abas e o catálogo leem: conectores, fluxos, ambientes, manifestos, documentos e diagramas. */
const WATCHED_FILE = /\.(?:json|md|mmd)$/i
/** Mudanças em sequência (um lote do MCP, um checkout) chegam como um aviso só. */
const DEBOUNCE_MS = 150
/** Linux não tem watch recursivo nativo: uma pasta por watcher, com limite para repositórios grandes. */
const MAX_DIRS = 2000
const MAX_DEPTH = 8

export interface WorkspaceWatcher {
  close(): void
}

/** O caminho (com "/") é de um arquivo que o VVPost lê? Pastas ignoradas e ocultas ficam de fora. */
export function isWatchedPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/)
  if (parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p) || (p.startsWith('.') && p !== '..'))) return false
  return WATCHED_FILE.test(parts.at(-1) ?? '')
}

/**
 * Observa a pasta do workspace (a raiz, com o Compartilhado e os projetos) e avisa os arquivos que
 * mudaram no disco, por quem quer que seja: o MCP (no app ou no `mcp.js` de um agente), o CLI, um
 * editor de código ou o Git. Os caminhos vão relativos a `root`, com "/".
 */
export function watchWorkspace(root: string, onChange: (files: string[]) => void): WorkspaceWatcher {
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let closed = false
  const flush = () => {
    timer = null
    if (closed || !pending.size) return
    const files = [...pending].sort()
    pending.clear()
    onChange(files)
  }
  const note = (abs: string) => {
    const rel = relative(root, abs).split(sep).join('/')
    if (!rel || rel.startsWith('../') || !isWatchedPath(rel)) return
    pending.add(rel)
    timer ??= setTimeout(flush, DEBOUNCE_MS)
  }

  // Windows e macOS: um watcher recursivo nativo.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(root, { recursive: true }, (_event, name) => name && note(join(root, name.toString())))
      watcher.on('error', () => undefined)
    } catch {
      // pasta sumiu ou sem permissão: o foco da janela ainda relê
    }
    return {
      close() {
        closed = true
        if (timer) clearTimeout(timer)
        watcher?.close()
      }
    }
  }

  // Linux: uma pasta por watcher, descendo pelas que podem ter arquivos do VVPost; pasta nova entra quando aparece.
  const watchers = new Map<string, FSWatcher>()
  const add = async (dir: string, depth: number): Promise<void> => {
    if (closed || watchers.has(dir) || watchers.size >= MAX_DIRS || depth > MAX_DEPTH) return
    const name = basename(dir)
    if (depth > 0 && (IGNORED_DIRS.has(name) || name.startsWith('.'))) return
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false)) || closed || watchers.has(dir)) return
    let watcher: FSWatcher
    try {
      watcher = watch(dir, (_event, name) => {
        if (!name) return
        const abs = join(dir, name.toString())
        note(abs)
        if (WATCHED_FILE.test(abs)) return
        // Uma pasta criada (flows/<conector>/, docs/...) passa a ser observada; uma apagada deixa de ser,
        // para voltar se for criada de novo.
        const known = watchers.get(abs)
        if (known) void stat(abs).catch(() => {
          known.close()
          watchers.delete(abs)
        })
        else void add(abs, depth + 1)
      })
    } catch {
      return
    }
    watcher.on('error', () => {
      watcher.close()
      watchers.delete(dir)
    })
    watchers.set(dir, watcher)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isDirectory()) await add(join(dir, e.name), depth + 1)
    }
  }
  void add(root, 0)
  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      for (const w of watchers.values()) w.close()
      watchers.clear()
    }
  }
}
