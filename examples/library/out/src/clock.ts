/**
 * Time helpers.
 *
 * The service never calls `Date.now()` outside of {@link resolveNow}: every
 * domain operation receives the current time as an argument, so that the
 * `X-Fake-Now` header can simulate the passage of time.
 */

import { HttpError } from './errors.js';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole days between `from` and `to` (negative when `to` is before `from`). */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Resolve the "now" of a request.
 *
 * Without the header the wall clock is used. With the header the value must be
 * an ISO-8601 date or date-time (`2024-03-01`, `2024-03-01T12:00:00Z`, ...).
 */
export function resolveNow(header: string | string[] | undefined): Date {
  if (header === undefined) {
    return new Date();
  }
  const raw = (Array.isArray(header) ? header[0] : header) ?? '';
  const value = raw.trim();
  if (value === '') {
    throw new HttpError(400, 'INVALID_FAKE_NOW', 'X-Fake-Now must be an ISO-8601 date or date-time');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, 'INVALID_FAKE_NOW', `X-Fake-Now is not a valid ISO-8601 date: "${value}"`);
  }
  return parsed;
}
