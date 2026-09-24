import { describe, it, expect } from 'vitest';
import { isNetworkError } from './network-error';

describe('isNetworkError', () => {
  it('requête jamais aboutie → réseau', () => {
    expect(isNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true);
    expect(isNetworkError(new Error('The Internet connection appears to be offline.'))).toBe(true);
  });
  it('réponse du drive ou connexion à refaire → pas réseau', () => {
    expect(isNetworkError(new Error('Drive getRevision 404'))).toBe(false);
    expect(isNetworkError(new Error('Drive moveFile(get parents) 403: nope'))).toBe(false);
    expect(isNetworkError(new Error('NEED_INTERACTIVE_AUTH'))).toBe(false);
  });
});
