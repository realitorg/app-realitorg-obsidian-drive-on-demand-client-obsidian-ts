import { describe, it, expect } from 'vitest';
import { utf8ToBase64, base64ToUtf8 } from './base64';

describe('base64 UTF-8', () => {
  it("produit exactement l'encodage historique (escape/unescape)", () => {
    for (const s of ['', 'abc', 'é€😀 accentué', '1//0gX-token_ÿ']) {
      const historique = btoa(unescape(encodeURIComponent(s)));
      expect(utf8ToBase64(s)).toBe(historique);
      expect(base64ToUtf8(historique)).toBe(s);
    }
  });
});
