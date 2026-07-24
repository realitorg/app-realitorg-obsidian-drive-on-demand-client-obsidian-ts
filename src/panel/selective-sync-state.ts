import type { PersistAdapter } from '../auth/token-store';
import { toNfc } from '../util/nfc';

export type CheckState = 'checked' | 'partial' | 'unchecked';

/** Source de vérité : `synced` (fichiers matérialisés). `full` = raffinement
 *  d'affichage (dossiers montrés « pleins »). Persisté sous les clés `syncedFiles` et `fullFolders`.
 *  Toutes les clés sont normalisées NFC : les noms venant de Drive peuvent être en NFD
 *  (upload macOS via Drive Desktop) alors qu'Obsidian donne du NFC → sans normalisation
 *  commune, un fichier synchronisé n'est plus reconnu (cf. util/nfc). */
export class SelectiveSyncState {
  private synced = new Set<string>();
  private full = new Set<string>();

  constructor(private adapter: PersistAdapter) {}

  async load(): Promise<void> {
    const d = await this.adapter.load();
    const sf = d.syncedFiles;
    const ff = d.fullFolders;
    // normalise NFC au chargement → migre les clés NFD historiques
    this.synced = new Set(Array.isArray(sf) ? (sf as string[]).map(toNfc) : []);
    this.full = new Set(Array.isArray(ff) ? (ff as string[]).map(toNfc) : []);
  }

  private async persist(): Promise<void> {
    const d = await this.adapter.load();
    d.syncedFiles = [...this.synced];
    d.fullFolders = [...this.full];
    await this.adapter.save({ ...d });
  }

  isSynced(path: string): boolean {
    return this.synced.has(toNfc(path));
  }

  allSynced(): string[] {
    return [...this.synced];
  }

  allFullFolders(): string[] {
    return [...this.full];
  }

  /** Le chemin est-il un dossier « plein » (synchronisé en entier), ou situé sous un tel
   *  dossier ? Sert à décider si un NOUVEAU fichier apparu sur Drive doit être matérialisé
   *  automatiquement (oui si son dossier parent est full-sync). */
  isUnderFullFolder(path: string): boolean {
    const np = toNfc(path);
    if (this.full.has(np)) return true;
    for (const f of this.full) if (np.startsWith(f + '/')) return true;
    return false;
  }

  syncedUnder(folderPath: string): string[] {
    const p = toNfc(folderPath) + '/';
    return [...this.synced].filter((s) => s.startsWith(p));
  }

  fileState(path: string): CheckState {
    return this.synced.has(toNfc(path)) ? 'checked' : 'unchecked';
  }

  folderState(path: string): CheckState {
    const np = toNfc(path);
    if (this.full.has(np)) return 'checked';
    const p = np + '/';
    for (const s of this.synced) if (s.startsWith(p)) return 'partial';
    for (const f of this.full) if (f.startsWith(p)) return 'partial';
    return 'unchecked';
  }

  private demoteAncestors(path: string): void {
    const parts = toNfc(path).split('/');
    parts.pop();
    let acc = '';
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      this.full.delete(acc);
    }
  }

  async setFileSynced(path: string, on: boolean): Promise<void> {
    const np = toNfc(path);
    if (on) {
      this.synced.add(np);
    } else {
      this.synced.delete(np);
      this.demoteAncestors(np);
    }
    await this.persist();
  }

  async setFolderFull(
    folderPath: string,
    filesUnder: string[],
    subFolders: string[],
    on: boolean,
  ): Promise<void> {
    const np = toNfc(folderPath);
    if (on) {
      this.full.add(np);
      for (const f of subFolders) this.full.add(toNfc(f));
      for (const file of filesUnder) this.synced.add(toNfc(file));
    } else {
      const p = np + '/';
      this.full.delete(np);
      for (const f of [...this.full]) if (f.startsWith(p)) this.full.delete(f);
      for (const s of [...this.synced]) if (s.startsWith(p)) this.synced.delete(s);
      this.demoteAncestors(np);
    }
    await this.persist();
  }

  /** Remet tout l'état à zéro (ex. changement de dossier de travail). */
  async clear(): Promise<void> {
    this.synced.clear();
    this.full.clear();
    await this.persist();
  }
}
