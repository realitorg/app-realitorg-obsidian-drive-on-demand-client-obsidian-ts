import { describe, it, expect, vi } from 'vitest';
import { exchangeCodeForTokens, refreshAccessToken, TOKEN_ENDPOINT } from './google-oauth';
import type { HttpFn, HttpResponse } from '../http';

function httpReturning(status: number, body: unknown): { http: HttpFn; calls: Array<{ url: string; method?: string; body?: string }> } {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const http: HttpFn = async (req) => {
    calls.push({ url: req.url, method: req.method, body: typeof req.body === 'string' ? req.body : undefined });
    return {
      status,
      text: JSON.stringify(body),
      json<T = unknown>(): T { return body as T; },
    };
  };
  return { http, calls };
}

const CREDS = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://bounce/callback' };

describe('exchangeCodeForTokens', () => {
  it('poste le grant authorization_code en form-urlencoded et renvoie les tokens', async () => {
    const { http, calls } = httpReturning(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3599 });
    const res = await exchangeCodeForTokens(http, 'the-code', CREDS);

    expect(res).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3599 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TOKEN_ENDPOINT);
    expect(calls[0].method).toBe('POST');
    const params = new URLSearchParams(calls[0].body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('secret');
    expect(params.get('redirect_uri')).toBe('https://bounce/callback');
  });

  it('lève une erreur explicite sur réponse non-200', async () => {
    const { http } = httpReturning(400, { error: 'invalid_grant' });
    await expect(exchangeCodeForTokens(http, 'bad', CREDS)).rejects.toThrow(/invalid_grant/);
  });
});

describe('refreshAccessToken', () => {
  it('poste le grant refresh_token et renvoie le nouvel access token', async () => {
    const { http, calls } = httpReturning(200, { access_token: 'AT2', expires_in: 3599 });
    const res = await refreshAccessToken(http, 'RT', { clientId: 'cid', clientSecret: 'secret' });

    expect(res).toEqual({ accessToken: 'AT2', expiresIn: 3599 });
    const params = new URLSearchParams(calls[0].body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('RT');
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('secret');
  });

  it('lève sur non-200 (refresh révoqué)', async () => {
    const { http } = httpReturning(400, { error: 'invalid_grant' });
    await expect(refreshAccessToken(http, 'RT', { clientId: 'cid', clientSecret: 'secret' })).rejects.toThrow(/invalid_grant/);
  });
});
