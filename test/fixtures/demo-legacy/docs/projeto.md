## Contexto do sistema

A Acme Payments recebe cobranças PIX e cartão dos canais de venda e conversa com o provedor de
pagamentos. Todo serviço herda a autenticação OAuth2 da base corporativa.

```mermaid
C4Context
  title Contexto do sistema
  Person(cliente, "Cliente", "Compra pelo app ou pelo site")
  System(acme, "Acme Payments", "Cobranças, estornos e clientes")
  System_Ext(psp, "Provedor de pagamentos", "PIX e cartão")
  System_Ext(idp, "Identidade corporativa", "OAuth2 client credentials")
  Rel(cliente, acme, "Paga", "HTTPS")
  Rel(acme, psp, "Liquida", "HTTPS")
  Rel(acme, idp, "Obtém token", "OAuth2")
```

## Contêineres

```mermaid
C4Container
  title Contêineres
  Person(cliente, "Cliente")
  System_Boundary(acme, "Acme Payments") {
    Container(gateway, "API Gateway", "HTTP", "Autentica e roteia")
    Container(payments, "Payments Service v1", "Node", "Cobranças e estornos")
    Container(customers, "Customers v2", "Node", "Cadastro de clientes")
    ContainerDb(banco, "Banco", "PostgreSQL", "Cobranças e clientes")
  }
  Rel(cliente, gateway, "Chama", "HTTPS")
  Rel(gateway, payments, "Encaminha")
  Rel(gateway, customers, "Encaminha")
  Rel(payments, banco, "Lê e grava")
  Rel(customers, banco, "Lê e grava")
```

Mapa das integrações do projeto (conectores, herança, endpoints e fluxos):

{{> map}}

## Como integrar

{{> include docs/guia-de-integracao.md}}

## Componentes

{{> connector connector.payments.v1}}

{{> connector connector.customers.v2}}

## Dinâmica

O checkout encadeia login, cliente, carrinho e cobrança:

{{> diagram docs/diagramas/cobranca.mmd}}

{{> flows}}

## Implantação

{{> environments}}

{{> variables}}

## Decisões de arquitetura

| # | Decisão | Status | Data |
| --- | --- | --- | --- |
| 1 | Auth OAuth2 herdada da base corporativa em todos os conectores | aceita | 2026-10-01 |
| 2 | Cobranças idempotentes pelo `customer_id` e valor | proposta | 2026-10-20 |
