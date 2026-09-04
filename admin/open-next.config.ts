import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * Adapts the Next build for the Workers runtime.
 *
 * No incremental cache is configured, which is deliberate: every page here is
 * server-rendered per request behind an auth cookie, so there is nothing
 * cacheable to store — and caching a dashboard that shows who is on site right
 * now would be actively wrong.
 */
export default defineCloudflareConfig();
