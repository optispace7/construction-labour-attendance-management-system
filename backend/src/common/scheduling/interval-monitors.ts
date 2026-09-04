/**
 * Whether the background monitors should drive themselves with `setInterval`.
 *
 * On a long-lived Node process they should: the process is there all day and a
 * timer is the simplest thing that works.
 *
 * On a runtime with no process between requests there is nothing for a timer to
 * live in — and the runtime refuses one outright, because a timer set while the
 * module is being evaluated would belong to no request. There the same checks
 * are driven by the platform's scheduler, which calls into the monitors from a
 * handler instead.
 *
 * Either way the work is identical and claim-guarded, so nothing double-acts if
 * both were somehow live at once.
 */
export function intervalMonitorsEnabled(): boolean {
  return process.env.DISABLE_INTERVAL_MONITORS !== '1';
}
