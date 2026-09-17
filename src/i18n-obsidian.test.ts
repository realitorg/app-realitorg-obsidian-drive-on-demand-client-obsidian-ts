import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', () => ({ getLanguage: () => 'fr' }));

describe('detectLang dans Obsidian', () => {
  it('suit la langue donnée par getLanguage', async () => {
    const { detectLang } = await import('./i18n');
    expect(detectLang()).toBe('fr');
  });
});
