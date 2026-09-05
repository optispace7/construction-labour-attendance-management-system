-- Passwords are hashed by Postgres now, not by the application.
--
-- The runtime the API deploys to gives a request a very small CPU budget, and
-- every password KDF worth using costs far more than that. pgcrypto's crypt()
-- does the work in the database instead, where there is no such limit.
--
-- Supabase ships pgcrypto already installed; this is here so a fresh database
-- or a different environment does not come up without it and fail every login.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
