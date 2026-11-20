import { WebSocketServer } from 'ws';
import { AppError } from '../lib/app-error.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';
import { joinConversationService, sendMessageService } from './conversation.service.js';

// Canal de mensagens em tempo real (HSP-PBI-056-TSK-01 #551). Mesmo servidor e mesma porta da API: o WebSocket começa
// como uma requisição HTTP com "Upgrade: websocket" em /ws, e o protocolo das mensagens está em docs/websocket.md.
const PATH = '/ws';
const HEARTBEAT_MS = 30000;
// Uma mensagem de texto do chat cabe com folga; acima disso o ws fecha a conexão (1009)
const MAX_PAYLOAD_BYTES = 16 * 1024;
const CLIENT_ID_MAX = 100;

// Liga o canal ao servidor HTTP que o app.listen() devolveu. heartbeatMs só muda nos testes.
export function attachChat(server, { heartbeatMs = HEARTBEAT_MS } = {}) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    // Salas: conversationId → túneis que entraram nela.
    // shortcut: salas na memória do processo, então só funciona com uma instância do back-end (o Railway roda uma);
    // com réplicas, publicar as mensagens no Redis (pub/sub, ADR-004) para todas as instâncias entregarem (#576)
    const rooms = new Map();

    // Handshake: o JWT é conferido uma única vez, aqui. Sem token válido, o túnel nem abre
    server.on('upgrade', async (req, socket, head) => {
        if (new URL(req.url, 'http://localhost').pathname !== PATH) return socket.destroy();
        const identity = await authenticate(req);
        if (!identity) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, identity));
    });

    wss.on('connection', (ws, { user, expiresAt }) => {
        ws.user = user;
        ws.rooms = new Set();
        ws.isAlive = true;
        // O access token dura 15 min (ADR-012): o túnel fecha quando ele vence, e o App reconecta com o token renovado
        const expiry = setTimeout(() => ws.close(4001, 'token expirado'), Math.max(expiresAt - Date.now(), 0));

        ws.on('pong', () => {
            ws.isAlive = true;
        });
        ws.on('message', (data, isBinary) => handleMessage(ws, data, isBinary));
        ws.on('close', () => {
            clearTimeout(expiry);
            for (const conversationId of ws.rooms) leave(conversationId, ws);
        });
    });

    // Heartbeat: quem não respondeu o PING anterior caiu sem avisar (elevador, troca de rede) e sai das salas.
    // O PONG é do próprio protocolo: o WebSocket do App responde sozinho
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, heartbeatMs);
    heartbeat.unref();
    server.on('close', () => {
        clearInterval(heartbeat);
        wss.close();
    });

    async function handleMessage(ws, data, isBinary) {
        let request;
        try {
            request = isBinary ? null : JSON.parse(data.toString());
        } catch {
            request = null;
        }
        if (request === null || typeof request !== 'object') {
            return send(ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Envie um JSON com o campo type' });
        }

        try {
            if (request.type === 'join') {
                const { conversationId, open } = await joinConversationService(ws.user, request.conversationId);
                join(conversationId, ws);
                return send(ws, { type: 'joined', conversationId, open });
            }
            if (request.type === 'send') {
                // Só envia quem entrou na sala: assim o próprio autor recebe a confirmação pelo mesmo caminho do outro lado
                if (!ws.rooms.has(request.conversationId)) {
                    throw new AppError('Entre na conversa (join) antes de enviar', 409, 'NOT_JOINED');
                }
                const message = await sendMessageService(ws.user, request.conversationId, request.text);
                // clientId volta como veio: o App troca o "enviando…" pela mensagem confirmada
                const clientId = typeof request.clientId === 'string' ? request.clientId.slice(0, CLIENT_ID_MAX) : undefined;
                return broadcast(request.conversationId, { type: 'message', conversationId: request.conversationId, clientId, message });
            }
            throw new AppError('Tipo de mensagem desconhecido', 400, 'UNKNOWN_TYPE');
        } catch (error) {
            if (error instanceof AppError) {
                return send(ws, { type: 'error', request: request.type, code: error.code, message: error.message, details: error.details });
            }
            // Só o nome do erro: o texto da mensagem não vai para o log
            console.log(`chat: erro ${error.name}`);
            return send(ws, { type: 'error', request: request.type, code: 'INTERNAL_ERROR', message: 'Erro inesperado' });
        }
    }

    function join(conversationId, ws) {
        if (!rooms.has(conversationId)) rooms.set(conversationId, new Set());
        rooms.get(conversationId).add(ws);
        ws.rooms.add(conversationId);
    }

    function leave(conversationId, ws) {
        const room = rooms.get(conversationId);
        room?.delete(ws);
        if (room?.size === 0) rooms.delete(conversationId);
    }

    function broadcast(conversationId, event) {
        for (const ws of rooms.get(conversationId) ?? []) send(ws, event);
    }

    return { wss, rooms };
}

function send(ws, event) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

// O mesmo JWT da API, no header Authorization (o WebSocket do React Native aceita header). Token na URL vazaria em log.
async function authenticate(req) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    try {
        const { sub, exp } = await verifyAccessToken(header.slice('Bearer '.length));
        const user = await prisma.user.findUnique({ where: { authUserId: sub }, select: { id: true, name: true } });
        return user ? { user, expiresAt: exp * 1000 } : null;
    } catch {
        return null;
    }
}
