import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names, letting a later Tailwind utility beat an earlier one of the
 * same kind. Without the merge, `cn('p-4', props.className)` silently keeps both
 * paddings and the caller's override loses at random depending on stylesheet
 * order.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
