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
  preview_url: string | null;
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

class SpotifyService {
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor() {
    this.clientId = process.env.SPOTIFY_CLIENT_ID || '';
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';
  }

  private async getAccessToken(): Promise<string> {
    // Check if we have a valid token
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    // Get new token using Client Credentials Flow
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
      throw new Error('Failed to authenticate with Spotify');
    }
  }

  async searchTracks(query: string, limit: number = 10, offset: number = 0) {
    if (!query || query.trim().length === 0) {
      return { tracks: [], total: 0 };
    }

    const token = await this.getAccessToken();

    try {
      const response = await axios.get<SpotifySearchResponse>(
        'https://api.spotify.com/v1/search',
        {
          params: {
            q: query,
            type: 'track',
            limit,
            offset,
            market: 'IT', // Italian market
          },
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );

      const tracks = response.data.tracks.items.map(track => ({
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
        previewUrl: track.preview_url,
        spotifyUrl: track.external_urls.spotify,
      }));

      return {
        tracks,
        total: response.data.tracks.total,
        limit: response.data.tracks.limit,
        offset: response.data.tracks.offset,
      };
    } catch (error: any) {
      console.error('Spotify search error:', error.response?.data || error.message);
      throw new Error('Failed to search Spotify');
    }
  }

  async getTrack(trackId: string) {
    const token = await this.getAccessToken();

    try {
      const response = await axios.get<SpotifyTrack>(
        `https://api.spotify.com/v1/tracks/${trackId}`,
        {
          params: { market: 'IT' },
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );

      const track = response.data;
      return {
        id: track.id,
        name: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        album: track.album.name,
        albumCover: track.album.images[0]?.url || null,
        duration: track.duration_ms,
        durationFormatted: this.formatDuration(track.duration_ms),
        previewUrl: track.preview_url,
        spotifyUrl: track.external_urls.spotify,
      };
    } catch (error: any) {
      console.error('Spotify get track error:', error.response?.data || error.message);
      throw new Error('Failed to get track from Spotify');
    }
  }

  private formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}

export const spotifyService = new SpotifyService();
