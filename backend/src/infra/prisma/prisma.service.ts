import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * Whether to reach Postgres through a JS driver rather than Prisma's own query
 * engine.
 *
 * The engine is a native Rust binary. That is fine on a container and
 * impossible on a runtime that only loads JS and WebAssembly, so the adapter is
 * what lets one codebase serve both. It is opt-in rather than always-on because
 * the engine is still the faster path on a normal server, and there is no
 * reason to give that up where it works.
 *
 * Set DATABASE_DRIVER_ADAPTER=1 to use the JS driver.
 */
const USE_DRIVER_ADAPTER = process.env.DATABASE_DRIVER_ADAPTER === '1';

/**
 * Pooled connections are capped low on purpose. A pooler in front of the
 * database (Supabase's Supavisor, or Hyperdrive) is already doing the real
 * pooling; opening a wide pool from every instance behind it is how a database
 * runs out of connections while each instance believes it is being modest.
 */
const POOL_MAX = Number(process.env.DATABASE_POOL_MAX ?? 5);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Extending PrismaClient means the adapter has to be handed to super(),
    // so the branch lives here rather than around a field.
    if (USE_DRIVER_ADAPTER) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL is not configured');
      }
      // The adapter version must match @prisma/client: the client calls
      // adapter.transactionContext() directly, and a newer adapter is a factory
      // whose adapter comes back from connect() instead. Mismatched, the client
      // reads an undefined method off it and the whole app fails to construct.
      super({
        adapter: new PrismaPg(
          new Pool({
            connectionString,
            max: POOL_MAX,
            // Retire every connection after a single checkout.
            //
            // This looks wasteful and is not. The driver adapter is what runs
            // on the serverless runtime, and there a TCP socket does not
            // survive between requests — the isolate is frozen and its
            // connections are torn down underneath it. A pool that keeps
            // connections then hands a dead socket to the next request, which
            // waits on a reply that can never come until the request is killed
            // at sixty seconds. It presented as logins alternating between
            // fast and a hard timeout, depending on whether the isolate was
            // warm.
            //
            // Timers cannot fix this — a frozen isolate does not run them, so
            // idleTimeoutMillis never fires. Retiring by use count is
            // deterministic and does not depend on the isolate being awake.
            // The cost is a connection setup per checkout, which is what
            // Hyperdrive is in front of the database to absorb.
            maxUses: 1,
          }),
        ),
      } as never);
    } else {
      super();
    }
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
