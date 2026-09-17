import { describe, it, expect, vi } from 'vitest';

// Obsidian antérieur à 1.8.7 : pas de getLanguage, la locale de moment fait foi.
// getLanguage déclaré absent : vitest refuse l'accès à un export non déclaré du mock.
vi.mock('obsidian', () => ({ getLanguage: undefined, moment: { locale: () => 'fr' } }));

describe('detectLang avant getLanguage', () => {
  it('suit la locale de moment', async () => {
    const { detectLang } = await import('./i18n');
    expect(detectLang()).toBe('fr');
  });
});
