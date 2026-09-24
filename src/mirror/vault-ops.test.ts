import { describe, it, expect, beforeEach, vi } from 'vitest';
// 'obsidian' est aliasé vers un stub minimal (voir vitest.config.ts). Le comportement
// critique reproduit ici : l'API haut-niveau Vault (getAbstractFileByPath, create,
// modify, createFolder) est AVEUGLE aux chemins dont un segment commence par '.'
// (dotfiles/dotfolders), alors que le bas-niveau vault.adapter, lui, les voit.
import { TFile, TFolder } from 'obsidian';
import { ObsidianVaultOps, isDotPath } from './vault-ops';

/** Faux Vault Obsidian : le store `disk` (adapter) voit tout ; la vue Vault haut-niveau
 *  (`tracked`) ignore délibérément les chemins dotés — comme le vrai Obsidian. */
const mkFile = (p: string): TFile => Object.assign(new TFile(), { path: p });
const mkFolder = (p: string): TFolder => Object.assign(new TFolder(), { path: p, children: [] });

function fakeObsidian() {
  const disk = new Map<string, string | ArrayBuffer>(); // ce que voit vault.adapter
  const tracked = new Map<string, TFile | TFolder>(); // ce qu'indexe l'API Vault (jamais les dotpaths)

  const adapter = {
    exists: async (p: string) => disk.has(p),
    read: async (p: string) => {
      const v = disk.get(p);
      if (typeof v !== 'string') throw new Error(`ENOENT ${p}`);
      return v;
    },
    readBinary: async (p: string) => {
      const v = disk.get(p);
      if (!(v instanceof ArrayBuffer)) throw new Error(`ENOENT ${p}`);
      return v;
    },
    write: async (p: string, data: string) => { disk.set(p, data); },
    writeBinary: async (p: string, data: ArrayBuffer) => { disk.set(p, data); },
    remove: async (p: string) => { disk.delete(p); },
    mkdir: async (_p: string) => {},
    list: async (p: string) => {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const files: string[] = [];
      const folders = new Set<string>();
      for (const k of disk.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes('/')) folders.add(prefix + rest.split('/')[0]);
        else files.push(k);
      }
      return { files, folders: [...folders] };
    },
    trashLocal: async (p: string) => { disk.delete(p); },
  };

  const vault = {
    adapter,
    getAbstractFileByPath: (p: string) => tracked.get(p) ?? null,
    create: async (p: string, data: string) => {
      if (disk.has(p)) throw new Error('File already exists.');
      disk.set(p, data);
      const f = mkFile(p);
      if (!isDotPath(p)) tracked.set(p, f); // Obsidian n'indexe jamais un dotpath
      return f;
    },
    createBinary: async (p: string, data: ArrayBuffer) => {
      if (disk.has(p)) throw new Error('File already exists.');
      disk.set(p, data);
      const f = mkFile(p);
      if (!isDotPath(p)) tracked.set(p, f);
      return f;
    },
    createFolder: async (p: string) => {
      if (disk.has('DIR:' + p)) throw new Error('Folder already exists.');
      disk.set('DIR:' + p, '');
      if (!isDotPath(p)) tracked.set(p, mkFolder(p));
    },
    modify: async (f: TFile, data: string) => { disk.set(f.path, data); },
    modifyBinary: async (f: TFile, data: ArrayBuffer) => { disk.set(f.path, data); },
    read: async (f: TFile) => disk.get(f.path) as string,
    readBinary: async (f: TFile) => disk.get(f.path) as ArrayBuffer,
    trash: async (f: TFile | TFolder) => { disk.delete(f.path); tracked.delete(f.path); },
  };

  return { vault, disk, tracked, adapter };
}

describe('isDotPath', () => {
  it('détecte un fichier doté à la racine', () => {
    expect(isDotPath('.leplan')).toBe(true);
  });
  it('détecte un fichier doté dans un dossier normal', () => {
    expect(isDotPath('MonPlan/.leplan')).toBe(true);
  });
  it('détecte un segment dossier doté', () => {
    expect(isDotPath('.config/settings.md')).toBe(true);
  });
  it('rejette un chemin sans segment doté', () => {
    expect(isDotPath('MonPlan/note.md')).toBe(false);
    expect(isDotPath('dossier/sous/fichier.txt')).toBe(false);
  });
});

describe('ObsidianVaultOps — support des dotfiles (via adapter)', () => {
  let fake: ReturnType<typeof fakeObsidian>;
  let ops: ObsidianVaultOps;
  beforeEach(() => {
    fake = fakeObsidian();
    ops = new ObsidianVaultOps(fake.vault as never, (f) => fake.vault.trash(f as never));
  });

  it('createStub puis writeText sur un dotfile ne lève JAMAIS "File already exists"', async () => {
    // Reproduit exactement la séquence materialize→hydrate qui plantait.
    await ops.createStub('MonPlan/.leplan');
    await expect(ops.writeText('MonPlan/.leplan', '{"solde":100}')).resolves.toBeUndefined();
    expect(fake.disk.get('MonPlan/.leplan')).toBe('{"solde":100}');
  });

  it('exists() voit un dotfile présent sur le disque (adapter), malgré l API Vault aveugle', async () => {
    fake.disk.set('MonPlan/.leplan', 'x');
    expect(await ops.exists('MonPlan/.leplan')).toBe(true);
    expect(await ops.exists('MonPlan/.absent')).toBe(false);
  });

  it('createStub ne tronque pas un dotfile existant', async () => {
    fake.disk.set('MonPlan/.leplan', 'contenu existant');
    await ops.createStub('MonPlan/.leplan');
    expect(fake.disk.get('MonPlan/.leplan')).toBe('contenu existant');
  });

  it('readText / remove fonctionnent sur un dotfile', async () => {
    fake.disk.set('MonPlan/.leplan', 'lu');
    expect(await ops.readText('MonPlan/.leplan')).toBe('lu');
    await ops.remove('MonPlan/.leplan');
    expect(await ops.exists('MonPlan/.leplan')).toBe(false);
  });

  it('writeBinary sur un dotfile passe par l adapter sans collision', async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    await ops.createStub('MonPlan/.cache');
    await expect(ops.writeBinary('MonPlan/.cache', buf)).resolves.toBeUndefined();
    expect(fake.disk.get('MonPlan/.cache')).toBe(buf);
  });

  it('chemin normal : comportement inchangé (passe par l API Vault, indexé)', async () => {
    await ops.writeText('MonPlan/note.md', '# hi');
    expect(fake.tracked.has('MonPlan/note.md')).toBe(true); // indexé par Obsidian
    expect(await ops.exists('MonPlan/note.md')).toBe(true);
    expect(await ops.readText('MonPlan/note.md')).toBe('# hi');
  });
});

describe('ObsidianVaultOps — refuse toute traversée de chemin (sécurité)', () => {
  // Un nom Drive malveillant/mal formé ('..' ou contenant '/../') ne doit JAMAIS
  // atteindre vault.adapter (écriture hors vault) ni l'API Vault — quelle que soit
  // la méthode appelée. isIgnored() en amont doit déjà bloquer ces chemins, mais
  // VaultOps refuse aussi en second rempart (défense en profondeur).
  let fake: ReturnType<typeof fakeObsidian>;
  let ops: ObsidianVaultOps;
  beforeEach(() => {
    fake = fakeObsidian();
    ops = new ObsidianVaultOps(fake.vault as never, (f) => fake.vault.trash(f as never));
  });

  const UNSAFE_PATHS = ['../../etc/passwd', 'dossier/../../../etc/passwd', 'dossier/..', 'dossier/./x'];

  it.each(UNSAFE_PATHS)('writeText rejette %s sans jamais écrire', async (p) => {
    await expect(ops.writeText(p, 'malveillant')).rejects.toThrow();
    expect(fake.disk.size).toBe(0);
  });

  it.each(UNSAFE_PATHS)('createStub rejette %s sans jamais écrire', async (p) => {
    await expect(ops.createStub(p)).rejects.toThrow();
    expect(fake.disk.size).toBe(0);
  });

  it.each(UNSAFE_PATHS)('writeBinary rejette %s sans jamais écrire', async (p) => {
    await expect(ops.writeBinary(p, new ArrayBuffer(0))).rejects.toThrow();
    expect(fake.disk.size).toBe(0);
  });

  it.each(UNSAFE_PATHS)('remove rejette %s', async (p) => {
    await expect(ops.remove(p)).rejects.toThrow();
  });

  it.each(UNSAFE_PATHS)('exists rejette %s', async (p) => {
    await expect(ops.exists(p)).rejects.toThrow();
  });

  it.each(UNSAFE_PATHS)('createFolder rejette %s', async (p) => {
    await expect(ops.createFolder(p)).rejects.toThrow();
  });
});

describe('listDir — dossiers dotés (régression : « 0 fichier téléversé »)', () => {
  it('voit le contenu de .obsidian, là où listChildren est aveugle', async () => {
    const { vault, disk } = fakeObsidian();
    disk.set('.obsidian/app.json', '{}');
    disk.set('.obsidian/plugins/dataview/data.json', '{}');
    const ops = new ObsidianVaultOps(vault as never, async () => {}, () => {});

    // l'API Vault n'indexe pas les dotpaths → aveugle
    expect(ops.listChildren('.obsidian')).toEqual([]);

    // listDir passe par vault.adapter → voit tout
    const kids = await ops.listDir('.obsidian');
    expect(kids).toContainEqual({ name: 'app.json', isFolder: false });
    expect(kids).toContainEqual({ name: 'plugins', isFolder: true });
  });

  it('renvoie une liste vide si le dossier n existe pas', async () => {
    const { vault } = fakeObsidian();
    const ops = new ObsidianVaultOps(vault as never, async () => {}, () => {});
    expect(await ops.listDir('.obsidian')).toEqual([]);
  });
});

describe('ObsidianVaultOps — suppressions faites par le plugin', () => {
  it('remove et trashToVault marquent le chemin avant de supprimer ; trashToVault force le .trash du vault', async () => {
    const fake = fakeObsidian();
    const marked: string[] = [];
    const trashFile = vi.fn(async () => {});
    const trashLocal = vi.spyOn(fake.adapter, 'trashLocal');
    const ops = new ObsidianVaultOps(fake.vault as never, trashFile, undefined, (p) => marked.push(p));
    await ops.writeText('a.md', 'x');
    await ops.writeText('b.md', 'y');
    await ops.remove('a.md');
    expect(trashFile).toHaveBeenCalledTimes(1); // préférence de l'utilisateur
    await ops.trashToVault('b.md');
    expect(trashLocal).toHaveBeenCalledWith('b.md');
    expect(marked).toEqual(['a.md', 'b.md']);
  });
});
