import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import {
  Bot,
  BookOpen,
  FileDown,
  FlaskConical,
  GitBranch,
  History,
  KeyRound,
  Network,
  Puzzle,
  Settings,
  Webhook,
  Workflow,
  Zap,
  type LucideIcon
} from 'lucide-react'

export type PanelGroup = 'work' | 'project' | 'integrations'

export const PANEL_GROUPS: { id: PanelGroup; label: string }[] = [
  { id: 'work', label: 'Trabalho' },
  { id: 'project', label: 'Projeto' },
  { id: 'integrations', label: 'Integrações' }
]

export interface PanelDefinition {
  id: string
  label: string
  /** Rótulo curto da aba do workspace. */
  short: string
  /** Uma linha sobre o módulo (dica da sidebar e paleta de comandos). */
  description: string
  icon: LucideIcon
  /** Grupo de intenção na sidebar. */
  group: PanelGroup
  /** Dígito do atalho Ctrl+N (0 a 9). Fixo: não muda quando a ordem ou os grupos mudam. Os dez já têm dono: os módulos novos abrem pela sidebar e pela paleta. */
  key?: number
  /** Fase do roadmap em que o painel é entregue. */
  phase: number
  component: LazyExoticComponent<ComponentType>
}

// Cada painel é um chunk separado, carregado só quando a aba é aberta pela
// primeira vez (lazy hydration). Editores pesados (Monaco, React Flow)
// devem entrar sempre por aqui, nunca por import estático.
// A ordem é a da sidebar: agrupada por intenção (Trabalho, Projeto, Integrações).
export const panels: PanelDefinition[] = [
  {
    id: 'quick-request',
    label: 'Quick Request',
    short: 'Quick',
    description: 'Cliente HTTP com herança de conectores',
    icon: Zap,
    group: 'work',
    key: 1,
    phase: 1,
    component: lazy(() => import('../modules/quick-request/QuickRequestModule'))
  },
  {
    id: 'catalog',
    label: 'Catálogo',
    short: 'Conectores',
    description: 'Conectores com herança e documentação viva',
    icon: Network,
    group: 'work',
    key: 3,
    phase: 5,
    component: lazy(() => import('../modules/connectors/ConnectorsModule'))
  },
  {
    id: 'flows',
    label: 'Flow Studio',
    short: 'Flow',
    description: 'Orquestração visual de fluxos',
    icon: Workflow,
    group: 'work',
    key: 2,
    phase: 6,
    component: lazy(() => import('../modules/flow-studio/FlowStudioModule'))
  },
  {
    id: 'scenarios',
    label: 'Cenários de teste',
    short: 'Tests',
    description: 'Cenários automatizados por ambiente',
    icon: FlaskConical,
    group: 'work',
    key: 5,
    phase: 4,
    component: lazy(() => import('../modules/tests/TestsModule'))
  },
  {
    id: 'history',
    label: 'Histórico',
    short: 'Histórico',
    description: 'Requisições e execuções gravadas, para reabrir e reproduzir',
    icon: History,
    group: 'work',
    key: 9,
    phase: 1,
    component: lazy(() => import('../modules/history/HistoryModule'))
  },
  {
    id: 'git',
    label: 'Git Workspace',
    short: 'Git',
    description: 'Controle de versão com segredos redigidos',
    icon: GitBranch,
    group: 'project',
    key: 6,
    phase: 2,
    component: lazy(() => import('../modules/git/GitModule'))
  },
  {
    id: 'secrets',
    label: 'Secrets',
    short: 'Secrets',
    description: 'Ambientes, variáveis e segredos, sem expor valores',
    icon: KeyRound,
    group: 'project',
    key: 4,
    phase: 3,
    component: lazy(() => import('../modules/secrets/SecretsModule'))
  },
  {
    id: 'docs',
    label: 'Documentação',
    short: 'Docs',
    description: 'Documentação viva do projeto, de cada conector e endpoint, em .md e PDF',
    icon: BookOpen,
    group: 'project',
    phase: 5,
    component: lazy(() => import('../modules/docs/DocsModule'))
  },
  {
    id: 'import-export',
    label: 'Importar e exportar',
    short: 'Importar',
    description: 'Pacotes do VVPost e coleções do Postman',
    icon: FileDown,
    group: 'project',
    key: 8,
    phase: 1,
    component: lazy(() => import('./ImportExportPanel'))
  },
  {
    id: 'mcp',
    label: 'MCP & IA',
    short: 'MCP',
    description: 'Servidor MCP para Claude Code, Cursor e Copilot, e as alterações da IA para revisar',
    icon: Bot,
    group: 'integrations',
    phase: 7,
    component: lazy(() => import('../modules/mcp/McpModule'))
  },
  {
    id: 'extensions',
    label: 'Extensions Hub',
    short: 'Plugins',
    description: 'Plugins e extensões',
    icon: Puzzle,
    group: 'integrations',
    key: 7,
    phase: 8,
    component: lazy(() => import('../modules/extensions/ExtensionsModule'))
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    short: 'Webhooks',
    description: 'Servidor local que recebe, inspeciona e dispara fluxos e cenários',
    icon: Webhook,
    group: 'integrations',
    key: 0,
    phase: 11,
    component: lazy(() => import('../modules/webhooks/WebhooksModule'))
  },
  {
    id: 'settings',
    label: 'Configurações',
    short: 'Config.',
    description: 'Conta, serviços locais, interface e estudo de usabilidade',
    icon: Settings,
    group: 'integrations',
    phase: 1,
    component: lazy(() => import('../modules/settings/SettingsModule'))
  }
]
