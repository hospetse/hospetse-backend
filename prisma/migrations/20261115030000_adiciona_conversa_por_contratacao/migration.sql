-- #548: uma conversa por contratação, e a autoria da mensagem pelo usuário que enviou.
-- Seguro: nenhuma linha é alterada. O único DROP é o do índice comum de reservation_id, trocado pelo índice único logo abaixo.
-- Nenhum código anterior cria conversa, então não há duas conversas para a mesma contratação. Se houver, o CREATE UNIQUE INDEX falha e o deploy para.

-- Uma conversa por contratação. NULL não colide com NULL: conversas antigas sem contratação continuam válidas
DROP INDEX "conversations_reservation_id_idx";
CREATE UNIQUE INDEX "conversations_reservation_id_key" ON "conversations"("reservation_id");

-- Quem enviou a mensagem. sender_type diz o papel (tutor ou host); sender_user_id diz quem. Opcional: mensagens antigas não têm
ALTER TABLE "messages" ADD COLUMN "sender_user_id" UUID;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_fkey"
  FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "messages_sender_user_id_idx" ON "messages"("sender_user_id");

-- Histórico paginado com desempate por id (mensagens no mesmo milissegundo). O índice antigo continua
CREATE INDEX "messages_conversation_id_sent_at_id_idx" ON "messages"("conversation_id", "sent_at", "id");
