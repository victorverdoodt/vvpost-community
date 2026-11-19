# A OpenAPI do código como fonte do contrato

Em muitos times, a spec OpenAPI é gerada a partir do código (springdoc, Swashbuckle, FastAPI, NestJS,
tsoa, `go-swagger`...). Para esses times a spec já é o contrato, e manter os mesmos endpoints à mão
num segundo lugar não faz sentido. O `vvpost sync` resolve isso: o projeto do VVPost fica vinculado à
spec do código, e o VVPost guarda só o que a spec não tem.

| Vem da spec (o código manda) | Fica no VVPost (o sync não toca) |
| --- | --- |
| Endpoints que existem e os que saem | Cenários de teste e asserções |
| Nome, descrição, método, caminho, headers, query, `bodySchema` e corpo de exemplo de cada endpoint | Exemplos de resposta (o mock server) e scripts |
| Schemas compartilhados que vieram da spec (`schemas/*.schema.json` com `x-vvpost`) | Config do conector: `baseUrl`, auth, headers, TLS (o que muda por ambiente) |
| | Ambientes, variáveis e segredos |
| | Fluxos, documento do projeto, páginas, diagramas e o `.md` dos conectores |

Um endpoint feito no VVPost que a spec não tem (um `/health` interno, por exemplo) também fica, e o
relatório o lista em "só no VVPost".

## Adotar em três passos

1. **Gere a spec num lugar fixo.** Um arquivo versionado (`openapi.yaml` no repositório, gerado pelo
   build) ou uma URL que o serviço expõe (`http://localhost:8080/v3/api-docs`). Para o time todo
   usar o mesmo vínculo, prefira um arquivo dentro da pasta do projeto do VVPost ou uma URL: um caminho
   fora da pasta fica absoluto e só vale numa máquina.

2. **Vincule o projeto à spec.** Num projeto novo, importe a spec: o conector raiz já nasce vinculado.

   ```bash
   vvpost import ./openapi.yaml --workspace ./apis
   ```

   Num projeto que já existe, feito à mão ou vindo do Postman, vincule o conector:

   ```bash
   vvpost sync --link ./openapi.yaml --connector pagamentos --workspace ./apis
   ```

   Cada endpoint que tem o método e o caminho de uma operação da spec passa a segui-la, mantendo o
   id, os cenários e os exemplos (o nome dos parâmetros não importa: `/pets/{id}` é
   `/pets/{petId}`). As operações que o projeto não tinha entram nos conectores das tags dela. Rode
   antes com `--dry-run` para ver o plano.

3. **Ponha o `--check` no CI** do repositório do código, depois do passo que gera a spec:

   ```yaml
   # GitHub Actions
   - run: ./gradlew generateOpenApiDocs          # ou o gerador do seu framework
   - run: npx vvpost sync --check --workspace ./apis
   ```

   O job falha quando o VVPost difere da spec. Quem mudou a API roda `vvpost sync`, confere o que
   quebrou e comita junto o código e o projeto do VVPost. Para falhar só quando algo quebra (e
   aceitar endpoint novo ou descrição alterada sem sync), use `--fail-on breaking`.

Com um agente de IA no repositório (`vvpost connect`), a regra do VVPost já pede para ele manter o
projeto em dia: depois de mudar a API e regerar a spec, ele chama a ferramenta MCP `sync_openapi`.

## O que o sync faz

`vvpost sync` relê a spec de cada conector vinculado (`source.location`) e aplica o que mudou, num
lote só, pela mesma camada de escrita do app e do MCP. Rodar de novo sem mudança na spec não grava
nada; só a `info.version` mudar também não regrava o conector.

| Situação | No relatório | O sync |
| --- | --- | --- |
| Operação nova na spec | `novo` | Cria o endpoint no conector da tag. |
| Mudou na spec | `mudou na spec` | Aplica a spec nos campos de contrato. |
| Mudou na spec e foi editada no VVPost | `conflito` | A spec ganha (com `--keep-edits`, fica a edição). |
| Campo de contrato editado no VVPost, sem mudança na spec | `editado aqui` | Volta à spec (com `--keep-edits`, fica e não conta como drift). |
| Endpoint feito à mão com o método e o caminho de uma operação | `vinculado` | Passa a seguir a operação, sem duplicar. |
| Saiu da spec | `saiu da spec` | Fica, e conta como drift até `--prune` apagar. |

A marca de dado pessoal (`x-sensitive`, [modelo de segurança](security-model.md)) é exceção: a que o
time põe num campo de um schema que veio da spec fica, mesmo com a spec ganhando, e não conta como
edição; a que a spec traz entra.

A regra "a spec ganha" vale para os campos de contrato. Para mudar o contrato, mude o código. O que
o time acrescenta por fora (um header de tenant, uma auth) vai na config do conector ou no ambiente,
que o sync não toca.

## O relatório de drift

Para cada spec, o relatório mostra os endpoints que diferem, com os campos (`name`, `path`,
`bodySchema`...), os schemas, o que depende de um endpoint que saiu da spec (os cenários dele, os
fluxos que o chamam e os documentos que o citam com `{{> endpoint ...}}`) e as **quebras**: o
workspace é validado como está e como ficaria depois do sync, e o que só aparece depois é quebra.
Por exemplo, um campo obrigatório novo deixa o corpo de um cenário fora do `bodySchema`, um
parâmetro renomeado deixa o `pathParams` de um cenário sem destino, ou uma diretiva do documento
do projeto fica sem alvo. Um endpoint público (`requiresAuth: false`) que a spec passou a proteger
também é quebra: quem chamava sem credencial passa a receber 401/403.

```text
$ vvpost sync --check
pagamentos ← openapi.yaml (2.4.0)
  mudou na spec POST /cobrancas                pagamentos.cobrancas/criar: bodySchema, body (a spec ganha)
  saiu da spec  DELETE /cobrancas/{id}         pagamentos.cobrancas/cancelar (fica; --prune apaga) · depende dele: cenário cancela, fluxo estorno
  schema        Cobranca (mudou na spec)
  quebra        flows/pagamentos.cobrancas/criar.flow.vvpost.json: criar: cenário: valor alto fora do bodySchema (/moeda: campo obrigatório ausente)
  Drift: 3 diferença(s) com a spec; vvpost sync aplica
```

`--json -` devolve o mesmo relatório em JSON (`results[].endpoints`, `schemas`, `breaks`, `drift`,
`breaking`, `changes`), para outras ferramentas.

## Opções

| Opção | O que faz |
| --- | --- |
| `--check` | Não grava. Sai com 1 se houver drift e com 2 se a spec não der para ler. |
| `--fail-on breaking` | Com `--check`: sai com 1 só se houver quebra, ou um endpoint removido de que algo depende. |
| `--connector <id>` | Só a spec deste conector (repetível). Sem ela, todas as specs vinculadas do projeto. |
| `--link <arquivo \| URL>` | Vincula `--connector` à spec e sincroniza. |
| `--prune` | Apaga os endpoints que saíram da spec, com os cenários deles. |
| `--keep-edits` | Conflito e edição local ficam com a versão do VVPost. |
| `--dry-run` | Mostra o que mudaria, sem gravar e sem falhar. |
| `--json -` | Relatório em JSON. |

No app, **Reimportar a spec** no Catálogo usa o mesmo plano, mas deixa cada escolha para a revisão
(o conflito mantém a versão do projeto por padrão), e mostra os endpoints vinculados e os editados
ali ([Reimportar a spec](import-export.md#reimportar-a-spec)). No MCP, `sync_openapi` relata sem
`apply` e grava com `apply: true`, com `link`, `prune` e `keepEdits` como no CLI
([Servidor MCP](mcp.md#ferramentas)).

## Limites

- Só OpenAPI 3.x e Swagger 2.0. GraphQL, gRPC e AsyncAPI continuam pelo import e pelos plugins.
- A adoção de endpoints feitos à mão compara método e caminho do endpoint. Se o conector tem um
  `basePath` que a spec põe no caminho (ou o contrário), o endpoint não é achado e entra como novo;
  ajuste o `basePath` antes de vincular.
- O `baseUrl` e a auth da spec só entram quando o conector é criado pelo import; depois disso, são do
  VVPost.
