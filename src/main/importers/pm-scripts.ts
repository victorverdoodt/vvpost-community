/**
 * Tradução dos scripts do Postman (`pm.*`) para a API `vv` dos scripts por requisição (fase 13).
 * É uma troca de texto das formas comuns, não um parser de JavaScript: o que não tem equivalente
 * fica no script como está e volta em `unsupported`, para a revisão do importador avisar.
 */

export interface PmTranslation {
  code: string
  /** APIs do Postman que ficaram no script sem tradução (pm.sendRequest, pm.info...). */
  unsupported: string[]
}

/** Trocas em ordem: as formas mais longas antes das que são prefixo delas. */
const RULES: [RegExp, string][] = [
  // Asserções sobre a resposta inteira.
  [/\bpm\.response\.to\.have\.status\(/g, 'vv.expect(vv.response).to.have.status('],
  [/\bpm\.response\.to\.be\.ok\b/g, 'vv.expect(vv.response.code).to.be.within(200, 299)'],
  [/\bpm\.response\.to\.be\.success\b/g, 'vv.expect(vv.response.code).to.be.within(200, 299)'],
  [/\bpm\.response\.to\.be\.json\b/g, 'vv.expect(vv.response.json()).to.be.json'],
  [/\bpm\.response\.to\.have\.header\(/g, 'vv.expect(vv.response.headers).to.have.property('],
  [/\bpm\.response\.to\.have\.jsonBody\(\s*\)/g, 'vv.expect(vv.response.json()).to.be.json'],
  [/\bpm\.response\.to\.have\.body\(/g, 'vv.expect(vv.response.text()).to.equal('],
  // Resposta.
  [/\bpm\.response\.headers\.get\(/g, 'vv.response.header('],
  [/\bpm\.response\.headers\.has\(/g, 'undefined !== vv.response.header('],
  [/\bpm\.response\.json\(\)/g, 'vv.response.json()'],
  [/\bpm\.response\.text\(\)/g, 'vv.response.text()'],
  [/\bpm\.response\.code\b/g, 'vv.response.code'],
  [/\bpm\.response\.responseTime\b/g, 'vv.response.responseTime'],
  // Requisição.
  [/\bpm\.request\.headers\.(?:add|upsert)\(/g, 'vv.request.setHeader('],
  [/\bpm\.request\.addHeader\(/g, 'vv.request.setHeader('],
  [/\bpm\.request\.headers\.remove\(/g, 'vv.request.removeHeader('],
  [/\bpm\.request\.removeHeader\(/g, 'vv.request.removeHeader('],
  [/\bpm\.request\.headers\.get\(/g, 'vv.request.header('],
  [/\bpm\.request\.url\.toString\(\)/g, 'vv.request.url'],
  [/\bpm\.request\.url\b(?!\.)/g, 'vv.request.url'],
  [/\bpm\.request\.method\b/g, 'vv.request.method'],
  [/\bpm\.request\.body\.raw\b/g, 'vv.request.body'],
  // Variáveis: no VVPost os escopos do Postman são um só (ambiente + o que os scripts definem).
  [/\bpm\.(?:environment|variables|collectionVariables|globals|iterationData)\.(get|set|unset|has|toObject|replaceIn)\(/g, 'vv.variables.$1('],
  // Testes.
  [/\bpm\.test\(/g, 'vv.test('],
  [/\bpm\.expect\(/g, 'vv.expect('],
  // API antiga (postman.*, responseBody, responseCode).
  [/\bpostman\.(?:setEnvironmentVariable|setGlobalVariable)\(/g, 'vv.variables.set('],
  [/\bpostman\.(?:getEnvironmentVariable|getGlobalVariable)\(/g, 'vv.variables.get('],
  [/\bpostman\.(?:clearEnvironmentVariable|clearGlobalVariable)\(/g, 'vv.variables.unset('],
  [/\bresponseBody\b/g, 'vv.response.text()'],
  [/\bresponseCode\.code\b/g, 'vv.response.code'],
  [/(?<![.\w$])responseTime\b(?!\s*:)/g, 'vv.response.responseTime']
]

/** O que sobrou do Postman depois das trocas: `pm.algo.mais`, `postman.algo`, `tests[...]`. */
const LEFTOVER = /\bpm\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?|\bpostman\.[A-Za-z_$][\w$]*|\btests\s*\[|\brequire\(\s*['"][^'"]+['"]\s*\)/g

export function translatePmScript(source: string): PmTranslation {
  let code = source
  for (const [re, to] of RULES) code = code.replace(re, to)
  // vv.variables.replaceIn não existe: {{VAR}} já é resolvido pelo host no envio.
  code = code.replace(/\bvv\.variables\.replaceIn\(/g, 'String(')
  const unsupported = new Set<string>()
  for (const m of code.matchAll(LEFTOVER)) unsupported.add(m[0].replace(/\s+/g, '').replace(/\[$/, '[...]'))
  return { code, unsupported: [...unsupported].sort() }
}
