'use strict'

/**
 * Exportador MkDocs do VVPost: a mesma estrutura do vvpost.publish.json vira o mkdocs.yml (nav)
 * e uma página Markdown por página, gerada da árvore neutra do pacote (já sem segredos). Links
 * entre páginas apontam para os .md exportados, alertas viram admonitions e diagramas viram as
 * imagens desenhadas pelo VVPost (ou o bloco mermaid, sem imagem). O VVPost grava os arquivos.
 */

const RESERVED = new Set(['index', 'mudancas'])
const ALERT = { note: ['note', 'Nota'], tip: ['tip', 'Dica'], important: ['info', 'Importante'], warning: ['warning', 'Atenção'], caution: ['danger', 'Cuidado'] }

function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
}

/** O arquivo de cada página: a primeira é o index.md; as outras, um nome estável pela chave. */
function pageFiles(nodes) {
  const files = new Map()
  const used = new Set()
  const walk = (list) => {
    for (const n of list) {
      if (n.kind === 'page') {
        if (!files.size) {
          files.set(n.key, 'index.md')
          used.add('index')
        } else {
          const base = slugify(n.key.replace(/^(file|page):(docs\/)?/, '').replace(/\.md(#|$)/i, '$1')).replace(/^([a-z0-9]+)-\1-/, '$1-') || 'pagina'
          let slug = RESERVED.has(base) ? base + '-pagina' : base
          for (let i = 2; used.has(slug); i++) slug = base + '-' + i
          used.add(slug)
          files.set(n.key, slug + '.md')
        }
      }
      walk(n.children)
    }
  }
  walk(nodes)
  return files
}

const escapeText = (s) => s.replace(/([\\`*_[\]<>|])/g, '\\$1')
const yaml = (s) => JSON.stringify(String(s))

function fence(text, lang) {
  let ticks = '```'
  while (text.includes(ticks)) ticks += '`'
  return ticks + (lang || '') + '\n' + text + '\n' + ticks
}

function inline(list, r) {
  return list
    .map((n) => {
      switch (n.type) {
        case 'text':
          return escapeText(n.text)
        case 'strong':
          return '**' + inline(n.children, r) + '**'
        case 'em':
          return '*' + inline(n.children, r) + '*'
        case 'del':
          return '~~' + inline(n.children, r) + '~~'
        case 'code':
          return n.text.includes('`') ? '`` ' + n.text + ' ``' : '`' + n.text + '`'
        case 'break':
          return '<br>'
        case 'link':
          return /^(https?:|mailto:|tel:)/i.test(n.href) || !/^[a-z][a-z0-9+.-]*:/i.test(n.href) ? '[' + inline(n.children, r) + '](' + n.href.replace(/[()\s]/g, encodeURIComponent) + ')' : inline(n.children, r)
        case 'pageLink': {
          const file = r.files.get(n.page)
          return file ? '[' + inline(n.children, r) + '](' + file + (n.anchor ? '#' + n.anchor : '') + ')' : inline(n.children, r)
        }
        case 'anchorLink':
          return '[' + inline(n.children, r) + '](#' + n.anchor + ')'
        case 'image':
          if (n.asset) return r.assets.has(n.asset) ? '![' + escapeText(n.alt) + '](assets/' + n.asset + ')' : escapeText(n.alt)
          return n.url && /^https?:/i.test(n.url) ? '![' + escapeText(n.alt) + '](' + n.url + ')' : escapeText(n.alt)
        default:
          return ''
      }
    })
    .join('')
}

const indent = (text, pad) => text.split('\n').map((l) => (l ? pad + l : l)).join('\n')

function blocks(list, r) {
  return list
    .map((b) => {
      switch (b.type) {
        case 'heading':
          return '#'.repeat(Math.max(2, b.level)) + ' ' + inline(b.children, r) + ' { #' + b.anchor + ' }'
        case 'paragraph':
          return inline(b.children, r)
        case 'list':
          return b.items
            .map((item, i) => {
              const mark = b.ordered ? (b.start || 1) + i + '. ' : '- '
              const box = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] '
              const body = blocks(item.blocks, r)
              return mark + box + indent(body, ' '.repeat(mark.length)).trimStart()
            })
            .join('\n')
        case 'table': {
          const row = (cells) => '| ' + cells.map((c) => inline(c, r).replace(/\n/g, ' ')).join(' | ') + ' |'
          const sep = '| ' + b.align.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---')).join(' | ') + ' |'
          return [row(b.header), sep, ...b.rows.map(row)].join('\n')
        }
        case 'code':
          return fence(b.text, b.language)
        case 'diagram':
          return b.asset && r.assets.has(b.asset) ? '![Diagrama](assets/' + b.asset + ')' : fence(b.source, 'mermaid')
        case 'alert': {
          const [kind, title] = ALERT[b.kind] || ALERT.note
          return '!!! ' + kind + ' ' + yaml(title) + '\n\n' + indent(blocks(b.blocks, r), '    ')
        }
        case 'quote':
          return blocks(b.blocks, r)
            .split('\n')
            .map((l) => '> ' + l)
            .join('\n')
        case 'rule':
          return '---'
        case 'html':
          return fence(b.text, 'text')
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n\n')
}

function changelogPage(entries, files) {
  const endpointFile = (key) => files.get('endpoint:' + key) || files.get('connector:' + key.slice(0, key.lastIndexOf('/')))
  const ref = (item, link) => {
    const file = link === 'page' ? files.get(item.key) : link === 'endpoint' ? endpointFile(item.key) : undefined
    return '- ' + (file ? '[' + escapeText(item.title) + '](' + file + ')' : escapeText(item.title))
  }
  const group = (label, list, link) => (list.length ? '### ' + label + '\n\n' + list.map((i) => ref(i, link)).join('\n') : '')
  const body = entries.map((e) => {
    const head = '## ' + (e.label ? escapeText(e.label) + ' · ' : '') + e.at.slice(0, 10)
    if (e.initial) return head + '\n\nPrimeira publicação da documentação.'
    const parts = [
      group('Endpoints novos', e.endpoints.added, 'endpoint'),
      group('Endpoints alterados', e.endpoints.changed, 'endpoint'),
      group('Endpoints removidos', e.endpoints.removed, null),
      group('Páginas novas', e.pages.added, 'page'),
      group('Páginas alteradas', e.pages.changed, 'page'),
      group('Páginas removidas', e.pages.removed, null)
    ].filter(Boolean)
    return head + '\n\n' + (parts.join('\n\n') || 'Sem mudanças no conteúdo.')
  })
  return '# Mudanças\n\n' + (body.join('\n\n') || 'Nenhuma exportação registrada.') + '\n'
}

module.exports = {
  exporters: {
    mkdocs: {
      export(ctx) {
        const bundle = ctx.bundle
        const files = pageFiles(bundle.nodes)
        const assets = new Map(bundle.assets.filter((a) => a.base64).map((a) => [a.id, a]))
        const r = { files, assets }
        const out = []
        const used = new Set()
        const collect = (list) => {
          for (const b of list) {
            if (b.type === 'diagram' && b.asset) used.add(b.asset)
            if (b.blocks) collect(b.blocks)
            if (b.items) b.items.forEach((i) => collect(i.blocks))
            const inl = [].concat(b.children || [], ...(b.header || []), ...((b.rows || []).flat()))
            const walk = (xs) => xs.forEach((x) => (x.type === 'image' && x.asset ? used.add(x.asset) : x.children && walk(x.children)))
            walk(inl)
          }
        }
        const nav = (list) =>
          list
            .map((n) => {
              const file = files.get(n.key)
              const kids = nav(n.children)
              if (!file) return kids.length ? [{ [n.title]: kids }] : []
              return kids.length ? [{ [n.title]: [file, ...kids] }] : [{ [n.title]: file }]
            })
            .flat()
        const walk = (list) => {
          for (const n of list) {
            const file = files.get(n.key)
            if (file) {
              const content = n.page ? blocks(n.page.blocks, r) : n.children.map((c) => (files.get(c.key) ? '- [' + escapeText(c.title) + '](' + files.get(c.key) + ')' : '- ' + escapeText(c.title))).join('\n')
              if (n.page) collect(n.page.blocks)
              out.push({ path: 'docs/' + file, page: n.key, text: '# ' + escapeText(n.title) + '\n\n' + content + '\n' })
            }
            walk(n.children)
          }
        }
        walk(bundle.nodes)
        const changelog = !bundle.site || bundle.site.changelog !== false
        if (changelog) out.push({ path: 'docs/mudancas.md', text: changelogPage(ctx.changelog, files) })
        for (const id of [...used].sort()) if (assets.has(id)) out.push({ path: 'docs/assets/' + id, base64: assets.get(id).base64 })

        const toYaml = (items, pad) =>
          items
            .map((item) => {
              const [title, value] = Object.entries(item)[0]
              if (typeof value === 'string') return pad + '- ' + yaml(title) + ': ' + yaml(value)
              return pad + '- ' + yaml(title) + ':\n' + value.map((v) => (typeof v === 'string' ? pad + '    - ' + yaml(v) : toYaml([v], pad + '    '))).join('\n')
            })
            .join('\n')
        const items = nav(bundle.nodes)
        if (changelog) items.push({ 'Mudanças': 'mudancas.md' })
        const meta = bundle.meta || { title: bundle.project }
        const lines = [
          '# Gerado pelo VVPost (vvpost-plugin-mkdocs). Mude a estrutura no vvpost.publish.json e exporte de novo.',
          'site_name: ' + yaml((bundle.site && bundle.site.title) || meta.title),
          ...(meta.subtitle ? ['site_description: ' + yaml(meta.subtitle)] : []),
          ...(bundle.site && bundle.site.baseUrl ? ['site_url: ' + yaml(bundle.site.baseUrl)] : []),
          'docs_dir: docs',
          'nav:',
          toYaml(items, '  '),
          'markdown_extensions:',
          '  - admonition',
          '  - attr_list',
          '  - tables',
          '  - toc:',
          '      permalink: true',
          ...(bundle.site && bundle.site.backstage ? ['plugins:', '  - techdocs-core'] : [])
        ]
        out.push({ path: 'mkdocs.yml', text: lines.join('\n') + '\n' })
        return { files: out }
      }
    }
  }
}
