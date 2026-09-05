// Passwords are hashed by Postgres now, so nothing in this suite pays a real
// KDF cost — the database is stubbed. NODE_ENV is still set explicitly because
// PasswordHashService only allows a cost below the production floor in a test
// run, and that rule is itself under test.
process.env.NODE_ENV = 'test';
