/**
 * @better-auth/utils publishes its entry points through the "exports" map only.
 *
 * The Workers build resolves that (moduleResolution: bundler); the CommonJS
 * build this project still uses for tests does not, and reports the module as
 * missing even though Node itself resolves it perfectly at runtime. Declaring
 * the shape here satisfies the compiler without moving the whole project onto
 * a newer resolution mode, which is a change with a much wider blast radius.
 *
 * Keep in step with @better-auth/utils/password — it is the same scrypt Better
 * Auth verifies with, which is the only reason to call it directly.
 */
declare module '@better-auth/utils/password' {
  export function hashPassword(password: string): Promise<string>;
  export function verifyPassword(hash: string, password: string): Promise<boolean>;
}
