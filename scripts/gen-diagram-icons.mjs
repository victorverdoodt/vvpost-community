// Gera o pacote de ícones "vv" do editor de diagramas (formato do Iconify) a partir dos ícones do
// lucide-react (licença ISC), já dependência do app. Rode de novo ao mudar a lista:
//   node scripts/gen-diagram-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS = {
  servidor: 'server', banco: 'database', api: 'webhook', nuvem: 'cloud', internet: 'globe', usuario: 'user', usuarios: 'users',
  celular: 'smartphone', navegador: 'app-window', desktop: 'monitor', fila: 'list-ordered', evento: 'zap', mensagem: 'message-square',
  email: 'mail', cadeado: 'lock', chave: 'key-round', escudo: 'shield-check', container: 'container', pacote: 'package',
  servico: 'box', servicos: 'boxes', rede: 'network', disco: 'hard-drive', cpu: 'cpu', cache: 'layers', arquivo: 'file-text',
  pasta: 'folder', configuracao: 'settings', relogio: 'clock', agendador: 'calendar-clock', busca: 'search', robo: 'bot',
  plugin: 'plug', terminal: 'square-terminal', codigo: 'code', git: 'git-branch', fluxo: 'workflow', monitor: 'activity',
  alerta: 'bell', pagamento: 'credit-card', carrinho: 'shopping-cart', loja: 'store', empresa: 'building-2', log: 'scroll-text',
  grafico: 'chart-column', sincronizar: 'refresh-cw', balanceador: 'split', gateway: 'door-open', funcao: 'square-function', dados: 'table'
}
const pkg = join(root, 'node_modules/lucide-react/dist/esm/icons')
const attr = (k, v) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${String(v).replace(/"/g, '&quot;')}"`
const icons = {}
for (const [name, lucide] of Object.entries(ICONS)) {
  let text = readFileSync(join(pkg, `${lucide}.mjs`), 'utf8')
  // Nome antigo: o arquivo só reexporta o ícone novo.
  const alias = /export \{ default \} from '\.\/(.+?)\.mjs'/.exec(text)
  if (alias) text = readFileSync(join(pkg, `${alias[1]}.mjs`), 'utf8')
  const data = /const __iconData = (\{[\s\S]*?\n\});/.exec(text)
  if (!data) throw new Error(`ícone ${lucide}: formato inesperado`)
  // eslint-disable-next-line no-new-func
  const elements = Function(`return ${data[1]}`)().node
  const inner = elements.map(([tag, props]) => `<${tag} ${Object.entries(props).filter(([k]) => k !== 'key').map(([k, v]) => attr(k, v)).join(' ')}/>`).join('')
  icons[name] = { body: `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>` }
}
const out = { prefix: 'vv', info: { name: 'VVPost', license: { title: 'ISC (ícones do Lucide)', spdx: 'ISC' } }, width: 24, height: 24, icons }
writeFileSync(join(root, 'src/renderer/src/design-system/content/vv-icons.json'), `${JSON.stringify(out, null, 1)}\n`)
console.log(`${Object.keys(icons).length} ícones`)
