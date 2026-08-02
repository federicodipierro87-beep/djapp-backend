import axios from 'axios';

interface SpotifyToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  album: {
    id: string;
    name: string;
    images: { url: string; height: number; width: number }[];
  };
  duration_ms: number;
  external_urls: { spotify: string };
}

interface SpotifySearchResponse {
  tracks: {
    items: SpotifyTrack[];
    total: number;
    limit: number;
    offset: number;
  };
}

interface SearchResult {
  tracks: {
    id: string;
    name: string;
    artist: string;
    artistId?: string;
    album: string;
    albumId: string;
    albumCover: string | null;
    albumCoverSmall: string | null;
    duration: number;
    durationFormatted: string;
    spotifyUrl: string;
  }[];
  total: number;
  limit: number;
  offset: number;
}

export class SpotifyUnavailableError extends Error {}
export class SpotifyRateLimitError extends Error {}
export class SpotifyNotFoundError extends Error {}

const MAX_LIMIT = 50;
const MAX_OFFSET = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

class SpotifyService {
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private searchCache = new Map<string, { expiresAt: number; payload: SearchResult }>();

  constructor() {
    this.clientId = process.env.SPOTIFY_CLIENT_ID || '';
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    try {
      const response = await axios.post<SpotifyToken>(
        'https://accounts.spotify.com/api/token',
        'grant_type=client_credentials',
        {
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = response.data.access_token;
      // Set expiry 5 minutes before actual expiry for safety
      this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;

      return this.accessToken;
    } catch (error) {
      console.error('Failed to get Spotify access token:', error);
      throw new SpotifyUnavailableError('Failed to authenticate with Spotify');
    }
  }

  private invalidateToken() {
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  private getCached(key: string): SearchResult | null {
    const hit = this.searchCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.searchCache.delete(key);
      return null;
    }
    return hit.payload;
  }

  private setCached(key: string, payload: SearchResult) {
    if (this.searchCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest !== undefined) this.searchCache.delete(oldest);
    }
    this.searchCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
  }

  /**
   * Retries once with a fresh token when Spotify rejects the cached one.
   */
  private async requestWithAuth<T>(url: string, params: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getAccessToken();

      try {
        const response = await axios.get<T>(url, {
          params,
          headers: { 'Authorization': `Bearer ${token}` },
        });
        return response.data;
      } catch (error: any) {
        const status = error.response?.status;

        if (status === 401 && attempt === 0) {
          this.invalidateToken();
          continue;
        }
        if (status === 401) {
          this.invalidateToken();
          throw new SpotifyUnavailableError('Spotify authentication rejected');
        }
        if (status === 429) {
          throw new SpotifyRateLimitError('Spotify rate limit reached');
        }
        if (status === 404) {
          throw new SpotifyNotFoundError('Resource not found on Spotify');
        }

        console.error('Spotify request error:', error.response?.data || error.message);
        throw new SpotifyUnavailableError('Spotify request failed');
      }
    }

    throw new SpotifyUnavailableError('Spotify request failed');
  }

  async searchTracks(query: string, limit: number = 10, offset: number = 0): Promise<SearchResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return { tracks: [], total: 0, limit, offset };
    }

    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), MAX_LIMIT);
    const safeOffset = Math.min(Math.max(Math.trunc(offset) || 0, 0), MAX_OFFSET);

    const cacheKey = `${trimmed.toLowerCase()}|${safeLimit}|${safeOffset}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const data = await this.requestWithAuth<SpotifySearchResponse>(
      'https://api.spotify.com/v1/search',
      {
        q: trimmed,
        type: 'track',
        limit: safeLimit,
        offset: safeOffset,
        market: 'IT', // Italian market
      }
    );

    const tracks = data.tracks.items.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      artistId: track.artists[0]?.id,
      album: track.album.name,
      albumId: track.album.id,
      albumCover: track.album.images[0]?.url || null,
      albumCoverSmall: track.album.images[2]?.url || track.album.images[0]?.url || null,
      duration: track.duration_ms,
      durationFormatted: this.formatDuration(track.duration_ms),
      spotifyUrl: track.external_urls.spotify,
    }));

    const payload = {
      tracks,
      total: data.tracks.total,
      limit: data.tracks.limit,
      offset: data.tracks.offset,
    };

    this.setCached(cacheKey, payload);

    return payload;
  }

  async getTrack(trackId: string) {
    const track = await this.requestWithAuth<SpotifyTrack>(
      `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`,
      { market: 'IT' }
    );

    return {
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      album: track.album.name,
      albumCover: track.album.images[0]?.url || null,
      duration: track.duration_ms,
      durationFormatted: this.formatDuration(track.duration_ms),
      spotifyUrl: track.external_urls.spotify,
    };
  }

  private formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}

export const spotifyService = new SpotifyService();
