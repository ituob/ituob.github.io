-- A notification row already identifies one event and recipient. Freeze its
-- provider identity before sending so preference changes cannot regroup it.
ALTER TABLE notifications ADD COLUMN email_delivery_key TEXT;
UPDATE notifications SET email_delivery_key=digest_key WHERE digest_key IS NOT NULL;
