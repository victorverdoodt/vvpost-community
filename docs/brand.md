# Marca e produto: o contrato do frontend

O backoffice e o app são os consumidores das APIs que o VVPost documenta, e o mesmo agente que muda
a rota muda a tela. Por isso o projeto pode guardar também o contrato visual: as cores, as fontes e
os espaçamentos que a tela tem que seguir. Ele segue as mesmas três propriedades do resto da
documentação:

- **Cita em vez de copiar.** Os tokens ficam num arquivo só, e as páginas mostram os valores com
  `{{> tokens}}` e `{{> contrast}}`.
- **Roda.** O `vvpost lint` confere os tokens (formato e contraste) e o código do frontend contra
  eles: tema que divergiu, cor e fonte escritas à mão.
- **Acompanha o código.** O agente lê a marca com `get_brand` antes de mexer na tela, e os achados
  voltam no `lint` de cada escrita.

Fica de fora: catálogo de componentes com preview, editor visual de tokens e sincronização com o
Figma. Regras de componentes e tom de voz vão como texto numa página (`docs/marca.md`).

## O arquivo de tokens

`brand/<nome>.tokens.json` no projeto (ou na raiz do workspace, valendo para todos os projetos sem
um próprio), no formato do [W3C Design Tokens Community Group](https://www.designtokens.org/tr/drafts/format/)
(DTCG). É o formato que o Style Dictionary, o Tokens Studio e a exportação de variáveis do Figma já
falam: o time pode gerar CSS ou temas a partir do mesmo arquivo com essas ferramentas.

```json
{
  "color": {
    "$type": "color",
    "primary": { "$value": "#bd948a", "$description": "Rosé da clínica: botões e destaques" },
    "on-primary": { "$value": "#ffffff" },
    "link": { "$value": "{color.primary}" }
  },
  "font": { "ui": { "$type": "fontFamily", "$value": ["Quicksand", "sans-serif"] } },
  "space": { "2": { "$type": "dimension", "$value": { "value": 8, "unit": "px" } } },
  "$extensions": {
    "vvpost": {
      "modes": { "dark": { "color.primary": "#d4b6b2" } },
      "contrast": [{ "fg": "color.on-primary", "bg": "color.primary", "min": 4.5 }],
      "code": { "color.primary": ["palette.primary.main", "--primary"] },
      "sources": ["../app/**/*.{ts,tsx,css}"],
      "ignore": ["../app/**/*.test.tsx"]
    }
  }
}
```

O que o VVPost lê do DTCG:

- Grupos aninhados; o token é o objeto com `$value`. O `$type` vem do token ou do grupo mais
  próximo; um alias sem tipo herda o do token para onde aponta.
- Alias `{grupo.token}`, inclusive dentro de valores compostos. Alias quebrado e ciclo são erro.
- Tipos conferidos: `color` (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` ou o objeto
  `{ "colorSpace": "srgb", "components": [r, g, b], "alpha": 1 }`), `dimension` (`{ "value", "unit" }`
  em `px`, `rem` ou `em`, ou o texto `8px`), `fontFamily`, `fontWeight`, `number` e `duration`. Os
  outros tipos do DTCG (`shadow`, `typography`, `border`...) são aceitos e só têm os alias conferidos.

O que o DTCG não cobre fica em `$extensions.vvpost`, que as outras ferramentas ignoram:

| Chave | O que faz |
| --- | --- |
| `modes` | Valores por modo, pelo nome do token: `{ "light": { "color.bg": "#f6f7f9" } }`. O valor de `$value` é o modo padrão (`base`). |
| `contrast` | Pares que precisam de contraste: `{ "fg", "bg", "min" }` (ou `[fg, bg, min]`), com `min` de 4,5 por padrão (WCAG AA para texto). Conferidos em cada modo. |
| `code` | Onde cada token vive no código: `--nome` é uma variável CSS; o resto é um caminho no objeto do `createTheme` do MUI (`palette.primary.main`). |
| `sources` | Os arquivos do frontend que o lint confere, em globs relativos ao projeto. Podem subir até a raiz do repositório Git (`../app/**`), nunca além. |
| `ignore` | Globs que ficam de fora. `node_modules`, `dist`, `out`, `build`, `.next`, `gen`, `vendor`, `bin`, `obj`, pastas que começam com ponto e arquivos `.min.js`/`.min.css` já ficam. |

## O que o lint confere

As regras entram no `vvpost:recommended` ([lint](lint.md)), então aparecem no painel Lint do app, no
`vvpost lint` e no `vvpost validate --lint` do CI e no `lint` de cada escrita do MCP. O ruleset do
time pode desligar ou trocar a severidade de cada uma.

| Regra | Severidade | O que pega |
| --- | --- | --- |
| `tokens-invalid` | erro | O arquivo fora do formato, alias quebrado, ciclo, tipo ou valor inválido, `$extensions.vvpost` malformado. |
| `tokens-contrast` | erro | Par de `contrast` abaixo do mínimo num modo. O `hint` diz como passar: o texto em preto ou branco, ou o fundo mais escuro ou mais claro. Se a cor é da marca do cliente, a escolha é dele. |
| `brand-code-drift` | erro | Uma variável CSS ou chave do `createTheme` mapeada em `code` com valor diferente do token (em qualquer modo). |
| `brand-hardcoded-color` | aviso | Cor escrita à mão que é o valor de um token: o `hint` diz o token e como usá-lo (`var(--accent)`, `theme.palette.primary.main`). |
| `brand-unknown-color` | aviso | Cor escrita à mão que não é da marca: o `hint` diz o token mais próximo (e se é quase igual). Preto e branco translúcidos (sombras e véus) não contam. |
| `brand-font` | aviso | `font-family` (CSS) ou `fontFamily` (JS) cuja primeira fonte não está nos tokens. Valores com `var(...)` não são conferidos. |

A leitura do código é de texto e de CSS, sem entender JSX nem Razor a fundo: o objetivo é pegar o
literal solto e o tema que divergiu, não validar a tela. As definições de variáveis CSS e o objeto do
`createTheme` não contam como cor solta (são a definição); comentários e âncoras de link
(`href="#bad"`) também não. Até 3000 arquivos de até 512 KB por projeto.

Para regras próprias, o documento do lint tem `$.tokens[*]` (os tokens resolvidos) e `$.brand[*]`
(os achados). Por exemplo, toda cor com a descrição de uso:

```yaml
extends: [vvpost:recommended]
rules:
  cor-com-uso:
    description: Toda cor da marca diz onde se usa
    severity: warn
    given: "$.tokens[?(@.type == 'color')]"
    then: { field: description, function: truthy }
```

## Nas páginas

| Diretiva | O que mostra |
| --- | --- |
| `{{> tokens}}` | Todos os tokens: nome, tipo, valor, valor em cada modo e descrição. |
| `{{> tokens color}}` | Só os tokens de um grupo. |
| `{{> contrast}}` | Os pares de contraste em cada modo, com a razão WCAG e se passam. |

A página da marca (`docs/marca.md`) junta as tabelas com o que não é token: o uso de cada cor, o tom
de voz, as regras de componentes.

## Para o agente

`get_brand` no [MCP](mcp.md) devolve os tokens resolvidos numa linha por token, com o uso no código:

```text
color.primary=#bd948a (theme.palette.primary.main | theme.palette.secondary.dark)
color.on-primary=#ffffff
font.ui=Quicksand, sans-serif
```

Os parâmetros são `mode` (um dos modos), `group` (só um grupo) e `withDescriptions` (a `$description`
de cada token). A marca inteira da família VV (28 tokens) cabe em uns 150 tokens do modelo; ler o CSS
de onde ela saiu custaria uns 4.500. O trecho que o VVPost instala no `AGENTS.md`/`CLAUDE.md` pede ao
agente para chamar `get_brand` antes de mexer no frontend e corrigir os achados `brand-*` e
`tokens-*` na mesma mudança.
