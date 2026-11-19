# Loja API

API de pedidos da Loja: produtos, pedidos, cancelamento e cotação de frete com as transportadoras
parceiras (TransNorte e, como reserva, EntregaJá).

```bash
npm start   # http://localhost:3000
npm test
```

- Especificação da API: [`openapi/loja.yaml`](openapi/loja.yaml); APIs das transportadoras em
  [`openapi/transnorte.yaml`](openapi/transnorte.yaml) e [`openapi/entregaja.yaml`](openapi/entregaja.yaml).
- Documentação: [arquitetura](docs/arquitetura.md), [frete](docs/frete.md) e
  [guia de integração](docs/guia-de-integracao.md).
