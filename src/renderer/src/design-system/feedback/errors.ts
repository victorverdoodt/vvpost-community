/** Categoria do erro no padrão da spec. */
export type ErrorCategory =
  | 'Configuração'
  | 'Autenticação'
  | 'Rede'
  | 'Política'
  | 'Resposta'
  | 'Expressão'
  | 'Plugin'
  | 'Python'
  | 'Requisição'
  | 'Cancelado'
  | 'Preparação'
  | 'Git'
  | 'Schema'
  | 'MCP'

export interface ErrorDescription {
  category: ErrorCategory
  /** danger: não executou ou falhou; neutral: o usuário cancelou. */
  tone: 'danger' | 'neutral'
  /** Próxima ação, uma frase. */
  hint: string
}

const BY_CODE: Record<string, ErrorDescription> = {
  CONFIG_ERROR: {
    category: 'Configuração',
    tone: 'danger',
    hint: 'Confira o ambiente escolhido e as variáveis e segredos pendentes em Secrets.'
  },
  AUTH_FAILED: {
    category: 'Autenticação',
    tone: 'danger',
    hint: 'Confira as credenciais do conector no ambiente e renove o token.'
  },
  POLICY_DENIED: {
    category: 'Política',
    tone: 'danger',
    hint: 'A política do projeto bloqueou a chamada; ajuste a política ou rode pelo app.'
  },
  PREPARE_FAILED: {
    category: 'Preparação',
    tone: 'danger',
    hint: 'O fluxo de preparação parou antes da requisição; abra o fluxo no Flow Studio e veja o nó que falhou.'
  },
  INVALID_URL: {
    category: 'Requisição',
    tone: 'danger',
    hint: 'Corrija a URL; variáveis {{VAR}} precisam de um ambiente.'
  },
  INVALID_REQUEST: { category: 'Requisição', tone: 'danger', hint: 'Revise método, headers e corpo da requisição.' },
  TIMEOUT: {
    category: 'Rede',
    tone: 'danger',
    hint: 'O servidor não respondeu a tempo; confira se ele está no ar ou aumente o timeout.'
  },
  CONNECTION_REFUSED: {
    category: 'Rede',
    tone: 'danger',
    hint: 'Nada respondeu nesse endereço; confira a URL base e se o serviço está no ar.'
  },
  DNS_FAILURE: {
    category: 'Rede',
    tone: 'danger',
    hint: 'O nome do host não foi encontrado; confira a URL base do ambiente.'
  },
  TLS_FAILURE: {
    category: 'Rede',
    tone: 'danger',
    hint: 'O certificado foi recusado; confira o host e o mTLS do conector.'
  },
  NETWORK_ERROR: { category: 'Rede', tone: 'danger', hint: 'Confira a conexão, o proxy e a URL base.' },
  ABORTED: { category: 'Cancelado', tone: 'neutral', hint: 'A execução foi cancelada; rode de novo quando quiser.' },
  HTTP_STATUS: {
    category: 'Resposta',
    tone: 'danger',
    hint: 'O servidor respondeu com erro; veja o corpo da resposta no nó.'
  },
  EXPRESSION_ERROR: {
    category: 'Expressão',
    tone: 'danger',
    hint: 'Uma referência {{ $nodes... }} não foi resolvida; confira o nome do nó e o caminho.'
  },
  PYTHON_NOT_FOUND: {
    category: 'Python',
    tone: 'danger',
    hint: 'Instale o Python 3 ou ajuste o caminho nas configurações.'
  },
  PYTHON_ERROR: { category: 'Python', tone: 'danger', hint: 'O script falhou; veja os logs do nó.' },
  PLUGIN_UNAVAILABLE: { category: 'Plugin', tone: 'danger', hint: 'Instale ou ligue o plugin no Extensions Hub.' },
  PLUGIN_ERROR: { category: 'Plugin', tone: 'danger', hint: 'O plugin devolveu um erro; veja a mensagem e os logs.' },
  PLUGIN_CRASHED: {
    category: 'Plugin',
    tone: 'danger',
    hint: 'O plugin caiu; rode de novo ou desligue-o no Extensions Hub.'
  },
  SCRIPT_ERROR: {
    category: 'Preparação',
    tone: 'danger',
    hint: 'Um script pre-request falhou e a requisição não saiu; veja a mensagem e os logs na aba Scripts.'
  },
  ASSERTION_FAILED: {
    category: 'Resposta',
    tone: 'danger',
    hint: 'A asserção do fluxo não valeu; veja o valor recebido no nó.'
  },
  DEPENDENCY_FAILED: {
    category: 'Resposta',
    tone: 'danger',
    hint: 'Um cenário de dependsOn não passou; corrija-o primeiro.'
  },
  POLL_TIMEOUT: {
    category: 'Resposta',
    tone: 'danger',
    hint: 'A condição do polling não valeu a tempo; veja a última resposta ou aumente o tempo limite.'
  },
  WEBHOOK_TIMEOUT: {
    category: 'Resposta',
    tone: 'danger',
    hint: 'O evento não chegou a tempo; veja no módulo Webhooks o que chegou e confira o caminho, o hook e a condição do nó.'
  },
  GIT_ERROR: {
    category: 'Git',
    tone: 'danger',
    hint: 'Confira o remoto, as credenciais do Git e se há merge em andamento; a causa acima vem do próprio git.'
  },
  SCHEMA_INVALID: {
    category: 'Schema',
    tone: 'danger',
    hint: 'Corrija o arquivo para o JSON Schema v1 (o MCP mostra o schema em get_schema); até lá, ele fica fora do workspace.'
  },
  MCP_ERROR: {
    category: 'MCP',
    tone: 'danger',
    hint: 'Confira se outra instância do VVPost já usa a porta do servidor MCP e ligue de novo.'
  },
  RUNNER_ERROR: {
    category: 'Configuração',
    tone: 'danger',
    hint: 'O runner não terminou a execução; veja a saída do CLI no runner e os segredos que ele precisa resolver.'
  },
  RUNNER_LOST: {
    category: 'Rede',
    tone: 'danger',
    hint: 'O runner parou de responder ao Control Plane no meio da execução; rode de novo.'
  },
  WEBHOOK_UNAVAILABLE: {
    category: 'Configuração',
    tone: 'danger',
    hint: 'O servidor de webhooks não está ligado; ligue-o na barra de status ou libere a porta 4480.'
  }
}

/** Categoria, tom e próxima ação para um código de erro do motor. Código desconhecido vira um erro genérico. */
export function describeError(code: string): ErrorDescription {
  return BY_CODE[code] ?? { category: 'Requisição', tone: 'danger', hint: 'Veja a mensagem acima e tente de novo.' }
}

/**
 * Por que um teste não passou, cada um com a sua aparência: a
 * asserção não valeu (a API respondeu), a rede não entregou, o projeto está mal configurado
 * (ambiente, segredo, conector, auth) ou a política bloqueou.
 */
export type FailureKind = 'assertion' | 'transport' | 'config' | 'policy' | 'canceled'

export const FAILURE_LABEL: Record<FailureKind, string> = {
  assertion: 'Falha de asserção',
  transport: 'Falha de transporte',
  config: 'Erro de configuração',
  policy: 'Bloqueio de política',
  canceled: 'Cancelado'
}

/** Texto curto da célula da matriz para quem não chegou a ter resposta. */
export const FAILURE_SHORT: Record<FailureKind, string> = {
  assertion: 'asserção',
  transport: 'rede',
  config: 'config',
  policy: 'política',
  canceled: 'cancelado'
}

/** O tipo de falha de um código de erro do motor; sem código, a asserção falhou. */
export function failureKind(code?: string | null): FailureKind {
  if (!code || code === 'ASSERTION_FAILED') return 'assertion'
  const { category } = describeError(code)
  if (category === 'Rede') return 'transport'
  if (category === 'Política') return 'policy'
  if (category === 'Cancelado') return 'canceled'
  return 'config'
}
