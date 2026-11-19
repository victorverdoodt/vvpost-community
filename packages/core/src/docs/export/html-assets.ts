// Estilo e script do site do exportador html. Ficam aqui, como texto, para o core não depender
// de arquivos fora do código (o CLI vai num bundle só). Sem nada externo: fontes do sistema.

export const SITE_CSS = `
:root{color-scheme:light dark;--vv-bg:#ffffff;--vv-panel:#f7f7f9;--vv-fg:#1c2024;--vv-muted:#60646c;--vv-border:#e0e1e6;--vv-code:#f3f3f6;--vv-note:#0d74ce;--vv-tip:#218358;--vv-important:#8145b5;--vv-warning:#ab6400;--vv-caution:#ce2c31;--vv-font:Inter,"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;--vv-mono:"JetBrains Mono","Cascadia Mono",Consolas,"SFMono-Regular",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--vv-bg:#111113;--vv-panel:#18191b;--vv-fg:#edeef0;--vv-muted:#b0b4ba;--vv-border:#2e3135;--vv-code:#1f2123;--vv-note:#70b8ff;--vv-tip:#3dd68c;--vv-important:#baa7ff;--vv-warning:#ffca16;--vv-caution:#ff9592}}
*{box-sizing:border-box}
html{scroll-padding-top:4.5rem}
body{margin:0;background:var(--vv-bg);color:var(--vv-fg);font:15px/1.65 var(--vv-font);-webkit-text-size-adjust:100%}
a{color:var(--vv-accent)}
.vv-skip{position:absolute;left:-999px}.vv-skip:focus{left:1rem;top:.5rem;z-index:20;background:var(--vv-bg);padding:.25rem .5rem}
.vv-top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:1rem;height:3.5rem;padding:0 1.25rem;background:var(--vv-bg);border-bottom:1px solid var(--vv-border)}
.vv-brand{display:flex;align-items:center;gap:.6rem;color:var(--vv-fg);font-weight:600;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vv-logo{height:1.75rem;width:auto}
.vv-version{font-size:.75rem;color:var(--vv-muted);border:1px solid var(--vv-border);border-radius:999px;padding:0 .5rem}
.vv-search{position:relative;margin-left:auto;width:min(22rem,40vw)}
.vv-search input{width:100%;font:inherit;font-size:.875rem;padding:.35rem .75rem;border:1px solid var(--vv-border);border-radius:.5rem;background:var(--vv-panel);color:var(--vv-fg)}
.vv-results{position:absolute;right:0;top:2.4rem;width:min(32rem,90vw);max-height:70vh;overflow:auto;margin:0;padding:.25rem;list-style:none;background:var(--vv-bg);border:1px solid var(--vv-border);border-radius:.5rem;box-shadow:0 8px 24px rgba(0,0,0,.15)}
.vv-results a{display:block;padding:.4rem .6rem;border-radius:.35rem;color:var(--vv-fg);text-decoration:none}
.vv-results a:hover,.vv-results a:focus{background:var(--vv-panel);outline:none}
.vv-results small{display:block;color:var(--vv-muted)}
.vv-changes{font-size:.875rem;color:var(--vv-muted);text-decoration:none}.vv-changes.vv-current,.vv-changes:hover{color:var(--vv-accent)}
.vv-menu{display:none;font:inherit;background:none;border:0;color:var(--vv-fg);font-size:1.25rem;cursor:pointer}
.vv-layout{display:grid;grid-template-columns:17rem minmax(0,1fr) 14rem;max-width:90rem;margin:0 auto}
.vv-nav{position:sticky;top:3.5rem;align-self:start;max-height:calc(100vh - 3.5rem);overflow:auto;padding:1.25rem 1rem;border-right:1px solid var(--vv-border);font-size:.875rem}
.vv-nav ul{list-style:none;margin:0;padding:0}.vv-nav ul ul{padding-left:.85rem;border-left:1px solid var(--vv-border);margin-left:.4rem}
.vv-nav a{display:block;padding:.2rem .5rem;border-radius:.35rem;color:var(--vv-fg);text-decoration:none}
.vv-nav a:hover{background:var(--vv-panel)}
.vv-nav a.vv-current{color:var(--vv-accent);font-weight:600;background:var(--vv-panel)}
.vv-nav summary{cursor:pointer;padding:.35rem .5rem;color:var(--vv-muted);font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
.vv-main{min-width:0;padding:2rem 2.5rem 4rem}
.vv-toc{position:sticky;top:3.5rem;align-self:start;max-height:calc(100vh - 3.5rem);overflow:auto;padding:2rem 1rem;font-size:.8rem}
.vv-toc p{margin:0 0 .5rem;font-weight:600;color:var(--vv-muted)}
.vv-toc ul{list-style:none;margin:0;padding:0}.vv-toc a{color:var(--vv-muted);text-decoration:none;display:block;padding:.15rem 0}.vv-toc a:hover{color:var(--vv-accent)}
.vv-toc .vv-l3{padding-left:.75rem}
.vv-crumbs{font-size:.8rem;color:var(--vv-muted);display:flex;gap:.4rem;flex-wrap:wrap}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:2rem 0 .75rem}
h1{font-size:2rem;margin-top:.5rem}h2{font-size:1.45rem;padding-bottom:.3rem;border-bottom:1px solid var(--vv-border)}h3{font-size:1.15rem}
.vv-anchor{margin-left:.4rem;color:var(--vv-border);text-decoration:none;opacity:0}h2:hover .vv-anchor,h3:hover .vv-anchor,h4:hover .vv-anchor{opacity:1}
code{font-family:var(--vv-mono);font-size:.85em;background:var(--vv-code);border-radius:.3rem;padding:.1em .35em}
pre{position:relative;overflow:auto;background:var(--vv-code);border:1px solid var(--vv-border);border-radius:.5rem;padding:.9rem 1rem;font-size:.82rem;line-height:1.5}
pre code{background:none;padding:0;font-size:inherit}
.vv-copy{position:absolute;top:.4rem;right:.4rem;font:inherit;font-size:.7rem;padding:.15rem .5rem;border:1px solid var(--vv-border);border-radius:.35rem;background:var(--vv-bg);color:var(--vv-muted);cursor:pointer;opacity:0}pre:hover .vv-copy,.vv-copy:focus{opacity:1}
.vv-table{overflow:auto;margin:1rem 0}
table{border-collapse:collapse;font-size:.875rem;min-width:50%}
th,td{border:1px solid var(--vv-border);padding:.4rem .65rem;vertical-align:top}th{background:var(--vv-panel);text-align:left}
blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:3px solid var(--vv-accent);color:var(--vv-muted)}
.vv-alert{margin:1rem 0;padding:.6rem 1rem;border-left:4px solid var(--vv-note);border-radius:.35rem;background:var(--vv-panel)}
.vv-alert>:last-child{margin-bottom:0}.vv-alert-title{margin:0 0 .25rem;font-weight:600;color:var(--vv-note)}
.vv-alert-tip{border-color:var(--vv-tip)}.vv-alert-tip .vv-alert-title{color:var(--vv-tip)}
.vv-alert-important{border-color:var(--vv-important)}.vv-alert-important .vv-alert-title{color:var(--vv-important)}
.vv-alert-warning{border-color:var(--vv-warning)}.vv-alert-warning .vv-alert-title{color:var(--vv-warning)}
.vv-alert-caution{border-color:var(--vv-caution)}.vv-alert-caution .vv-alert-title{color:var(--vv-caution)}
.vv-diagram{margin:1.25rem 0}.vv-diagram img{display:block;max-width:100%;height:auto;margin:0 auto;padding:1rem;background:#fff;border:1px solid var(--vv-border);border-radius:.5rem}
.vv-mermaid{white-space:pre;overflow:auto;font-family:var(--vv-mono);font-size:.8rem;color:var(--vv-muted);background:var(--vv-code);padding:1rem;border-radius:.5rem}
.vv-mermaid-svg{overflow:auto;text-align:center;padding:1rem;border:1px solid var(--vv-border);border-radius:.5rem}.vv-mermaid-svg svg{max-width:100%;height:auto}
.vv-diagram summary,.vv-diagram figcaption{font-size:.8rem;color:var(--vv-muted);cursor:pointer;margin-top:.4rem}
img{max-width:100%}
.vv-task{list-style:none;margin-left:-1.2rem}
.vv-raw{white-space:pre-wrap}
.vv-pager{display:flex;justify-content:space-between;gap:1rem;margin-top:3rem;padding-top:1.25rem;border-top:1px solid var(--vv-border)}
.vv-pager a{display:flex;flex-direction:column;max-width:48%;padding:.6rem .9rem;border:1px solid var(--vv-border);border-radius:.5rem;text-decoration:none}
.vv-pager small{color:var(--vv-muted)}.vv-next{margin-left:auto;text-align:right}
.vv-changelog h2 small{font-size:.8rem;font-weight:400;color:var(--vv-muted);margin-left:.5rem}
.vv-changelog h3{font-size:.95rem;margin:1rem 0 .25rem}.vv-added{color:var(--vv-tip)}.vv-changed{color:var(--vv-note)}.vv-removed{color:var(--vv-caution)}
.vv-footer{padding:1.5rem;text-align:center;font-size:.8rem;color:var(--vv-muted);border-top:1px solid var(--vv-border)}
@media (max-width:72rem){.vv-layout{grid-template-columns:16rem minmax(0,1fr)}.vv-toc{display:none}}
@media (max-width:48rem){.vv-version{display:none}.vv-layout{display:block}.vv-menu{display:block}.vv-nav{display:none;position:static;max-height:none;border-right:0;border-bottom:1px solid var(--vv-border)}body.vv-nav-open .vv-nav{display:block}.vv-main{padding:1.25rem 1rem 3rem}.vv-search{width:auto;flex:1}.vv-changes{display:none}}
@media print{.vv-top,.vv-nav,.vv-toc,.vv-pager,.vv-footer{display:none}.vv-layout{display:block}}
`.trimStart()

/**
 * Busca, botão de copiar nos blocos de código e o menu no celular. O site funciona sem script;
 * nada aqui usa innerHTML com texto da documentação.
 */
export const SITE_JS = `(function () {
  'use strict'
  var fold = function (s) { return String(s).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase() }
  var menu = document.querySelector('.vv-menu')
  if (menu) menu.addEventListener('click', function () {
    var open = document.body.classList.toggle('vv-nav-open')
    menu.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.querySelectorAll('pre.vv-code').forEach(function (pre) {
    if (!navigator.clipboard) return
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'vv-copy'
    b.textContent = 'Copiar'
    b.addEventListener('click', function () {
      var code = pre.querySelector('code')
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(function () {
        b.textContent = 'Copiado'
        setTimeout(function () { b.textContent = 'Copiar' }, 1500)
      })
    })
    pre.appendChild(b)
  })
  var input = document.querySelector('.vv-search input')
  var list = document.querySelector('.vv-results')
  var index = (window.VVPOST_SEARCH || []).map(function (p) {
    return { p: p, title: fold(p.t), text: fold(p.x), heads: p.h.map(function (h) { return [h[0], h[1], fold(h[1])] }) }
  })
  if (!input || !list) return
  var item = function (href, title, where) {
    var li = document.createElement('li')
    var a = document.createElement('a')
    a.href = href
    a.textContent = title
    if (where) {
      var s = document.createElement('small')
      s.textContent = where
      a.appendChild(s)
    }
    li.appendChild(a)
    return li
  }
  var search = function () {
    var terms = fold(input.value).split(/\\s+/).filter(Boolean)
    list.textContent = ''
    if (!terms.length) { list.hidden = true; return }
    var hits = []
    index.forEach(function (e) {
      var all = terms.every(function (t) { return e.title.indexOf(t) >= 0 || e.text.indexOf(t) >= 0 })
      if (!all) return
      var score = terms.reduce(function (n, t) { return n + (e.title.indexOf(t) >= 0 ? 10 : 0) + (e.text.indexOf(t) >= 0 ? 1 : 0) }, 0)
      var head = e.heads.filter(function (h) { return terms.every(function (t) { return h[2].indexOf(t) >= 0 }) })[0]
      hits.push({ score: score + (head ? 5 : 0), e: e, head: head })
    })
    hits.sort(function (a, b) { return b.score - a.score })
    hits.slice(0, 12).forEach(function (h) {
      var p = h.e.p
      list.appendChild(h.head ? item(p.f + '#' + h.head[0], h.head[1], p.t) : item(p.f, p.t, p.p))
    })
    if (!hits.length) {
      var li = document.createElement('li')
      li.textContent = 'Nada encontrado.'
      li.style.padding = '.4rem .6rem'
      list.appendChild(li)
    }
    list.hidden = false
  }
  input.addEventListener('input', search)
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; search() }
    if (e.key === 'Enter') { var a = list.querySelector('a'); if (a) location.href = a.href }
  })
  document.addEventListener('click', function (e) { if (!e.target.closest('.vv-search')) list.hidden = true })
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus() }
  })
})()
;(function () {
  'use strict'
  // Diagramas sem imagem: o mermaid.min.js do próprio site desenha no navegador (sem CDN).
  var blocks = document.querySelectorAll('pre.vv-mermaid')
  if (!blocks.length || !window.mermaid) return
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
  Array.prototype.forEach.call(blocks, function (pre, i) {
    window.mermaid.render('vv-mermaid-' + i, pre.textContent).then(function (out) {
      var box = document.createElement('div')
      box.className = 'vv-mermaid-svg'
      box.setAttribute('role', 'img')
      box.setAttribute('aria-label', 'Diagrama')
      box.innerHTML = out.svg
      pre.replaceWith(box)
    }, function () {
      pre.classList.add('vv-mermaid-failed')
    })
  })
})()
`
