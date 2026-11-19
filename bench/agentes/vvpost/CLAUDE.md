# Loja API

## Documentação

A documentação da API fica no projeto do VVPost em `api/` (servidor MCP `vvpost`), e anda junto com
o código. Os testes ficam em `test/` (`npm test`).

A API de homologação da Loja é o ambiente `homolog` do projeto do VVPost; a chave já está no cofre
do VVPost.

<!-- vvpost:docs -->
## Documentação (VVPost)

A documentação deste projeto é escrita no VVPost, não em arquivos .md soltos:

- **Código e documentação andam juntos.** Ao mudar o código (APIs, integrações, regras, arquitetura),
  atualize no mesmo trabalho, sem esperar pedido, o projeto no VVPost: o catálogo (`edit_project`), as
  páginas que descrevem o que mudou (`write_docs_page` com `edits`) e o PDF (`export_docs`), quando
  a resposta de escrita trouxer `stalePdf` (sem ele, não exporte). As respostas de escrita dizem o que ficou para trás (`documentErrors`).
- Pelo MCP do VVPost: `get_docs_project` para ler, `save_docs_project` (com `template`, ex.: `builtin:c4`) para o
  documento e o modelo, `write_docs_page` para páginas em `docs/` incluídas com `{{> include docs/pagina.md}}`,
  e `generate_docs` com `outline: true` para ver a estrutura.
- Uma mudança de API é um `edit_project` só, tudo ou nada: `replaceReferences` para o nome que mudou
  (catálogo, schemas e páginas), `setSchemaField` com `fillExamples: true` para um campo novo e
  `writePage` com `edits` para o texto das páginas. Não precisa de `dryRun`: com erro, nada é gravado.
- Para chamar uma API do catálogo, use `execute_dry_run` com `request` (e `select` para trazer só os
  campos que interessam), em vez de `curl` ou script.
- Use as diretivas `{{> endpoint <conector>/<endpoint>}}`, `{{> connector <id>}}`, `{{> map}}`, `{{> flows}}` e
  `{{> reference}}` em vez de copiar detalhes das APIs à mão.
- As respostas de escrita já conferem o documento (`documentErrors`); `vvpost docs --strict` é para o CI, não precisa rodar.
- Nunca escreva valores de credenciais; variáveis secretas aparecem só pelo nome.
