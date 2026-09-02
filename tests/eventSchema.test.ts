import { describe, expect, it } from 'vitest';
import { createEventSchema, updateEventSchema } from '../src/controllers/event.controller';
import { MIN_DONATION } from '../src/config/payments';

const base = { name: 'Serata', address: 'Via Roma 1, Milano' };

// 21:00 in Rome during DST is 19:00 UTC. Production runs in UTC, so anything
// that lets the wall clock reach new Date() unqualified reads back as 23:00.
const ROME_WALL_CLOCK = '2026-08-10T21:00';
const SAME_MOMENT_UTC = '2026-08-10T19:00:00.000Z';

const inRome = (date: Date) =>
  date.toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });

describe('event timestamps', () => {
  it('keeps the moment the DJ picked', () => {
    const parsed = createEventSchema.parse({ ...base, dateTime: SAME_MOMENT_UTC });

    expect(parsed.dateTime.toISOString()).toBe(SAME_MOMENT_UTC);
    expect(inRome(parsed.dateTime)).toBe('21:00');
  });

  it('treats an explicit offset as the same moment as its UTC form', () => {
    const withOffset = createEventSchema.parse({ ...base, dateTime: '2026-08-10T21:00:00+02:00' });

    expect(withOffset.dateTime.toISOString()).toBe(SAME_MOMENT_UTC);
  });

  it('refuses a wall clock with no zone instead of guessing one', () => {
    // Accepting this is the whole bug: the server would answer for a zone that
    // is not the DJ's, and nothing downstream could tell that it had happened.
    expect(() => createEventSchema.parse({ ...base, dateTime: ROME_WALL_CLOCK })).toThrow(
      /UTC offset/
    );
    expect(() => updateEventSchema.parse({ dateTime: ROME_WALL_CLOCK })).toThrow(/UTC offset/);
  });

  it('refuses a string that is not a date', () => {
    expect(() => createEventSchema.parse({ ...base, dateTime: 'domani sera Z' })).toThrow(
      /not a valid date/
    );
  });

  it('reads a missing end date as absent when creating', () => {
    expect(createEventSchema.parse({ ...base, dateTime: SAME_MOMENT_UTC }).endDateTime).toBeUndefined();
  });
});

describe('clearing the end date', () => {
  // Prisma skips undefined and writes null, so these three cases are the whole
  // difference between "leave it alone" and "the DJ took it back".
  it('leaves the stored end date alone when the field is not sent', () => {
    expect(updateEventSchema.parse({ name: 'Altro nome' }).endDateTime).toBeUndefined();
  });

  it('clears it on an explicit null', () => {
    expect(updateEventSchema.parse({ endDateTime: null }).endDateTime).toBeNull();
  });

  it('clears it on a blank string, which is what an emptied field sends', () => {
    expect(updateEventSchema.parse({ endDateTime: '' }).endDateTime).toBeNull();
  });

  it('still sets it when a real instant is sent', () => {
    expect(updateEventSchema.parse({ endDateTime: SAME_MOMENT_UTC }).endDateTime).toEqual(
      new Date(SAME_MOMENT_UTC)
    );
  });

  it('does not let the same blank clear the start date, which cannot be null', () => {
    expect(updateEventSchema.parse({ dateTime: '' }).dateTime).toBeUndefined();
  });
});

describe('the minimum tip of a night', () => {
  // The floor belongs to the card providers, not to us: Stripe refuses a euro
  // charge under fifty cents when the PaymentIntent is created, so a night
  // advertising less would quote its guests an amount no card would accept.
  it('accepts the floor itself', () => {
    expect(
      createEventSchema.parse({ ...base, dateTime: SAME_MOMENT_UTC, minDonation: MIN_DONATION })
        .minDonation
    ).toBe(MIN_DONATION);
  });

  it('accepts a real minimum', () => {
    expect(updateEventSchema.parse({ minDonation: 5 }).minDonation).toBe(5);
  });

  // Zero used to be the free-request switch. It is refused now: a request the
  // guest does not pay for is a free write into the DJ's panel, and the rate
  // limiter is the only thing left standing between that and a flood.
  it('refuses zero, so a night cannot be opened to free requests', () => {
    expect(() =>
      createEventSchema.parse({ ...base, dateTime: SAME_MOMENT_UTC, minDonation: 0 })
    ).toThrow();
    expect(() => updateEventSchema.parse({ minDonation: 0 })).toThrow();
  });

  it('refuses an amount the provider would reject', () => {
    expect(() => updateEventSchema.parse({ minDonation: 0.2 })).toThrow();
  });

  it('refuses a negative minimum', () => {
    expect(() =>
      createEventSchema.parse({ ...base, dateTime: SAME_MOMENT_UTC, minDonation: -1 })
    ).toThrow();
    expect(() => updateEventSchema.parse({ minDonation: -1 })).toThrow();
  });

  it('refuses a minimum above the top of the slider', () => {
    expect(() => updateEventSchema.parse({ minDonation: 101 })).toThrow();
  });

  // Prisma skips undefined, so an untouched field leaves the stored minimum -
  // or the absence of one, which is what makes an old event keep using the DJ's.
  it('leaves the stored minimum alone when the field is not sent', () => {
    expect(updateEventSchema.parse({ name: 'Altro nome' }).minDonation).toBeUndefined();
    expect(
      createEventSchema.parse({ ...base, dateTime: SAME_MOMENT_UTC }).minDonation
    ).toBeUndefined();
  });
});
