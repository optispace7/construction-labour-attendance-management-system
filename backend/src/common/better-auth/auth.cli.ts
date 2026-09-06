/**
 * Entry point for `@better-auth/cli generate`, and nothing else.
 *
 * The generator needs a module that exports a built `auth`. The application
 * cannot export one — building it at import time is what broke the deploy,
 * because the runtime loads the module to validate it and a PrismaClient
 * cannot initialise there outside a request. This file is only ever loaded by
 * the CLI, on Node, where that is fine.
 */
import { createAuth } from './auth';

export const auth = createAuth();
