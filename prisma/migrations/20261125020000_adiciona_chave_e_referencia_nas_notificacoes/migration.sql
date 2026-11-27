-- Chave do evento e referência da notificação (HSP-PBI-064-TSK-01 #554). Só acrescenta: nenhuma coluna ou linha é apagada.
ALTER TABLE "notifications"
    ADD COLUMN "event_key" VARCHAR(150),
    ADD COLUMN "reference_type" VARCHAR(30),
    ADD COLUMN "reference_id" UUID;

-- Backfill das notificações que já existem, a partir do content (JSON gravado pelos produtores das Sprints 7 e 8).
-- Chave no mesmo formato do notify (src/notifications/notification.service.js). Se uma linha antiga repetir o evento,
-- só a primeira recebe a chave; as outras ficam com event_key NULL (o UNIQUE não compara NULL) e continuam na tabela.
WITH parsed AS (
    SELECT n.id, n.user_id, n.type, n.created_at, n.content::json AS c
    FROM "notifications" n
    WHERE n.type IN ('reservation_rejected', 'reservation_checked_in', 'payment_approved', 'new_message',
                     'provider_validation_approved', 'provider_validation_rejected')
      AND n.content ~ '^\s*\{'
), keyed AS (
    SELECT p.id, p.user_id, p.created_at,
        CASE
            WHEN p.type IN ('reservation_rejected', 'reservation_checked_in') THEN p.type || ':' || (p.c->>'reservationId')
            WHEN p.type = 'payment_approved' THEN p.type || ':' || (p.c->>'transactionId')
            WHEN p.type = 'new_message' THEN p.type || ':' || (p.c->>'messageId')
            ELSE p.type || ':' || (p.c->>'providerId') || ':'
                || to_char(pr.validation_decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS event_key,
        CASE
            WHEN p.type = 'new_message' THEN 'conversation'
            WHEN p.type LIKE 'provider_validation_%' THEN 'provider_validation'
            ELSE 'contract'
        END AS reference_type,
        CASE
            WHEN p.type = 'new_message' THEN p.c->>'conversationId'
            WHEN p.type LIKE 'provider_validation_%' THEN p.c->>'providerId'
            ELSE p.c->>'reservationId'
        END AS reference_id
    FROM parsed p
    LEFT JOIN "providers" pr ON p.type LIKE 'provider_validation_%' AND pr.id::text = p.c->>'providerId'
), ranked AS (
    SELECT k.*, ROW_NUMBER() OVER (PARTITION BY k.user_id, k.event_key ORDER BY k.created_at, k.id) AS position
    FROM keyed k
)
UPDATE "notifications" n
SET event_key = CASE WHEN r.position = 1 THEN r.event_key END,
    reference_type = r.reference_type,
    reference_id = r.reference_id::uuid
FROM ranked r
WHERE n.id = r.id;

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_event_key_key" ON "notifications"("user_id", "event_key");
