# Git Workspace

O painel **Git Workspace** abre uma pasta (ou clona um repositório) e trata a pasta como o
workspace: conectores e ambientes em JSON, versionados com o Git. As operações usam o executável
`git` do sistema, então valem a configuração, as credenciais e as chaves SSH que
você já tem; sem credencial salva, o push falha com a mensagem do Git em vez de travar pedindo senha.

- Status com as mudanças, commit só dos arquivos marcados, troca e criação de branches (escolher
  uma branch remota cria a local rastreando), fetch, pull (só fast-forward) e push (sem upstream,
  publica no `origin`).
- Diff lado a lado entre o `HEAD` e o que vai para o commit. JSON é comparado já formatado, então
  só mudanças de conteúdo aparecem. Cada arquivo aberto (diff ou conflito) fica numa aba, como no
  Flow Studio: setas trocam de aba, Delete ou o botão do meio fecha, e o botão direito fecha as
  outras ou todas. Um arquivo commitado ou descartado sai das abas sozinho.
- Redação automática no commit: se um ambiente (`environments/*.env.json`) tem uma variável
  `isSecret: true` com valor em texto puro, o valor vai para o [cofre local](security-model.md#cofre-local) e o
  arquivo é reescrito com `__REQUIRED_SECRET__` antes do commit. O painel marca esses arquivos
  ("redige N") e o diff já mostra a versão redigida. O arquivo de segredos entra no `.gitignore`
  (que vai junto no commit quando muda) e nunca pode ser commitado; se ele já estiver versionado,
  o painel avisa.
- Commits fora do app: "Conferir segredos também nos commits fora do app", no menu do Git, instala
  um hook de pre-commit (o mesmo de `vvpost guard --install`, [CLI](cli.md)). Um commit do
  terminal ou da IDE passa pela mesma conferência do commit pelo app e é recusado se levar um
  valor do vault, uma credencial literal ou uma chave privada.
- Wizard de onboarding: logo depois do clone, os segredos que os ambientes esperam e ainda não têm
  valor nesta máquina são pedidos, um passo por ambiente, com a descrição e o placeholder do
  schema. Ao abrir um workspace com pendências, uma faixa no painel oferece o mesmo wizard. Os valores vão direto para o arquivo local e nunca voltam ao renderer.

O módulo do Git e o painel são carregados só quando a aba é aberta. A última pasta aberta fica
em `<userData>/workspace.json`.

## Projetos

Um workspace (a pasta aberta, em geral um repositório Git) pode ter vários projetos. Cada projeto
é uma subpasta direta do workspace com um `vvpost.project.json`:

```json
{ "$schema": "https://vvpost.dev/schemas/v1/project.json", "id": "estoque", "name": "Estoque", "description": "Consultas de produtos e de fornecedores" }
```

```
workspace/
  flows/auth.flow.vvpost.json        ← Compartilhado: a auth que os projetos usam
  environments/dev.env.json          ← Compartilhado: ambientes de todos os projetos
  estoque/
    vvpost.project.json
    flows/cnpj.flow.vvpost.json      ← "extends": "auth"
    flows/veiculos.flow.vvpost.json  ← "extends": "auth"
    environments/dev.env.json        ← complementa o dev do Compartilhado
  cobranca/
    vvpost.project.json
    flows/cnpj.validar.flow.vvpost.json  ← "extends": "estoque:cnpj"
```

- **Compartilhado.** O que fica fora de qualquer projeto vale em todos. Dentro de um projeto, os
  conectores e fluxos-base do Compartilhado são só leitura e não podem ser sobrepostos: um arquivo
  do projeto com o mesmo id fica de fora, com aviso. Para editar, abra a raiz do workspace.
- **Ids por projeto.** Cada projeto tem os próprios ids, e o mesmo id pode existir em dois
  projetos. `"extends": "<projeto>:<id>"` herda a base de outro projeto, que entra só para leitura
  com a cadeia dela. O conector de um nó (`request.connector` ou `plugin.connector`) aceita o
  mesmo `<projeto>:<id>`. No Flow Studio, a escolha do conector do nó lista as bases dos outros
  projetos num grupo por projeto, e o fluxo roda com a base escolhida antes mesmo de ser gravado. Uma referência a um projeto que não existe, a uma base que não existe ou em
  ciclo entre projetos vira aviso no arquivo que a fez.
- **Ambientes e segredos.** Os ambientes do Compartilhado valem nos projetos. Um ambiente do
  projeto com o mesmo id acrescenta variáveis ou troca o valor delas, e o projeto vence. Os
  segredos locais da raiz valem nos projetos, e os do projeto (no [cofre local](security-model.md#cofre-local),
  um por pasta) complementam os da raiz.
- **Workspace sem projetos.** Um workspace sem nenhum `vvpost.project.json` é um projeto só.

No CLI, uma pasta de dentro de um projeto vale o projeto, como o Git acha o repositório. Ali,
`--project <id>` ou `$VVPOST_PROJECT` escolhem outro projeto, e `vvpost projects` lista os
projetos ([cli.md](cli.md)). No MCP, `list_projects` lista os projetos e toda ferramenta aceita
`project` ([mcp.md](mcp.md)).

No app, abrir a pasta de um projeto abre o workspace inteiro com aquele projeto escolhido: o Git e
o estado do repositório continuam os da raiz, e o explorador, as abas, o Quick Request e o Flow
Studio mostram o projeto. Num workspace com projetos, a barra superior ganha o seletor de projeto,
ao lado da pasta. Ele troca entre os projetos, abre o **Compartilhado (raiz)** para editar o que
todos herdam, e cria um projeto novo com **Novo projeto…** (a subpasta e o `vvpost.project.json`,
já aberta). A paleta (`Ctrl+K`) tem os mesmos comandos: "Trocar de projeto do workspace…" e "Novo
projeto no workspace…". O projeto escolhido fica lembrado para a próxima abertura. Ao trocar de
projeto, o módulo Documentação aberto passa a mostrar o projeto novo, e as abas de arquivo do
anterior (documentos, diagramas, conectores) fecham, menos as com mudanças não salvas. No explorador,
o que vem do Compartilhado ou de outro projeto aparece marcado como compartilhado e abre só para
leitura. Só aparecem as bases que algum conector do projeto herda; as outras ficam atrás de
"Mostrar N do Compartilhado sem uso aqui", no fim de Conectores (o filtro procura em todas). O
seletor mostra o nome inteiro do projeto, e a pasta do workspace cede espaço antes dele.

### Projeto de referência

O front e o app que consomem uma API de outro repositório consultam o catálogo dela pelo MCP com um
projeto de referência: um `vvpost.project.json` com `reference`, numa pasta sem mais nada.

```json
{
  "id": "loja",
  "name": "API da Loja",
  "reference": { "workspace": "../../../loja-backend/vvpost", "openapi": "../../api/loja.json" }
}
```

Os caminhos são relativos à pasta do projeto, e vale a primeira fonte que existir:

- **`workspace`:** a pasta do VVPost do repositório da API, quando ele está clonado ao lado. Entra o
  catálogo inteiro, com fluxos, cenários, ambientes e schemas.
- **`openapi`:** a spec da API (JSON ou YAML), em geral a cópia que o repositório já mantém para
  gerar o cliente. Ela vira o catálogo pelo [import do OpenAPI](import-export.md), com as rotas e os
  schemas, numa pasta temporária por conteúdo: a mesma spec não é convertida de novo. É o que vale
  numa máquina com um repositório só, como o job do VVBuilder.

No MCP, `project: "<id>"` lê de lá (`get_api_catalog`, `get_source`, `validate_body`), e toda escrita é
recusada com `BLOCKED`: a mudança vai no repositório da API.
`list_projects` e `vvpost projects` mostram a referência. Sem nenhuma fonte, a chamada responde
`UNKNOWN_PROJECT` dizendo o que foi procurado.
