import { Vault, TFile, TFolder, normalizePath, type TAbstractFile } from 'obsidian';
import { hasUnsafeSegment, type VaultOps } from './tree-mirror';

/** Vrai si un segment du chemin commence par '.' SANS être une traversée de
 *  répertoire ('.', '..' — voir hasUnsafeSegment, toujours rejetée en amont).
 *  L'API haut-niveau d'Obsidian (getAbstractFileByPath, create, modify, createFolder)
 *  n'indexe JAMAIS ces chemins dotés — seul le bas-niveau vault.adapter les voit. Pour
 *  ces chemins on passe donc systématiquement par l'adapter, sinon toute création lève
 *  « File already exists » (le create réussit sur disque mais reste invisible à l'API,
 *  qui retente un create au write suivant). */
export function isDotPath(path: string): boolean {
  return normalizePath(path)
    .split('/')
    .some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
}

/** Rejette tout chemin contenant un segment de traversée. isIgnored() (tree-mirror.ts)
 *  filtre déjà ces chemins en amont de chaque appelant — ce garde est un second rempart
 *  au niveau de la couche qui touche réellement le disque (fail loud, jamais silencieux). */
function assertSafePath(p: string): void {
  if (hasUnsafeSegment(p)) throw new Error(`Chemin non sûr refusé (traversée de répertoire) : ${p}`);
}

export class ObsidianVaultOps implements VaultOps {
  /** `trashFile` : `FileManager#trashFile`, qui suit la préférence de suppression de
   *  l'utilisateur (corbeille système, `.trash` du vault ou suppression définitive). */
  constructor(
    private vault: Vault,
    private trashFile: (file: TAbstractFile) => Promise<void>,
    private markCreated?: (path: string) => void,
  ) {}

  async exists(path: string): Promise<boolean> {
    const p = normalizePath(path);
    assertSafePath(p);
    if (isDotPath(p)) return this.vault.adapter.exists(p);
    return this.vault.getAbstractFileByPath(p) !== null;
  }

  async createFolder(path: string): Promise<void> {
    const p = normalizePath(path);
    assertSafePath(p);
    if (isDotPath(p)) {
      if (!(await this.vault.adapter.exists(p))) {
        this.markCreated?.(p);
        await this.vault.adapter.mkdir(p);
      }
      return;
    }
    if (this.vault.getAbstractFileByPath(p) !== null) return;
    this.markCreated?.(p);
    try {
      await this.vault.createFolder(p);
    } catch (e) {
      // Course : un autre appel a créé le dossier entre notre vérification et la création.
      // Idempotent pour nous — seulement une vraie erreur si le dossier n'existe toujours pas.
      if (this.vault.getAbstractFileByPath(p) === null) throw e;
    }
  }

  async createStub(path: string): Promise<void> {
    const p = normalizePath(path);
    assertSafePath(p);
    if (isDotPath(p)) {
      if (!(await this.vault.adapter.exists(p))) {
        this.markCreated?.(p);
        await this.vault.adapter.write(p, ''); // create-or-noop, ne tronque pas un existant
      }
      return;
    }
    if (this.vault.getAbstractFileByPath(p) === null) {
      this.markCreated?.(p);
      await this.vault.create(p, '');
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    assertSafePath(p);
    if (isDotPath(p)) {
      this.markCreated?.(p);
      await this.vault.adapter.write(p, data); // create-or-overwrite, ne lève jamais
      return;
    }
    const f = this.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) await this.vault.modify(f, data);
    else {
      this.markCreated?.(p);
      await this.vault.create(p, data);
    }
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const p = normalizePath(path);
    assertSafePath(p);
    if (isDotPath(p)) {
      this.markCreated?.(p);
      await this.vault.adapter.writeBinary(p, data);
      return;
    }
    const f = this.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) await this.vault.modifyBinary(f, data);
    else {
      this.markCreated?.(p);
      await this.vault.createBinary(p, data);
    }
  }

  async readText(path: string): Promise<string> {
    const p = normalizePath(path);
    assertSafePath(p);
    if (isDotPath(p)) return this.vault.adapter.read(p);
    const f = this.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) throw new Error(`Fichier introuvable: ${path}`);
    return this.vault.read(f);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const p = normalizePath(path);
    assertSafePath(p);
    if (isDotPath(p)) return this.vault.adapter.readBinary(p);
    const f = this.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) throw new Error(`Fichier introuvable: ${path}`);
    return this.vault.readBinary(f);
  }

  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    assertSafePath(p);
    if (isDotPath(p)) {
      if (await this.vault.adapter.exists(p)) await this.vault.adapter.trashLocal(p);
      return;
    }
    const f = this.vault.getAbstractFileByPath(p);
    if (f) await this.trashFile(f);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const op = normalizePath(oldPath);
    const np = normalizePath(newPath);
    assertSafePath(op);
    assertSafePath(np);
    const f = this.vault.getAbstractFileByPath(op);
    if (!f) return; // rien à renommer localement
    // crée les dossiers parents de destination si besoin (déplacement vers un nouveau dossier)
    const parent = np.split('/').slice(0, -1).join('/');
    if (parent) await this.createFolder(parent);
    await this.vault.rename(f, np);
  }

  isEmptyFolder(path: string): boolean {
    // Dossiers dotés (rares hors .obsidian, déjà exclu) : non gérés par l'API Vault ;
    // au pire un dossier doté vide n'est pas élagué (fuite bénigne, jamais un crash).
    const f = this.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFolder && f.children.length === 0;
  }

  listChildren(path: string): { name: string; isFolder: boolean }[] {
    const folder = path === '' ? this.vault.getRoot() : this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(folder instanceof TFolder)) return [];
    return folder.children.map((c) => ({ name: c.name, isFolder: c instanceof TFolder }));
  }

  /** Comme listChildren, mais fonctionne AUSSI dans les dossiers en point (`.obsidian`).
   *  L'API Vault d'Obsidian n'indexe pas les chemins commençant par un point : seul
   *  `vault.adapter` les voit — et il est asynchrone, d'où cette méthode séparée. */
  async listDir(path: string): Promise<{ name: string; isFolder: boolean }[]> {
    if (!isDotPath(path)) return this.listChildren(path);
    const base = (full: string) => full.split('/').pop() as string;
    try {
      const { files, folders } = await this.vault.adapter.list(normalizePath(path));
      return [
        ...folders.map((f) => ({ name: base(f), isFolder: true })),
        ...files.map((f) => ({ name: base(f), isFolder: false })),
      ];
    } catch {
      return []; // dossier absent
    }
  }
}
