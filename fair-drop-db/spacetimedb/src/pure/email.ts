/**
 * Is this string a plausible contact address?
 *
 * Deliberately permissive. The real check on an address is whether mail sent to it arrives,
 * and nothing in this module sends mail — so the only job here is to catch the mistakes a
 * person makes on a phone keyboard under a running clock (a name typed into the wrong field,
 * a missing `@`, a trailing `,` instead of `.`) before the row is written and the room moves on.
 * A stricter grammar would reject valid addresses (plus-tags, long TLDs, subdomains) for no
 * gain the demo can observe, and every rejection here happens to a real person standing in
 * front of an audience.
 *
 * Expects an already-normalised (trimmed, lowercased) string — `join` normalises before calling.
 */
export function isEmail(value: string): boolean {
  // 254 is the RFC 5321 ceiling on a forward path; past it no mail server would accept it.
  if (value.length === 0 || value.length > 254) return false;
  // One `@`, something either side, and a dotted domain whose last label is alphabetic.
  return /^[^\s@,]+@[^\s@,.]+(\.[^\s@,.]+)*\.[a-z]{2,}$/.test(value);
}
