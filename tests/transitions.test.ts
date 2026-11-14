import { describe, expect, it } from 'vitest';
import { canTransition, deriveFulfilment, itemStatusFor } from '../src/modules/kitchen/transitions';

describe('ticket transitions', () => {
  it('moves forward only', () => {
    expect(canTransition('NEW', 'ACCEPTED')).toBe(true);
    expect(canTransition('NEW', 'READY')).toBe(true);
    expect(canTransition('READY', 'PREPARING')).toBe(false);
    expect(canTransition('PREPARING', 'PREPARING')).toBe(false);
  });
  it('can cancel until served', () => {
    expect(canTransition('PREPARING', 'CANCELLED')).toBe(true);
    expect(canTransition('SERVED', 'CANCELLED')).toBe(false);
    expect(canTransition('CANCELLED', 'NEW')).toBe(false);
  });
  it('maps ticket to item status', () => {
    expect(itemStatusFor('ACCEPTED')).toBe('SENT');
    expect(itemStatusFor('READY')).toBe('READY');
  });
});

describe('deriveFulfilment', () => {
  it('all served -> SERVED', () => expect(deriveFulfilment(['SERVED', 'SERVED', 'CANCELLED'], 'IN_PROGRESS')).toBe('SERVED'));
  it('ready + served -> READY', () => expect(deriveFulfilment(['READY', 'SERVED'], 'IN_PROGRESS')).toBe('READY'));
  it('some preparing -> IN_PROGRESS', () => expect(deriveFulfilment(['PREPARING', 'SENT'], 'SENT_TO_KITCHEN')).toBe('IN_PROGRESS'));
  it('pending item blocks READY', () => expect(deriveFulfilment(['READY', 'PENDING'], 'IN_PROGRESS')).toBe('IN_PROGRESS'));
  it('only sent -> SENT_TO_KITCHEN', () => expect(deriveFulfilment(['SENT', 'PENDING'], 'OPEN')).toBe('SENT_TO_KITCHEN'));
  it('terminal states never change', () => expect(deriveFulfilment(['SENT'], 'CANCELLED')).toBe('CANCELLED'));
});
