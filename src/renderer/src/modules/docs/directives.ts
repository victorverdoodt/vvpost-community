import type { CatalogConnector } from '@shared/ipc'
import type { ContextMenuEntries } from '../../design-system'

/** O que o autocomplete das diretivas {{> ...}} conhece do workspace. */
export interface DirectiveContext {
  connectors: (Pick<CatalogConnector, 'id' | 'name' | 'endpoints'> & Partial<Pick<CatalogConnector, 'file' | 'asFlow'>>)[]
  markdownFiles: { file: string; sections: { id: string; title: string; level: number }[] }[]
  directives: { kind: string; usage: string; description: string }[]
}

export interface DirectiveItem {
  label: string
  insert: string
  detail?: string
}

/**
 * Sugestões para o texto antes do cursor numa linha de diretiva: o tipo depois de "{{>", e o
 * argumento de connector, endpoint, request e include. null: o cursor não está numa diretiva.
 */
export function directiveCompletions(before: string, ctx: DirectiveContext): { typed: string; items: DirectiveItem[] } | null {
  const kind = /^\s*\{\{>\s*([A-Za-z0-9-]*)$/.exec(before)
  if (kind) {
    return {
      typed: kind[1]!,
      items: ctx.directives.map((d) => ({
        label: d.kind,
        insert: ['connector', 'endpoint', 'request', 'include'].includes(d.kind) ? `${d.kind} ` : `${d.kind}}}`,
        detail: d.description
      }))
    }
  }
  const arg = /^\s*\{\{>\s*(connector|endpoint|request|include)\s+(\S*)$/.exec(before)
  if (!arg) return null
  const typed = arg[2]!
  const close = '}}'
  switch (arg[1]) {
    case 'connector':
      return { typed, items: ctx.connectors.map((c) => ({ label: c.id, insert: `${c.id}${close}`, detail: c.name })) }
    case 'endpoint':
      return {
        typed,
        items: ctx.connectors.flatMap((c) =>
          c.endpoints.map((e) => ({ label: `${c.id}/${e.id}`, insert: `${c.id}/${e.id}${close}`, detail: `${e.method} ${e.path} · ${e.name}` }))
        )
      }
    case 'request':
      return {
        typed,
        items: ctx.connectors.flatMap((c) =>
          c.endpoints.flatMap((e) =>
            e.scenarios.map((s) => ({ label: `${c.id}/${e.id}/${s.id}`, insert: `${c.id}/${e.id}/${s.id}${close}`, detail: `${s.name} · ${e.method} ${e.path}` }))
          )
        )
      }
    default: {
      // Depois do #: as seções do arquivo (pelo {#id} ou pelo título).
      const hash = typed.indexOf('#')
      if (hash >= 0) {
        const file = ctx.markdownFiles.find((f) => f.file === typed.slice(0, hash))
        return {
          typed: typed.slice(hash + 1),
          items: (file?.sections ?? []).map((s) => ({ label: s.id, insert: `${s.id}${close}`, detail: `${'#'.repeat(s.level)} ${s.title}` }))
        }
      }
      return { typed, items: ctx.markdownFiles.map((f) => ({ label: f.file, insert: f.file, detail: `${f.sections.length} seção(ões)` })) }
    }
  }
}

/**
 * Menu "Inserir" dos editores de documento: seções geradas, conector, endpoint, request (cenário)
 * e trecho de outra doc. `self` é o arquivo aberto (não se inclui a si mesmo).
 */
export function directiveMenu(ctx: DirectiveContext, self: string, insert: (text: string) => void): ContextMenuEntries {
  const simple = ctx.directives.filter((d) => !d.usage.includes('<'))
  return [
    {
      id: 'generated',
      label: 'Seção gerada do projeto',
      items: simple.map((d) => ({ id: d.kind, label: d.description, hint: d.kind, run: () => insert(`{{> ${d.kind}}}`) }))
    },
    {
      id: 'connector',
      label: 'Conector',
      items: ctx.connectors.map((c) => ({ id: c.id, label: c.name, hint: c.id, run: () => insert(`{{> connector ${c.id}}}`) }))
    },
    {
      id: 'endpoint',
      label: 'Endpoint',
      items: ctx.connectors.map((c) => ({
        id: c.id,
        label: c.name,
        items: c.endpoints.map((e) => ({ id: e.id, label: `${e.method} ${e.name}`, hint: e.path, run: () => insert(`{{> endpoint ${c.id}/${e.id}}}`) }))
      }))
    },
    {
      id: 'request',
      label: 'Request (cenário)',
      items: ctx.connectors.map((c) => ({
        id: c.id,
        label: c.name,
        items: c.endpoints.map((e) => ({
          id: e.id,
          label: `${e.method} ${e.name}`,
          items: e.scenarios.map((s) => ({ id: s.id, label: s.name, run: () => insert(`{{> request ${c.id}/${e.id}/${s.id}}}`) }))
        }))
      }))
    },
    {
      id: 'include',
      label: 'Trecho de outra doc',
      items: ctx.markdownFiles
        .filter((f) => f.file !== self)
        .map((f) => ({
          id: f.file,
          label: f.file,
          items: [
            { id: '*', label: 'Arquivo inteiro', run: () => insert(`{{> include ${f.file}}}`) },
            ...f.sections.map((s) => ({
              id: s.id,
              label: `${'  '.repeat(Math.max(0, s.level - 1))}${s.title}`,
              hint: `#${s.id}`,
              run: () => insert(`{{> include ${f.file}#${s.id}}}`)
            }))
          ]
        }))
    }
  ]
}

/**
 * O trecho que uma diretiva monta, para a prévia ao passar o mouse nela: compilado como um
 * documento só com a linha da diretiva, no lugar do arquivo aberto (os caminhos relativos valem).
 */
export async function previewDirective(file: string, directive: string): Promise<{ markdown: string; problems: string[] } | null> {
  const r = await window.vvpost.compileDocs({ config: { source: file, toc: false }, source: directive })
  if (!r.ok) return { markdown: '', problems: [r.message] }
  return { markdown: r.value.printMarkdown, problems: r.value.diagnostics.map((d) => d.message) }
}
