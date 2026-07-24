import { isIgnored, setSyncVaultSettings } from './tree-mirror';
import { toNfc } from '../util/nfc';

const SETTINGS_DIR = '.obsidian';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Liste des modules complémentaires ACTIVÉS. L'écraser tel quel désactive tout plugin
 *  absent de la version distante — y compris ceux dont dépend la récupération. */
const ENABLED_PLUGINS_FILE = `${SETTINGS_DIR}/community-plugins.json`;

/** Jamais désactivés par un tirage : sans eux, l'utilisateur ne peut plus ni re-tirer
 *  ses réglages (nous) ni mettre à jour le plugin (BRAT) — impasse sans issue. */
const NEVER_DISABLE = ['drive-on-demand', 'google-drive-fod', 'obsidian42-brat'];

export interface VsVault {
  listChildren(path: string): { name: string; isFolder: boolean }[];
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  createFolder(path: string): Promise<void>;
}

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

  /** Local → Drive. Crée ce qui manque, MET À JOUR ce qui existe. */
  async push(rootDriveId: string): Promise<{ created: number; updated: number }> {
    return this.withSettingsIncluded(async () => {
      const stats = { created: 0, updated: 0 };
      const dirId = await this.ensureDriveFolder(rootDriveId, SETTINGS_DIR);
      await this.pushDir(SETTINGS_DIR, dirId, stats);
      return stats;
    });
  }

  private async ensureDriveFolder(parentId: string, name: string): Promise<string> {
    const existing = await this.childByName(parentId, name);
    if (existing && existing.mimeType === DRIVE_FOLDER_MIME) return existing.id;
    return (await this.drive.createDriveFolder(parentId, name)).id;
  }

  private async pushDir(localPath: string, driveId: string, stats: { created: number; updated: number }): Promise<void> {
    for (const child of this.vault.listChildren(localPath)) {
      const childPath = `${localPath}/${child.name}`;
      if (isIgnored(childPath)) continue; // notre plugin, workspace*.json, traversées
      if (child.isFolder) {
        const subId = await this.ensureDriveFolder(driveId, child.name);
        await this.pushDir(childPath, subId, stats);
        continue;
      }
      const content = await this.vault.readText(childPath);
      const existing = await this.childByName(driveId, child.name);
      if (existing && existing.mimeType !== DRIVE_FOLDER_MIME) {
        await this.drive.updateText(existing.id, content);
        stats.updated++;
      } else {
        await this.drive.createFile(driveId, child.name, content);
        stats.created++;
      }
    }
  }

  /** Drive → local. ÉCRASE les fichiers locaux. `'absent'` si aucun `.obsidian` sur Drive. */
  async pull(rootDriveId: string): Promise<{ pulled: number } | 'absent'> {
    return this.withSettingsIncluded(async () => {
      const dir = await this.childByName(rootDriveId, SETTINGS_DIR);
      if (!dir || dir.mimeType !== DRIVE_FOLDER_MIME) return 'absent' as const;
      const stats = { pulled: 0 };
      await this.vault.createFolder(SETTINGS_DIR);
      await this.pullDir(dir.id, SETTINGS_DIR, stats);
      return stats;
    });
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

  private async pullDir(driveId: string, localPath: string, stats: { pulled: number }): Promise<void> {
    for (const child of await this.drive.children(driveId)) {
      const childPath = `${localPath}/${toNfc(child.name)}`;
      if (isIgnored(childPath)) continue; // ne jamais écraser NOS réglages locaux
      if (child.mimeType === DRIVE_FOLDER_MIME) {
        await this.vault.createFolder(childPath);
        await this.pullDir(child.id, childPath, stats);
        continue;
      }
      const remote = await this.drive.readText(child.id);
      const content = childPath === ENABLED_PLUGINS_FILE
        ? await this.mergeEnabledPlugins(remote, childPath)
        : remote;
      await this.vault.writeText(childPath, content);
      stats.pulled++;
    }
  }
}
