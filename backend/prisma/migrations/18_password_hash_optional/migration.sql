-- users.password_hash stops being required.
--
-- Better Auth owns credentials now: a login reads auth_account.password, and
-- nothing reads this column. New accounts therefore have no value to put in it.
--
-- Made nullable rather than dropped. The column still holds the bcrypt hashes
-- every existing account was migrated to, which is the only way back if Better
-- Auth is abandoned — and dropping a column of credentials cannot be undone.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
