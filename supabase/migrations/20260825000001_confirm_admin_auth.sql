-- Confirm existing admin user email in auth.users for local/dev environment
UPDATE auth.users
SET email_confirmed_at = NOW()
WHERE email_confirmed_at IS NULL;
