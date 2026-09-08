/**
 * Stand-in for the `cloudflare:workers` module under Jest.
 *
 * That module only exists on the Workers runtime, and D1Service imports it
 * statically because a dynamic require of it is not supported by the bundler.
 * The tests never reach a binding — they inject a double — so an empty env is
 * enough, and asking for one here fails with a sentence rather than a module
 * resolution error somebody has to decode.
 */
module.exports = {
  env: new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `No Cloudflare binding "${String(prop)}" in tests. Inject a double instead of ` +
            'reaching for the real one.',
        );
      },
    },
  ),
};
