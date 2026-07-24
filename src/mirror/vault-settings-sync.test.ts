import { describe, it, expect, afterEach } from 'vitest';
import { isIgnored, setSyncVaultSettings } from './tree-mirror';

afterEach(() => setSyncVaultSettings(false)); // état par défaut

describe('isIgnored — option « synchroniser les réglages du vault » DÉSACTIVÉE (défaut)', () => {
  it('ignore tout .obsidian (comportement historique préservé)', () => {
    expect(isIgnored('.obsidian/app.json')).toBe(true);
    expect(isIgnored('.obsidian/plugins/dataview/data.json')).toBe(true);
    expect(isIgnored('.obsidian')).toBe(true);
  });

  it('ne touche pas aux notes normales', () => {
    expect(isIgnored('notes/a.md')).toBe(false);
    expect(isIgnored('.leplan')).toBe(false); // dotfile légitime hors .obsidian
  });
});

describe('isIgnored — option ACTIVÉE', () => {
  it('synchronise les réglages Obsidian courants', () => {
    setSyncVaultSettings(true);
    for (const p of [
      '.obsidian/app.json',
      '.obsidian/appearance.json',
      '.obsidian/hotkeys.json',
      '.obsidian/core-plugins.json',
      '.obsidian/community-plugins.json',
      '.obsidian/snippets/perso.css',
      '.obsidian/themes/Minimal/theme.css',
    ]) {
      expect(isIgnored(p), p).toBe(false);
    }
  });

  it('synchronise les réglages des AUTRES plugins (data.json inclus)', () => {
    setSyncVaultSettings(true);
    expect(isIgnored('.obsidian/plugins/dataview/data.json')).toBe(false);
    expect(isIgnored('.obsidian/plugins/dataview/main.js')).toBe(false);
  });

  it('EXCLUT toujours notre propre plugin (token OAuth + anti-boucle)', () => {
    setSyncVaultSettings(true);
    expect(isIgnored('.obsidian/plugins/drive-on-demand/data.json')).toBe(true);
    expect(isIgnored('.obsidian/plugins/drive-on-demand/main.js')).toBe(true);
    expect(isIgnored('.obsidian/plugins/drive-on-demand')).toBe(true);
    expect(isIgnored('.obsidian/plugins/google-drive-fod/data.json')).toBe(true); // ancien id
  });

  it('EXCLUT les fichiers de disposition propres à l appareil', () => {
    setSyncVaultSettings(true);
    expect(isIgnored('.obsidian/workspace.json')).toBe(true);
    expect(isIgnored('.obsidian/workspace-mobile.json')).toBe(true);
  });

  it('la sécurité anti-traversée reste prioritaire', () => {
    setSyncVaultSettings(true);
    expect(isIgnored('.obsidian/../../etc/passwd')).toBe(true);
    expect(isIgnored('notes/../../x')).toBe(true);
  });
});
