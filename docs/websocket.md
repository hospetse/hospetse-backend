# Chat em tempo real (WebSocket)

Canal de mensagens da conversa da contratação (HSP-PBI-056-TSK-01, #551). Roda no mesmo servidor e na mesma porta da API.
A conversa é aberta e o histórico é lido pelas rotas HTTP da #548 (`POST /api/v1/contracts/{id}/conversation` e
`GET /api/v1/conversations/{id}/messages`, no OpenAPI). Este canal só envia e entrega mensagens novas.

## Conexão

- URL: `wss://<host>/ws` (local: `ws://localhost:3000/ws`).
- Autenticação no handshake, com o mesmo JWT da API, no header: `Authorization: Bearer <access token>`.
  O WebSocket do React Native aceita header: `new WebSocket(url, undefined, { headers: { Authorization: 'Bearer …' } })`.
  Não envie o token na URL: ela aparece em log.
- Token ausente, inválido, vencido ou de usuário inexistente: o servidor responde **401** e o túnel não abre.
- O túnel fecha com o código **4001** (`token expirado`) quando o access token vence (15 minutos, ADR-012).
  O App renova o token pelo refresh e reconecta.
- Heartbeat: o servidor manda PING a cada 30 s; quem não responde é desconectado. O WebSocket do App responde o PONG sozinho.
- Mensagem acima de 16 KB fecha a conexão (código 1009).

## Mensagens do App para o servidor

Todas em JSON, com o campo `type`.

| `type` | Campos | Efeito |
| --- | --- | --- |
| `join` | `conversationId` | Entra na sala da conversa. Só os participantes (Tutor e prestador da contratação). |
| `send` | `conversationId`, `text`, `clientId` (opcional) | Envia uma mensagem de texto (1 a 2.000 caracteres). Exige `join` antes. |

`clientId` é um id gerado pelo App (1 a 100 caracteres) e volta na mensagem confirmada, para trocar o "enviando…" por ela.
Reenvio: se o App não recebeu a confirmação, manda o mesmo `send` com o mesmo `clientId`. O servidor devolve a mensagem já
gravada (mesmo `message.id`) só para quem reenviou, sem gravar outra nem gerar outra notificação. Sem `clientId`, cada `send` é uma mensagem nova.
A autoria vem só do túnel autenticado: qualquer campo de autor no JSON é ignorado.

## Mensagens do servidor para o App

| `type` | Campos | Quando |
| --- | --- | --- |
| `joined` | `conversationId`, `open` | Depois de um `join` aceito. `open: false` = contratação concluída, recusada ou cancelada (só leitura). |
| `message` | `conversationId`, `clientId`, `message: { id, author: { role, name }, text, sentAt }` | Para todos os túneis da sala, inclusive o autor (confirmação). A mensagem já está gravada quando chega, e o outro participante recebe uma notificação `new_message` (HSP-PBI-064), mesmo sem estar conectado. |
| `error` | `request`, `code`, `message`, `details` | Quando um pedido é recusado. |

Códigos de erro:

| `code` | Motivo |
| --- | --- |
| `INVALID_MESSAGE` | O que chegou não é um JSON |
| `UNKNOWN_TYPE` | `type` diferente de `join` e `send` |
| `NOT_FOUND` | Conversa inexistente, id inválido ou de quem não participa (mesma resposta, sem dados) |
| `NOT_JOINED` | `send` sem `join` antes |
| `VALIDATION_ERROR` | `text` vazio ou com mais de 2.000 caracteres, ou `clientId` que não é texto de 1 a 100 caracteres |
| `CLIENT_ID_REUSED` | `clientId` já usado pelo mesmo autor nesta conversa com outro texto |
| `CONVERSATION_CLOSED` | Contratação concluída, recusada ou cancelada: envio bloqueado |
| `INTERNAL_ERROR` | Erro inesperado no servidor |

## Exemplo

```text
App → { "type": "join", "conversationId": "C-1" }
Srv → { "type": "joined", "conversationId": "C-1", "open": true }
App → { "type": "send", "conversationId": "C-1", "text": "oi", "clientId": "tmp-1" }
Srv → { "type": "message", "conversationId": "C-1", "clientId": "tmp-1",
        "message": { "id": "…", "author": { "role": "tutor", "name": "Ana" }, "text": "oi", "sentAt": "…" } }
```

## Quando a conexão cai

Reconectar, mandar `join` de novo e buscar o que chegou no meio pelo `GET /api/v1/conversations/{id}/messages`.
Reconexão automática com fila de envio está fora da Sprint 8 (RNF-CON-04).

## Limite conhecido

As salas ficam na memória do processo: funciona com uma instância do back-end (como hoje no Railway).
Com réplicas, as mensagens precisam passar por um Redis pub/sub (ADR-004) para todas as instâncias entregarem (#576).
