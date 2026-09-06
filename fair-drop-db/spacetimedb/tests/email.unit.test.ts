/**
 * `isEmail` guards the one field on the join form that nothing downstream can repair: a
 * mistyped name is visible on the projector all round, a mistyped address is discovered only
 * when a winner is never contacted. These cases pin both halves of the intent — accept what
 * real people type, reject only what could not reach anyone.
 */

import { describe, expect, it } from 'vitest';
import { isEmail } from '../src/pure/email.ts';

describe('isEmail accepts addresses real people type', () => {
  it.each([
    'a@b.co',
    'saksham.bhatt@gmail.com',
    'fan+fairdrop@example.co.uk',
    'first_last-99@mail.example.org',
  ])('accepts %s', (value) => {
    expect(isEmail(value)).toBe(true);
  });
});

describe('isEmail rejects what could never receive mail', () => {
  it.each([
    ['', 'empty — the bot origin passes this, humans must not'],
    ['saksham', 'a name typed into the wrong field'],
    ['saksham@gmail', 'no dotted domain'],
    ['saksham@gmail,com', 'comma for dot — the common phone-keyboard slip'],
    ['saksham @gmail.com', 'embedded space'],
    ['@gmail.com', 'no local part'],
    ['saksham@.com', 'empty domain label'],
    ['saksham@gmail.c', 'single-character TLD'],
    ['a@b.c1', 'digits in the TLD'],
  ])('rejects %s (%s)', (value) => {
    expect(isEmail(value)).toBe(false);
  });

  it('rejects an address past the RFC 5321 forward-path ceiling', () => {
    expect(isEmail(`${'a'.repeat(250)}@b.co`)).toBe(false);
  });
});
