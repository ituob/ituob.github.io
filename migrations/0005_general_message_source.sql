-- Keep the imported repository bytes independently of approval revisions.
-- New drafts and pre-migration drafts have no source and serialize normally.
ALTER TABLE general_messages ADD COLUMN source_yaml TEXT;
