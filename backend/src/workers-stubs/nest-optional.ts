/**
 * Inert stand-ins for Nest's optional transport packages.
 *
 * `@nestjs/core` lazily `require`s `@nestjs/microservices` and
 * `@nestjs/websockets` so an app that uses them gets a helpful error instead of
 * a missing import. CLAMS is HTTP-only and has never installed either, so on a
 * normal Node server those requires simply return undefined and Nest skips the
 * corresponding setup.
 *
 * A bundler cannot know that: it follows the require, fails to resolve a
 * package that was never a dependency, and stops. These stubs exist to resolve
 * the import.
 *
 * They must be *inert*, not merely present. `NestApplication` constructs both
 * modules unconditionally and calls their lifecycle methods during boot and
 * shutdown, so a stub that throws — as the first version of this file did —
 * takes the whole Worker down before the first request. Every method is a
 * deliberate no-op, which reproduces what Nest does when the packages are
 * genuinely absent.
 */

/** Matches the surface NestApplication drives during bootstrap and shutdown. */
class InertTransportModule {
  register(): void {}
  registerClients(): void {}
  setupListeners(): void {}
  setupClients(): void {}
  bindClientsToProperties(): void {}
  async close(): Promise<void> {}
}

export class MicroservicesModule extends InertTransportModule {}
export class SocketModule extends InertTransportModule {}

/**
 * Only reached if application code deliberately asks for a microservice, which
 * CLAMS never does — so this one may fail loudly.
 */
export class NestMicroservice {
  constructor() {
    throw new Error(
      'CLAMS is HTTP-only; @nestjs/microservices is stubbed out of the Workers bundle.',
    );
  }
}

export default { MicroservicesModule, SocketModule, NestMicroservice };
