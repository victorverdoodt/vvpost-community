# Loja API

## Documentação

A documentação da API fica neste repositório e anda junto com o código:

- A especificação OpenAPI da Loja fica em `openapi/loja.yaml`, e as APIs das transportadoras que o
  código chama em `openapi/transnorte.yaml` e `openapi/entregaja.yaml`.
- As páginas ficam em `docs/` (arquitetura, frete, guia de integração) e no `README.md`.
- Ao mudar o código (endpoints, campos, integrações, arquitetura), atualize no mesmo trabalho, sem
  esperar pedido, a especificação e as páginas que descrevem o que mudou, e confira que nenhuma
  menção ficou para trás.
- Os testes ficam em `test/` (`npm test`).

## Homologação

A API de homologação da Loja roda em `http://127.0.0.1:__PORTA_HOMOLOG__`. A chave fica em
`.env.homolog` (fora do Git), como `LOJA_API_KEY`, e vai no header `X-Api-Key`.
