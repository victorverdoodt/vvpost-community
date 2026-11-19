import { describe, expect, it } from 'vitest'
import { splitFlowchart } from '@vvpost/core/docs/mermaid-split'

// Um fluxograma alto com etapas (subgraphs) vira um diagrama por etapa no PDF, em vez de ser
// cortado entre páginas.
const steps = `flowchart TD
  subgraph LER["1. Ler"]
    A["Arquivo"] --> B{"Tipo"}
    B -->|"xlsx"| C["ClosedXML"]
  end
  subgraph CAB["2. Cabeçalho"]
    C --> E["Achar a linha --> com seta no rótulo"]
    E --> F(["Pronto"])
  end
  classDef ouro fill:#f2a900
  class C,F ouro
  linkStyle 0 stroke:#000`

describe('divisão de fluxograma em etapas para o PDF', () => {
  it('cada subgraph vira um diagrama, com pontas para o que vem de outra etapa', () => {
    const parts = splitFlowchart(steps)!
    expect(parts.map((p) => p.title)).toEqual(['1. Ler', '2. Cabeçalho'])
    const [first, second] = parts as unknown as [{ source: string }, { source: string }]
    // A etapa 1 diz que C segue na etapa 2.
    expect(first.source).toMatch(/C -\.-> vvNext_C_1/)
    expect(first.source).toContain('segue em: 2. Cabeçalho')
    expect(first.source).toContain('class C ouro')
    expect(first.source).not.toContain('linkStyle')
    // A etapa 2 mostra C como ponta, com o rótulo e a etapa de origem, e não cria nó solto.
    expect(second.source).toContain('C(["ClosedXML · 1. Ler"]):::vvStep')
    expect(second.source).toContain('class C,F ouro')
    expect(second.source).not.toMatch(/\bA\b/)
    expect(second.source.startsWith('flowchart TD')).toBe(true)
  })

  it('não divide o que perderia informação', () => {
    expect(splitFlowchart('sequenceDiagram\n  A->>B: oi')).toBeNull()
    // Um nó fora das etapas não tem para onde ir.
    expect(splitFlowchart(`flowchart TD\n  X --> Y\n  subgraph S1["a"]\n    A --> B\n  end\n  subgraph S2["b"]\n    B --> C\n  end`)).toBeNull()
    // Uma etapa só não é divisão.
    expect(splitFlowchart(`flowchart TD\n  subgraph S1["a"]\n    A --> B\n  end`)).toBeNull()
  })
})
