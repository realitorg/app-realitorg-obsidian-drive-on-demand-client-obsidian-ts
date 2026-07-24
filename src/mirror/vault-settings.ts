import { isIgnored, setSyncVaultSettings } from './tree-mirror';
import { toNfc } from '../util/nfc';
import type { CancelToken } from '../util/cancel-token';

const SETTINGS_DIR = '.obsidian';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Liste des modules complémentaires ACTIVÉS. L'écraser tel quel désactive tout plugin
 *  absent de la version distante — y compris ceux dont dépend la récupération. */
const ENABLED_PLUGINS_FILE = `${SETTINGS_DIR}/community-plugins.json`;

/** Jamais désactivés par un tirage : sans eux, l'utilisateur ne peut plus ni re-tirer
 *  ses réglages (nous) ni mettre à jour le plugin (BRAT) — impasse sans issue. */
const NEVER_DISABLE = ['drive-on-demand', 'google-drive-fod', 'obsidian42-brat'];

export interface VsVault {
  listDir(path: string): Promise<{ name: string; isFolder: boolean }[]>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  createFolder(path: string): Promise<void>;
}

/** Progression d'un transfert : `done` sur `total` fichiers. */
export type VsProgress = (done: number, total: number) => void;

export interface VsDrive {
  children(folderId: string): Promise<{ id: string; name: string; mimeType: string }[]>;
  createDriveFolder(parentId: string, name: string): Promise<{ id: string }>;
  createFile(parentId: string, name: string, content: string): Promise<{ id: string }>;
  updateText(fileId: string, content: string): Promise<unknown>;
  readText(fileId: string): Promise<string>;
}

/** Transfert PONCTUEL du dossier `.obsidian` (réglages du vault), dans un sens ou l'autre.
 *
 *  Volontairement séparé de la synchronisation continue :
 *   - Obsidian ne lit sa configuration qu'au DÉMARRAGE ; une sync continue n'apporterait
 *     donc rien de plus qu'un transfert explicite, tout en risquant des boucles et une
 *     bagarre avec Obsidian qui réécrit sa config en quittant.
 *   - contrairement à `createUnder` (qui saute un fichier déjà présent sur Drive) et à
 *     `applyFolderSync` (qui ne touche jamais un fichier local existant), on ÉCRASE ici :
 *     c'est le but d'un « téléverser » / « tirer » explicite.
 *
 *  Les exclusions (`.obsidian/plugins/drive-on-demand`, `workspace*.json`, traversées)
 *  sont celles de `isIgnored`, activées le temps de l'opération seulement. */
export class VaultSettingsSync {
  constructor(private vault: VsVault, private drive: VsDrive) {}

  /** Active les exclusions `.obsidian` le temps de `fn`, puis restaure l'état précédent
   *  (le drapeau est global : ne pas le laisser allumé après l'opération). */
  private async withSettingsIncluded<T>(fn: () => Promise<T>): Promise<T> {
    setSyncVaultSettings(true);
    try {
      return await fn();
    } finally {
      setSyncVaultSettings(false);
    }
  }

  private async childByName(parentId: string, name: string) {
    const target = toNfc(name);
    const kids = await this.drive.children(parentId);
    return kids.find((k) => toNfc(k.name) === target);
  }

  private async ensureDriveFolder(parentId: string, name: string): Promise<string> {
    const existing = await this.childByName(parentId, name);
    if (existing && existing.mimeType === DRIVE_FOLDER_MIME) return existing.id;
    return (await this.drive.createDriveFolder(parentId, name)).id;
  }

  /** Local → Drive. Crée ce qui manque, MET À JOUR ce qui existe.
   *  Deux phases : on énumère d'abord pour connaître le total, afin de pouvoir
   *  rapporter une progression réelle (le transfert peut être long). */
  async push(rootDriveId: string, onProgress?: VsProgress, token?: CancelToken): Promise<{ created: number; updated: number }> {
    return this.withSettingsIncluded(async () => {
      const files: string[] = [];
      await this.enumerateLocal(SETTINGS_DIR, files);
      const total = files.length;
      onProgress?.(0, total);

      const stats = { created: 0, updated: 0 };
      const dirIds = new Map<string, string>([[SETTINGS_DIR, await this.ensureDriveFolder(rootDriveId, SETTINGS_DIR)]]);
      let done = 0;
      for (const filePath of files) {
        token?.throwIfCancelled();
        const dir = filePath.slice(0, filePath.lastIndexOf('/'));
        const driveId = await this.ensureDirChain(dir, dirIds);
        const name = filePath.slice(filePath.lastIndexOf('/') + 1);
        const content = await this.vault.readText(filePath);
        const existing = await this.childByName(driveId, name);
        if (existing && existing.mimeType !== DRIVE_FOLDER_MIME) {
          await this.drive.updateText(existing.id, content);
          stats.updated++;
        } else {
          await this.drive.createFile(driveId, name, content);
          stats.created++;
        }
        done++;
        onProgress?.(done, total);
      }
      return stats;
    });
  }

  /** Chemins des fichiers à téléverser (exclusions appliquées), dossiers exclus. */
  private async enumerateLocal(dir: string, acc: string[]): Promise<void> {
    for (const child of await this.vault.listDir(dir)) {
      const childPath = `${dir}/${child.name}`;
      if (isIgnored(childPath)) continue;
      if (child.isFolder) await this.enumerateLocal(childPath, acc);
      else acc.push(childPath);
    }
  }

  /** Id Drive du dossier `dir`, en créant/réutilisant toute la chaîne manquante. */
  private async ensureDirChain(dir: string, cache: Map<string, string>): Promise<string> {
    const known = cache.get(dir);
    if (known) return known;
    const parent = dir.slice(0, dir.lastIndexOf('/'));
    const parentId = await this.ensureDirChain(parent, cache);
    const name = dir.slice(dir.lastIndexOf('/') + 1);
    const id = await this.ensureDriveFolder(parentId, name);
    cache.set(dir, id);
    return id;
  }

  /** Drive → local. ÉCRASE les fichiers locaux. `'absent'` si aucun `.obsidian` sur Drive.
   *  Énumère d'abord (mêmes appels que le parcours, juste faits en amont) pour connaître
   *  le total et rapporter une progression. */
  async pull(rootDriveId: string, onProgress?: VsProgress, token?: CancelToken): Promise<{ pulled: number } | 'absent'> {
    return this.withSettingsIncluded(async () => {
      const dir = await this.childByName(rootDriveId, SETTINGS_DIR);
      if (!dir || dir.mimeType !== DRIVE_FOLDER_MIME) return 'absent' as const;

      await this.vault.createFolder(SETTINGS_DIR);
      const files: { id: string; path: string }[] = [];
      await this.enumerateRemote(dir.id, SETTINGS_DIR, files);
      const total = files.length;
      onProgress?.(0, total);

      let done = 0;
      for (const f of files) {
        token?.throwIfCancelled();
        const remote = await this.drive.readText(f.id);
        const content = f.path === ENABLED_PLUGINS_FILE
          ? await this.mergeEnabledPlugins(remote, f.path)
          : remote;
        await this.vault.writeText(f.path, content);
        done++;
        onProgress?.(done, total);
      }
      return { pulled: done };
    });
  }

  /** Fichiers distants à tirer (exclusions appliquées) ; crée les dossiers locaux au passage. */
  private async enumerateRemote(driveId: string, localPath: string, acc: { id: string; path: string }[]): Promise<void> {
    for (const child of await this.drive.children(driveId)) {
      const childPath = `${localPath}/${toNfc(child.name)}`;
      if (isIgnored(childPath)) continue; // ne jamais écraser NOS réglages locaux
      if (child.mimeType === DRIVE_FOLDER_MIME) {
        await this.vault.createFolder(childPath);
        await this.enumerateRemote(child.id, childPath, acc);
      } else {
        acc.push({ id: child.id, path: childPath });
      }
    }
  }

  /** Fusionne la liste distante des plugins activés avec les indispensables locaux.
   *  La version distante fait foi (ajouts/retraits), SAUF pour NEVER_DISABLE : les
   *  désactiver couperait la branche sur laquelle l'utilisateur est assis.
   *  JSON distant illisible → on garde le local tel quel (jamais de casse). */
  private async mergeEnabledPlugins(remote: string, localPath: string): Promise<string> {
    const local = (await this.vault.exists(localPath)) ? await this.vault.readText(localPath) : '[]';
    const parse = (raw: string): string[] | null => {
      try {
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
      } catch {
        return null;
      }
    };
    const remoteIds = parse(remote);
    if (!remoteIds) return local; // distant corrompu → ne touche à rien
    const localIds = parse(local) ?? [];
    const rescued = localIds.filter((id) => NEVER_DISABLE.includes(id) && !remoteIds.includes(id));
    return JSON.stringify([...remoteIds, ...rescued], null, 2);
  }

}
