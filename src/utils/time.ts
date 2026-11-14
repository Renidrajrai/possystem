import { env } from '../config/env';
import { badRequest } from './errors';

const MIN = 60_000;

/** [start, end) of a café-local calendar day (YYYY-MM-DD) expressed in UTC. */
export function localDayRange(dateStr: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw badRequest('Date must be YYYY-MM-DD');
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  if (Number.isNaN(utcMidnight)) throw badRequest('Invalid date');
  const start = new Date(utcMidnight - env.TZ_OFFSET_MINUTES * MIN);
  return { start, end: new Date(start.getTime() + 24 * 60 * MIN) };
}

/** Today's date (YYYY-MM-DD) in café-local time. */
export function localToday(now = new Date()): string {
  return new Date(now.getTime() + env.TZ_OFFSET_MINUTES * MIN).toISOString().slice(0, 10);
}

/** Range covering from-day start to to-day end (inclusive of the 'to' day). */
export function localRange(from?: string, to?: string): { start: Date; end: Date } {
  const today = localToday();
  const start = localDayRange(from ?? to ?? today).start;
  const end = localDayRange(to ?? from ?? today).end;
  if (end <= start) throw badRequest('"to" must not be before "from"');
  return { start, end };
}
