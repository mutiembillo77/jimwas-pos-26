-- Supabase Auth owns authentication credentials.
-- public.users is the POS profile/authorization table.
-- password_hash is retained only for legacy schema compatibility and must not be required for Supabase Auth users.

ALTER TABLE public.users
ALTER COLUMN password_hash DROP NOT NULL;
