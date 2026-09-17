import type { DriveNode } from '../drive/drive-client';
import type { MirrorIndex, MirrorEntry } from './mirror-index';

export interface VaultOps {
  exists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
  createStub(path: string): Promise<void>;
  writeText(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  remove(path: string): Promise<void>;
  /** Renomme/déplace un fichier ou dossier local (répercute un renommage/déplacement Drive). */
  rename(oldPath: string, newPath: string): Promise<void>;
  isEmptyFolder(path: string): boolean;
  /** Enfants locaux immédiats d'un dossier du vault (`''` = racine). Synchrone (index
   *  Obsidian en mémoire). Sert à repérer les fichiers présents en local mais pas sur Drive. */
  listChildren(path: string): { name: string; isFolder: boolean }[];
}

/** Vrai si un segment du chemin est une traversée de répertoire ('.', '..') ou vide.
 *  Un nom Drive (contrôlé par le compte connecté ou tout collaborateur qui y partage
 *  un fichier) peut contenir '..' ou '/' sans restriction — non filtré, un tel chemin
 *  pourrait faire écrire/lire/supprimer un fichier HORS du vault. */
export function hasUnsafeSegment(path: string): boolean {
  return path.split('/').some((seg) => seg === '.' || seg === '..' || seg === '');
}

/** Dossier de configuration du vault (`Vault#configDir`) : `.obsidian` par défaut, mais
 *  l'utilisateur peut le renommer. Fixé au chargement du plugin ; vide avant, et alors
 *  rien n'est traité comme de la configuration. */
let configDir = '';

export function setConfigDir(dir: string): void {
  configDir = dir;
}

export function getConfigDir(): string {
  return configDir;
}

/** Option « synchroniser les réglages du vault ». OFF par défaut : tout le dossier de
 *  configuration reste exclu (comportement historique). ON : il est synchronisé, sauf
 *  les exclusions ci-dessous. */
let syncVaultSettings = false;

export function setSyncVaultSettings(on: boolean): void {
  syncVaultSettings = on;
}

/** Notre propre dossier plugin : contient le refresh token OAuth et, s'il était
 *  synchronisé, créerait une boucle (on écrit → on repousse → on retire…). */
const ownPluginDirs = () => [
  `${configDir}/plugins/drive-on-demand`,
  `${configDir}/plugins/google-drive-fod`, // ancien id (installations historiques)
];

/** Disposition des panneaux : propre à l'appareil et réécrite en permanence
 *  (chaque déplacement d'onglet) → bruit de sync inutile. */
const deviceLocalFiles = () => [`${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`];

export function isIgnored(path: string): boolean {
  if (hasUnsafeSegment(path)) return true; // sécurité d'abord, quelle que soit l'option
  if (!configDir || !path.split('/').includes(configDir)) return false;
  if (!syncVaultSettings) return true; // option OFF → tout le dossier de configuration exclu
  if (ownPluginDirs().some((d) => path === d || path.startsWith(`${d}/`))) return true;
  if (deviceLocalFiles().includes(path)) return true;
  return false;
}

export class TreeMirror {
  constructor(
    private vault: VaultOps,
    private index: MirrorIndex,
  ) {}

  async sync(nodes: DriveNode[]): Promise<{ created: number; skipped: number }> {
    // dossiers d'abord, du moins profond au plus profond, pour que les parents existent
    const ordered = [...nodes].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.path.split('/').length - b.path.split('/').length;
    });
    let created = 0;
    let skipped = 0;
    for (const n of ordered) {
      if (isIgnored(n.path)) continue;
      const existing = this.index.get(n.path);
      const alreadyInVault = await this.vault.exists(n.path);
      // Ne jamais auto-écraser un fichier qu'on n'a pas créé :
      // - entrée déjà connue → on préserve son état local (hydraté/épinglé)
      // - dossier → rien à hydrater
      // - fichier déjà présent dans le vault mais inconnu de l'index → contenu utilisateur → marqué hydraté (pas de download par-dessus)
      // - sinon (stub vide qu'on va créer) → hydratable
      const hydrated = existing ? existing.hydrated : n.isFolder || alreadyInVault ? true : false;
      const entry: MirrorEntry = {
        driveId: n.id,
        mimeType: n.mimeType,
        isFolder: n.isFolder,
        hydrated,
        pinned: existing ? existing.pinned : false,
        headRevisionId: n.headRevisionId,
        modifiedTime: n.modifiedTime,
        md5Checksum: n.md5Checksum,
      };
      if (alreadyInVault) {
        skipped++;
      } else {
        if (n.isFolder) await this.vault.createFolder(n.path);
        else await this.vault.createStub(n.path);
        created++;
      }
      await this.index.set(n.path, entry);
    }
    return { created, skipped };
  }
}
