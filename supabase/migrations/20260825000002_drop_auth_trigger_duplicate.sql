-- Drop trigger on auth.users so that user provisioning is managed exclusively
-- and transactionally by admin-create-user Edge Function and POS user creation flows,
-- preventing duplicate key conflicts on users_username_key / users_email_key.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
