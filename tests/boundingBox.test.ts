import { describe, expect, it } from 'vitest';
import { boundingBox } from '../src/services/event.service';

// Milano, roughly.
const LAT = 45.4642;
const LNG = 9.19;

describe('boundingBox', () => {
  it('contains its own centre', () => {
    const box = boundingBox(LAT, LNG, 10);

    expect(LAT).toBeGreaterThan(box.latMin);
    expect(LAT).toBeLessThan(box.latMax);
    expect(LNG).toBeGreaterThan(box.lngMin);
    expect(LNG).toBeLessThan(box.lngMax);
  });

  // The box has to be a superset of the circle, otherwise the database drops
  // events that the distance check would have kept. A degree of latitude is
  // ~111.32 km everywhere, so ten kilometres north is 0.0898 degrees.
  it('reaches at least the full radius north and south', () => {
    const box = boundingBox(LAT, LNG, 10);

    expect(box.latMax).toBeGreaterThanOrEqual(LAT + 10 / 111.32);
    expect(box.latMin).toBeLessThanOrEqual(LAT - 10 / 111.32);
  });

  // Meridians converge, so at 45° north ten kilometres east is worth about 1.42
  // times as many degrees of longitude as ten kilometres north is of latitude.
  it('widens the longitude span as latitude increases', () => {
    const box = boundingBox(LAT, LNG, 10);
    const latSpan = box.latMax - box.latMin;
    const lngSpan = box.lngMax - box.lngMin;

    expect(lngSpan).toBeGreaterThan(latSpan);
    expect(lngSpan / latSpan).toBeCloseTo(1 / Math.cos((LAT * Math.PI) / 180), 2);
  });

  it('grows with the radius', () => {
    const small = boundingBox(LAT, LNG, 5);
    const large = boundingBox(LAT, LNG, 50);

    expect(large.latMax - large.latMin).toBeGreaterThan(small.latMax - small.latMin);
  });

  // Near the pole every meridian is within a few kilometres, so a longitude
  // bound is meaningless and dividing by cos(89.99°) would produce nonsense.
  it('gives up on the longitude bound near the poles', () => {
    expect(boundingBox(89.99, 0, 10).lngWraps).toBe(true);
  });

  // Same story at the antimeridian: the box is two ranges there, and asking the
  // database for `lng >= 179 AND lng <= 181` would return nothing at all.
  it('gives up on the longitude bound across the antimeridian', () => {
    expect(boundingBox(0, 179.99, 10).lngWraps).toBe(true);
    expect(boundingBox(0, -179.99, 10).lngWraps).toBe(true);
  });

  it('keeps the longitude bound everywhere else', () => {
    expect(boundingBox(LAT, LNG, 10).lngWraps).toBe(false);
  });
});
