import { describe, it, expect } from 'vitest';
import { buildConsentUrl } from './oauth-url';

describe('buildConsentUrl', () => {
  const url = buildConsentUrl({
    clientId: 'cid.apps.googleusercontent.com',
    redirectUri: 'https://obsidian-drive-on-demand-server.real-it.org/callback',
    scope: 'https://www.googleapis.com/auth/drive',
    state: 'abc123',
  });
  const parsed = new URL(url);

  it('cible le endpoint de consentement Google', () => {
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('inclut les paramètres requis pour un refresh token', () => {
    expect(parsed.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('state')).toBe('abc123');
    expect(parsed.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://obsidian-drive-on-demand-server.real-it.org/callback');
  });
});
