import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VaultSettingsSync, type VsDrive, type VsVault } from './vault-settings';
import { setSyncVaultSettings } from './tree-mirror';

const FOLDER = 'application/vnd.google-apps.folder';

/** Vault local en mémoire : chemin -> contenu (les dossiers ont la valeur null). */
function fakeVault(files: Record<string, string | null>): VsVault & { files: Record<string, string | null> } {
  return {
    files,
    listChildren(path) {
      const prefix = path ? `${path}/` : '';
      const seen = new Map<string, boolean>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split('/')[0];
        const isFolder = rest.includes('/') || files[`${prefix}${name}`] === null;
        if (!seen.has(name)) seen.set(name, isFolder);
      }
      return [...seen].map(([name, isFolder]) => ({ name, isFolder }));
    },
    async exists(p) { return p in files; },
    async readText(p) { return files[p] ?? ''; },
    async writeText(p, d) { files[p] = d; },
    async createFolder(p) { if (!(p in files)) files[p] = null; },
  };
}

/** Drive en mémoire : id -> {name, mimeType, parent, content}. */
function fakeDrive(seed: { id: string; name: string; parent: string; folder?: boolean; content?: string }[] = []) {
  const nodes = new Map(seed.map((n) => [n.id, { ...n }]));
  let seq = 0;
  const drive: VsDrive = {
    async children(folderId) {
      return [...nodes.values()].filter((n) => n.parent === folderId)
        .map((n) => ({ id: n.id, name: n.name, mimeType: n.folder ? FOLDER : 'text/plain' }));
    },
    async createDriveFolder(parentId, name) {
      const id = `f${++seq}`; nodes.set(id, { id, name, parent: parentId, folder: true }); return { id };
    },
    async createFile(parentId, name, content) {
      const id = `n${++seq}`; nodes.set(id, { id, name, parent: parentId, content }); return { id };
    },
    async updateText(fileId, content) { const n = nodes.get(fileId); if (n) n.content = content; },
    async readText(fileId) { return nodes.get(fileId)?.content ?? ''; },
  };
  return { drive, nodes };
}

beforeEach(() => setSyncVaultSettings(false));
afterEach(() => setSyncVaultSettings(false));

describe('VaultSettingsSync.push (local → Drive)', () => {
  it('crée .obsidian et ses fichiers quand rien n existe sur Drive', async () => {
    const vault = fakeVault({ '.obsidian': null, '.obsidian/app.json': '{"a":1}' });
    const { drive, nodes } = fakeDrive();
    const res = await new VaultSettingsSync(vault, drive).push('ROOT');
    expect(res.created).toBe(1);
    expect([...nodes.values()].some((n) => n.name === '.obsidian' && n.folder)).toBe(true);
    expect([...nodes.values()].find((n) => n.name === 'app.json')?.content).toBe('{"a":1}');
  });

  it('MET À JOUR un fichier déjà présent au lieu de le sauter (le bug à éviter)', async () => {
    const vault = fakeVault({ '.obsidian': null, '.obsidian/app.json': 'NOUVEAU' });
    const { drive, nodes } = fakeDrive([
      { id: 'D', name: '.obsidian', parent: 'ROOT', folder: true },
      { id: 'A', name: 'app.json', parent: 'D', content: 'ANCIEN' },
    ]);
    const res = await new VaultSettingsSync(vault, drive).push('ROOT');
    expect(res.updated).toBe(1);
    expect(res.created).toBe(0);
    expect(nodes.get('A')?.content).toBe('NOUVEAU');
    // pas de doublon de dossier
    expect([...nodes.values()].filter((n) => n.name === '.obsidian').length).toBe(1);
  });

  it('n envoie JAMAIS les réglages de drive-on-demand ni workspace.json', async () => {
    const vault = fakeVault({
      '.obsidian': null,
      '.obsidian/app.json': 'ok',
      '.obsidian/workspace.json': 'layout',
      '.obsidian/plugins': null,
      '.obsidian/plugins/drive-on-demand': null,
      '.obsidian/plugins/drive-on-demand/data.json': 'TOKEN_SECRET',
      '.obsidian/plugins/dataview': null,
      '.obsidian/plugins/dataview/data.json': 'reglages dataview',
    });
    const { drive, nodes } = fakeDrive();
    await new VaultSettingsSync(vault, drive).push('ROOT');
    const names = [...nodes.values()].map((n) => n.name);
    const contents = [...nodes.values()].map((n) => n.content);
    expect(contents).not.toContain('TOKEN_SECRET');
    expect(names).not.toContain('workspace.json');
    expect(names).not.toContain('drive-on-demand');
    expect(contents).toContain('reglages dataview'); // les autres plugins passent
  });
});

describe('VaultSettingsSync.pull (Drive → local)', () => {
  it('renvoie "absent" si aucun .obsidian sur Drive', async () => {
    const vault = fakeVault({ '.obsidian': null });
    const { drive } = fakeDrive();
    expect(await new VaultSettingsSync(vault, drive).pull('ROOT')).toBe('absent');
  });

  it('ÉCRASE le fichier local avec la version Drive', async () => {
    const vault = fakeVault({ '.obsidian': null, '.obsidian/app.json': 'LOCAL' });
    const { drive } = fakeDrive([
      { id: 'D', name: '.obsidian', parent: 'ROOT', folder: true },
      { id: 'A', name: 'app.json', parent: 'D', content: 'DISTANT' },
    ]);
    const res = await new VaultSettingsSync(vault, drive).pull('ROOT');
    expect(res).toEqual({ pulled: 1 });
    expect(vault.files['.obsidian/app.json']).toBe('DISTANT');
  });

  it('n écrase JAMAIS les réglages locaux de drive-on-demand', async () => {
    const vault = fakeVault({ '.obsidian': null, '.obsidian/plugins/drive-on-demand/data.json': 'MON_TOKEN' });
    const { drive } = fakeDrive([
      { id: 'D', name: '.obsidian', parent: 'ROOT', folder: true },
      { id: 'P', name: 'plugins', parent: 'D', folder: true },
      { id: 'X', name: 'drive-on-demand', parent: 'P', folder: true },
      { id: 'Z', name: 'data.json', parent: 'X', content: 'TOKEN_DE_LAUTRE_APPAREIL' },
    ]);
    await new VaultSettingsSync(vault, drive).pull('ROOT');
    expect(vault.files['.obsidian/plugins/drive-on-demand/data.json']).toBe('MON_TOKEN');
  });

  it('restaure l état de l option après coup (pas de fuite du flag global)', async () => {
    const vault = fakeVault({ '.obsidian': null });
    const { drive } = fakeDrive();
    await new VaultSettingsSync(vault, drive).pull('ROOT');
    // hors opération, .obsidian doit rester ignoré
    const { isIgnored } = await import('./tree-mirror');
    expect(isIgnored('.obsidian/app.json')).toBe(true);
  });
});
