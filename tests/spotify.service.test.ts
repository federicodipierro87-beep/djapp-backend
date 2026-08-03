import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios');

import {
  spotifyService,
  SpotifyNotFoundError,
  SpotifyRateLimitError,
  SpotifyUnavailableError,
} from '../src/services/spotify.service';

const mockedAxios = vi.mocked(axios, true);

const tokenResponse = { data: { access_token: 'token-1', token_type: 'Bearer', expires_in: 3600 } };

const trackPayload = {
  id: '2JiDi0qAXsPwhPqA2qaKGt',
  name: 'Bohemian Rhapsody',
  artists: [{ id: 'artist-1', name: 'Queen' }],
  album: {
    id: 'album-1',
    name: 'A Night at the Opera',
    images: [{ url: 'https://i.scdn.co/image/large', height: 640, width: 640 }],
  },
  duration_ms: 354320,
  external_urls: { spotify: 'https://open.spotify.com/track/2JiDi0qAXsPwhPqA2qaKGt' },
};

const searchResponse = (items: unknown[]) => ({
  data: { tracks: { items, total: items.length, limit: 10, offset: 0 } },
});

const httpError = (status: number) => Object.assign(new Error('request failed'), { response: { status } });

// Each test uses a distinct query because the service caches by search term and
// the module exports a singleton.
let queryCounter = 0;
const uniqueQuery = () => `query-${++queryCounter}`;

beforeEach(() => {
  mockedAxios.post.mockResolvedValue(tokenResponse);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('searchTracks', () => {
  it('maps a track into the shape the client expects', async () => {
    mockedAxios.get.mockResolvedValueOnce(searchResponse([trackPayload]));

    const result = await spotifyService.searchTracks(uniqueQuery());

    expect(result.tracks[0]).toMatchObject({
      id: '2JiDi0qAXsPwhPqA2qaKGt',
      artist: 'Queen',
      albumCover: 'https://i.scdn.co/image/large',
      durationFormatted: '5:54',
    });
  });

  it('serves a repeated search from cache instead of calling Spotify again', async () => {
    mockedAxios.get.mockResolvedValueOnce(searchResponse([trackPayload]));
    const query = uniqueQuery();

    await spotifyService.searchTracks(query);
    await spotifyService.searchTracks(query);

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('does not call Spotify for a blank query', async () => {
    const result = await spotifyService.searchTracks('   ');

    expect(result.tracks).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('clamps a limit above the documented maximum', async () => {
    mockedAxios.get.mockResolvedValueOnce(searchResponse([]));

    await spotifyService.searchTracks(uniqueQuery(), 9999);

    expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({ params: expect.objectContaining({ limit: 50 }) });
  });

  it('retries once with a fresh token when the cached one is rejected', async () => {
    // The token lives on the singleton, so whether a fresh one is fetched at the
    // start depends on which tests ran before. Warming it here and then clearing
    // the counters makes the post below unambiguously the retry's refresh.
    mockedAxios.get.mockResolvedValueOnce(searchResponse([]));
    await spotifyService.searchTracks(uniqueQuery());
    vi.clearAllMocks();
    mockedAxios.post.mockResolvedValue(tokenResponse);

    mockedAxios.get
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValueOnce(searchResponse([trackPayload]));

    const result = await spotifyService.searchTracks(uniqueQuery());

    expect(result.tracks).toHaveLength(1);
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('surfaces throttling as its own error so the route can answer 429', async () => {
    mockedAxios.get.mockRejectedValueOnce(httpError(429));

    await expect(spotifyService.searchTracks(uniqueQuery())).rejects.toBeInstanceOf(SpotifyRateLimitError);
  });

  it('reports an outage rather than a generic failure', async () => {
    mockedAxios.get.mockRejectedValueOnce(httpError(500));

    await expect(spotifyService.searchTracks(uniqueQuery())).rejects.toBeInstanceOf(SpotifyUnavailableError);
  });
});

describe('getTrack', () => {
  it('maps a missing track to a not found error', async () => {
    mockedAxios.get.mockRejectedValueOnce(httpError(404));

    await expect(spotifyService.getTrack('2JiDi0qAXsPwhPqA2qaKGt')).rejects.toBeInstanceOf(
      SpotifyNotFoundError
    );
  });
});
