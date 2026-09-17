import { describe, it, expect } from 'vitest';
import { TreeMirror, isIgnored, type VaultOps, setConfigDir } from './tree-mirror';
import { MirrorIndex } from './mirror-index';
import type { DriveNode } from '../drive/drive-client';
import type { PersistAdapter } from '../auth/token-store';

// Dans Obsidian, le plugin lit ce dossier dans Vault#configDir au chargement.
setConfigDir('.obsidian');

function fakeVault() {
  const files = new Set<string>();
  const folders = new Set<string>();
  const vault: VaultOps = {
    exists: async (p) => files.has(p) || folders.has(p),
    createFolder: async (p) => { folders.add(p); },
    createStub: async (p) => { files.add(p); },
    writeText: async (p) => { files.add(p); },
    writeBinary: async (p) => { files.add(p); },
    readText: async () => '',
    readBinary: async () => new ArrayBuffer(0),
    remove: async (p) => { files.delete(p); folders.delete(p); },
    isEmptyFolder: (p) => folders.has(p) && ![...files, ...folders].some((x) => x.startsWith(p + '/')),
    rename: async () => {}, listChildren: () => [],
  };
  return { vault, files, folders };
}
function idx() {
  const raw: Record<string, unknown> = {};
  const adapter: PersistAdapter = { async load() { return raw; }, async save(d) { Object.assign(raw, d); } };
  return new MirrorIndex(adapter);
}
const node = (path: string, isFolder: boolean): DriveNode => ({
  id: `id:${path}`, name: path.split('/').pop()!, mimeType: isFolder ? 'application/vnd.google-apps.folder' : 'text/markdown',
  modifiedTime: 't', path, isFolder,
});

describe('isIgnored', () => {
  it('ignore tout chemin sous .obsidian', () => {
    expect(isIgnored('.obsidian')).toBe(true);
    expect(isIgnored('.obsidian/plugins/google-drive-fod/data.json')).toBe(true);
    expect(isIgnored('.obsidian/themes/foo.css')).toBe(true);
    expect(isIgnored('sous-dossier/.obsidian/x.md')).toBe(true);
    expect(isIgnored('notes/a.md')).toBe(false);
  });

  it('ignore tout chemin contenant un segment de traversée (.. ou .) — sécurité', () => {
    // un nom Drive (contrôlé par le compte connecté ou tout collaborateur qui y
    // partage un fichier) peut contenir '..' ou '/' arbitrairement : ce chemin ne
    // doit JAMAIS atteindre une opération fichier, sous peine d'écrire hors du vault.
    expect(isIgnored('../../etc/passwd')).toBe(true);
    expect(isIgnored('dossier/../../../etc/passwd')).toBe(true);
    expect(isIgnored('dossier/..')).toBe(true);
    expect(isIgnored('dossier/./fichier.md')).toBe(true);
    expect(isIgnored('a//b')).toBe(true); // segment vide
  });

  it('n autorise pas un dotfile légitime à passer pour de la traversée', () => {
    expect(isIgnored('MonPlan/.leplan')).toBe(false);
    expect(isIgnored('.config-perso')).toBe(false);
  });
});

describe('TreeMirror.sync', () => {
  it('crée dossiers + stubs, remplit l index, ignore le dossier du plugin lui-même', async () => {
    const { vault, files, folders } = fakeVault();
    const index = idx();
    await index.load();
    const nodes: DriveNode[] = [
      node('cycles', true),
      node('cycles/jan.md', false),
      node('note.md', false),
      node('.obsidian/plugins/google-drive-fod', true),
      node('.obsidian/plugins/google-drive-fod/data.json', false),
    ];
    const r = new TreeMirror(vault, index);
    const out = await r.sync(nodes);

    expect(folders.has('cycles')).toBe(true);
    expect(files.has('cycles/jan.md')).toBe(true);
    expect(files.has('note.md')).toBe(true);
    // le dossier du plugin lui-même reste ignoré
    expect(folders.has('.obsidian/plugins/google-drive-fod')).toBe(false);
    expect(files.has('.obsidian/plugins/google-drive-fod/data.json')).toBe(false);
    // index peuplé (non-ignorés uniquement)
    expect(index.get('note.md')?.hydrated).toBe(false);
    expect(index.get('cycles')?.isFolder).toBe(true);
    expect(index.has('.obsidian/plugins/google-drive-fod')).toBe(false);
    expect(out.created).toBe(3);
  });

  it('ne recrée pas un chemin déjà présent (skipped)', async () => {
    const { vault, files } = fakeVault();
    files.add('note.md');
    const index = idx();
    await index.load();
    const out = await new TreeMirror(vault, index).sync([node('note.md', false)]);
    expect(out.created).toBe(0);
    expect(out.skipped).toBe(1);
  });

  it('re-sync préserve hydrated/pinned mais rafraîchit les métadonnées Drive', async () => {
    const { vault } = fakeVault();
    const index = idx();
    await index.load();
    const n1 = { ...node('note.md', false), headRevisionId: 'rev1' };
    const r = new TreeMirror(vault, index);
    await r.sync([n1]);
    // simule un fichier hydraté + épinglé par l'utilisateur
    const e = index.get('note.md')!;
    e.hydrated = true;
    e.pinned = true;
    await index.set('note.md', e);
    // re-sync avec une nouvelle révision Drive
    await r.sync([{ ...node('note.md', false), headRevisionId: 'rev2' }]);
    const after = index.get('note.md')!;
    expect(after.hydrated).toBe(true);
    expect(after.pinned).toBe(true);
    expect(after.headRevisionId).toBe('rev2');
  });

  it('ne marque PAS hydratable un fichier préexistant inconnu de l index (sécurité anti-écrasement)', async () => {
    const { vault, files } = fakeVault();
    files.add('perso.md'); // fichier utilisateur déjà présent, absent de l'index
    const index = idx();
    await index.load();
    const out = await new TreeMirror(vault, index).sync([node('perso.md', false)]);
    expect(out.skipped).toBe(1);
    // marqué hydraté → l'Hydrator renverra 'already', jamais de download par-dessus le fichier réel
    expect(index.get('perso.md')?.hydrated).toBe(true);
  });
});
