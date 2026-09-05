// Argon2 in plain JavaScript costs about a second per hash at production
// settings, and this suite hashes dozens of times. Left alone the crypto specs
// alone take ten minutes, which is how a suite stops being run.
//
// Only the cost of *new* hashes changes. Verification always uses the
// parameters stored in the hash, so the tests that pin real inherited hashes
// still exercise the real thing at its real cost.
process.env.NODE_ENV = 'test';
process.env.ARGON2_MEMORY_KIB = '64';
process.env.ARGON2_ITERATIONS = '1';
