import { describe, expect, it } from 'vitest';
import { broadcastCode } from '../src/socket/broadcastCode';

// The rooms guests sit in are named after the code they scanned. Getting this
// wrong is invisible in tests that only check the payload: the emit succeeds,
// it just lands in an empty room and the public screens stay frozen.
describe('broadcastCode', () => {
  it('uses the event code when the row belongs to an Event', () => {
    expect(
      broadcastCode({ event: { eventCode: 'EVT123' }, dj: { eventCode: 'DJ999' } })
    ).toBe('EVT123');
  });

  // This is the regression. Everything used to name the DJ's permanent code, so
  // for a request filed against an Event the emit went to 'DJ999' while the
  // guests were all in 'EVT123'.
  it('prefers the event code over the DJ code', () => {
    const code = broadcastCode({ event: { eventCode: 'EVT123' }, dj: { eventCode: 'DJ999' } });

    expect(code).not.toBe('DJ999');
  });

  it('falls back to the DJ code for rows that predate the Event system', () => {
    expect(broadcastCode({ event: null, dj: { eventCode: 'DJ999' } })).toBe('DJ999');
  });

  it('returns null when neither is available, so the caller skips the emit', () => {
    expect(broadcastCode({ event: null, dj: null })).toBeNull();
    expect(broadcastCode({})).toBeNull();
  });
});
