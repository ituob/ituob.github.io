-- The address a message was actually sent to. users.email can change on login, so a bounce
-- webhook must suppress this, not the user's current address. NULL for rows sent before this.
ALTER TABLE notifications ADD COLUMN email_to TEXT;
