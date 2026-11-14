import { env } from '../config/env';
import { badRequest } from './errors';

/**
 * Normalise a phone number to E.164 so one real-world phone = one customer.
 *   "98123 45678"      -> "+9779812345678"   (default country code, Nepal 977)
 *   "9779812345678"    -> "+9779812345678"
 *   "+977-9812345678"  -> "+9779812345678"
 *   "00977 9812345678" -> "+9779812345678"
 *   "+14155550123"     -> "+14155550123"
 */
export function normalizePhone(input: string, defaultCountryCode = env.DEFAULT_COUNTRY_CODE): string {
  const raw = input.trim();
  if (!raw) throw badRequest('Phone number is required');
  if (/[^\d+\s\-().]/.test(raw)) throw badRequest('Phone number contains invalid characters');

  let digits = raw.replace(/\D/g, '');
  const hadPlus = raw.startsWith('+');

  if (hadPlus) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith(defaultCountryCode) && digits.length >= defaultCountryCode.length + 8) {
    // country code typed without "+"
  } else {
    digits = digits.replace(/^0+/, ''); // trunk prefix
    digits = defaultCountryCode + digits;
  }

  // E.164: max 15 digits. Require a plausible subscriber length.
  if (digits.length < 9 || digits.length > 15) throw badRequest('Phone number is not valid');

  // Nepal-specific sanity check: mobile numbers are 10 digits starting 97/98; landlines are shorter.
  if (digits.startsWith('977')) {
    const national = digits.slice(3);
    if (national.length < 8 || national.length > 10) throw badRequest('Nepal phone number is not valid');
  }

  return `+${digits}`;
}

export function formatMembershipNumber(seq: number, prefix = env.MEMBERSHIP_PREFIX): string {
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}
