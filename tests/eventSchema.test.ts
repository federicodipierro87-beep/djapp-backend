import { describe, expect, it } from 'vitest';
import { createEventSchema, updateEventSchema } from '../src/controllers/event.controller';

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

  it('reads a missing or blank end date as absent', () => {
    expect(createEventSchema.parse({ ...base, dateTime: SAME_MOMENT_UTC }).endDateTime).toBeUndefined();
    expect(
      createEventSchema.parse({ ...base, dateTime: SAME_MOMENT_UTC, endDateTime: '' }).endDateTime
    ).toBeUndefined();
  });
});
