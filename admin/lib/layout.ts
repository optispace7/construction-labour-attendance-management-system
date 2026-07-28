/**
 * Frame measurements shared between the app shell and the things that stick to
 * it.
 *
 * The dashboard masthead pins itself directly under the top bar. That offset
 * has to be the top bar's real height, and a second hardcoded `60` in another
 * file is how a one-pixel seam appears the day somebody changes it.
 */
export const TOPBAR_H = 60;
