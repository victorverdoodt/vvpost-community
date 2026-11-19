/** Valor gravado no lugar de todo segredo que vai para o disco ou para o Git. */
export const SECRET_PLACEHOLDER = '__REQUIRED_SECRET__'

/**
 * Vault local de segredos do workspace: os valores reais das variáveis
 * isSecret, fora do Git. Um objeto { [id do ambiente]: { [variável]: valor } }.
 */
export const SECRETS_FILE = '.vvpost/secrets.local.json'

/** Cabeçalhos cujo valor é sempre tratado como segredo (nome em minúsculas). */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-amz-security-token',
  'ocp-apim-subscription-key'
])

/** Nome de campo, header, parâmetro ou variável normalizado: minúsculas, sem - _ . e espaços. */
export const normalizeName = (name: string) => name.toLowerCase().replace(/[-_.\s]/g, '')

const SENSITIVE_NAMES = new Set(
  [
    ...SENSITIVE_HEADERS,
    'password',
    'passwd',
    'pwd',
    'pass',
    'secret',
    'token',
    'apikey',
    'credential',
    'credentials',
    'session',
    'sessionid',
    'sid',
    'jsessionid',
    'phpsessid',
    'signature',
    'sig',
    'otp',
    'totp',
    'mfa',
    'pin',
    'cvv',
    'cvc',
    'privatekey',
    'passphrase',
    'seed',
    'xamzsecuritytoken',
    'xamzcredential',
    'xamzsignature'
  ].map(normalizeName)
)
const SENSITIVE_SUFFIXES = ['key', 'password', 'passwd', 'secret', 'token', 'apikey', 'accesskey', 'secretkey', 'privatekey', 'subscriptionkey', 'passphrase', 'cookie', 'credential', 'credentials', 'sessionid', 'signature']

/** Terminam em "key" sem ser credencial. "key" sozinho também fica de fora: é genérico demais ({"key": "cor"}). */
const NOT_SENSITIVE = new Set([
  'key',
  'idempotencykey',
  'publickey',
  'primarykey',
  'foreignkey',
  'sortkey',
  'partitionkey',
  'cachekey',
  // Chaves de dados (mapeamento, roteamento, deduplicação), comuns em contratos de API.
  'domainkey',
  'routingkey',
  'objectkey',
  'businesskey',
  'naturalkey',
  'compositekey',
  'surrogatekey',
  'lookupkey',
  'deduplicationkey',
  'hotkey',
  'monkey',
  'turkey',
  'hockey',
  'jockey'
])

/** Header que leva credencial (Authorization, Cookie, X-Api-Key...): o que um envio sem credencial não manda. */
export function isCredentialHeader(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return (SENSITIVE_HEADERS.has(lower) && lower !== 'set-cookie') || isSensitiveName(lower)
}

/** Nome que, em header, campo JSON, parâmetro de query ou variável, guarda credencial. */
export function isSensitiveName(name: string): boolean {
  const n = normalizeName(name)
  if (NOT_SENSITIVE.has(n)) return false
  return SENSITIVE_NAMES.has(n) || SENSITIVE_SUFFIXES.some((s) => n.endsWith(s))
}
