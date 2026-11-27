-- Reenvio da mesma mensagem pelo App (achado na #557): o App não recebeu a confirmação e manda de novo com o mesmo clientId.
-- O UNIQUE por conversa e autor faz o reenvio devolver a mensagem já gravada, sem duplicar a mensagem nem a notificação.
-- Mensagens antigas ficam com client_id NULL: no PostgreSQL, NULL não conflita com NULL no UNIQUE.
ALTER TABLE "messages" ADD COLUMN "client_id" VARCHAR(100);

CREATE UNIQUE INDEX "messages_conversation_id_sender_user_id_client_id_key" ON "messages"("conversation_id", "sender_user_id", "client_id");
