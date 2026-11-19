import { ConfigError } from '../connectors/errors'

/** Linhas de um arquivo de dados: cada uma é uma iteração do lote, com as colunas como variáveis. */
export interface DataRows {
  /** Nome do arquivo, para o relatório. */
  name?: string
  columns: string[]
  rows: Record<string, string>[]
}

/** Teto de iterações por lote: o arquivo de dados não é teste de carga. */
export const MAX_DATA_ROWS = 5000

/**
 * Lê um arquivo de dados como o Collection Runner do Postman: CSV com cabeçalho (vírgula ou
 * ponto e vírgula, aspas no padrão RFC 4180) ou JSON com uma lista de objetos. Valores que não
 * são texto no JSON (número, booleano, objeto) viram o texto JSON deles.
 */
export function parseDataFile(text: string, format: 'csv' | 'json', name?: string): DataRows {
  const source = text.replace(/^﻿/, '')
  const parsed = format === 'json' ? fromJson(source) : fromCsv(source)
  if (parsed.rows.length === 0) throw new ConfigError('o arquivo de dados não tem nenhuma linha')
  if (parsed.rows.length > MAX_DATA_ROWS) {
    throw new ConfigError(`o arquivo de dados tem ${parsed.rows.length} linhas; o máximo por execução é ${MAX_DATA_ROWS}`)
  }
  return { ...(name && { name }), ...parsed }
}

/** Formato pelo nome do arquivo; o que não for .json é lido como CSV. */
export const dataFormatOf = (fileName: string): 'csv' | 'json' => (/\.json$/i.test(fileName) ? 'json' : 'csv')

function fromJson(text: string): Omit<DataRows, 'name'> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new ConfigError(`o arquivo de dados não é um JSON válido: ${(err as Error).message}`)
  }
  if (!Array.isArray(value)) throw new ConfigError('o arquivo de dados em JSON precisa ser uma lista de objetos')
  const columns: string[] = []
  const rows = value.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConfigError(`a linha ${i + 1} do arquivo de dados não é um objeto`)
    }
    const row: Record<string, string> = {}
    for (const [key, v] of Object.entries(item)) {
      if (!columns.includes(key)) columns.push(key)
      row[key] = typeof v === 'string' ? v : v === null ? '' : JSON.stringify(v)
    }
    return row
  })
  return { columns, rows }
}

function fromCsv(text: string): Omit<DataRows, 'name'> {
  const delimiter = guessDelimiter(text)
  const records = splitCsv(text, delimiter).filter((r) => r.some((cell) => cell !== ''))
  const header = records.shift()
  if (!header) return { columns: [], rows: [] }
  const columns = header.map((c) => c.trim())
  const empty = columns.findIndex((c) => !c)
  if (empty >= 0) throw new ConfigError(`a coluna ${empty + 1} do cabeçalho do CSV está sem nome`)
  const repeated = columns.find((c, i) => columns.indexOf(c) !== i)
  if (repeated) throw new ConfigError(`a coluna "${repeated}" aparece duas vezes no cabeçalho do CSV`)
  const rows = records.map((record, i) => {
    if (record.length > columns.length) {
      throw new ConfigError(`a linha ${i + 2} do CSV tem ${record.length} valores e o cabeçalho, ${columns.length} colunas`)
    }
    return Object.fromEntries(columns.map((c, j) => [c, record[j] ?? '']))
  })
  return { columns, rows }
}

/** Ponto e vírgula (o CSV do Excel em português) quando aparece mais que a vírgula na primeira linha. */
function guessDelimiter(text: string): ',' | ';' | '\t' {
  const first = text.slice(0, text.search(/\r?\n|$/))
  const count = (ch: string) => first.split(ch).length - 1
  const [best] = ([',', ';', '\t'] as const).map((d) => [d, count(d)] as const).sort((a, b) => b[1] - a[1])
  return best && best[1] > 0 ? best[0] : ','
}

function splitCsv(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) {
      record.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      record.push(cell)
      records.push(record)
      record = []
      cell = ''
    } else cell += ch
  }
  if (quoted) throw new ConfigError('o CSV termina com aspas abertas')
  if (cell !== '' || record.length) {
    record.push(cell)
    records.push(record)
  }
  return records
}

/** Variáveis de uma iteração: {{coluna}}, {{$data.coluna}} e {{$iteration}} (a partir de 1). */
export function iterationValues(row: Record<string, string>, iteration: number): Record<string, string> {
  const out: Record<string, string> = { $iteration: String(iteration) }
  for (const [key, value] of Object.entries(row)) {
    out[key] = value
    out[`$data.${key}`] = value
  }
  return out
}
