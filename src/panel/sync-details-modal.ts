import { App, Modal, setIcon } from 'obsidian';
import type { TreeNode } from './tree-model';
import { t } from '../i18n';

export type SyncStatusKind = 'offline' | 'partial' | 'online' | 'syncing';

export interface SyncStatus {
  kind: SyncStatusKind;
  /** Sync de dossier en cours : fichiers traités / total. */
  progress?: { done: number; total: number };
  /** Fichiers en échec lors de la dernière sync de ce nœud. */
  failed: string[];
}

/** Ce que la modale lit et déclenche ; implémenté par le panneau Drive. */
export interface SyncDetailsController {
  status(node: TreeNode): SyncStatus;
  makeOffline(node: TreeNode): void;
  freeUp(node: TreeNode): void;
  cancel(node: TreeNode): void;
}

/** Détails et actions de synchronisation d'un fichier ou dossier (appui long, clic droit,
 *  ou toucher de l'icône d'état). Se met à jour tant qu'elle est ouverte (`refresh`). */
export class SyncDetailsModal extends Modal {
  constructor(app: App, readonly node: TreeNode, private ctl: SyncDetailsController, private onClosed: () => void) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('gdrive-fod-details-modal');
    this.titleEl.empty();
    setIcon(this.titleEl.createSpan({ cls: 'gdrive-fod-details-title-icon' }), this.node.isFolder ? 'folder' : 'file');
    this.titleEl.createSpan({ text: this.node.name });
    this.refresh();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }

  refresh(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass('gdrive-fod-details');
    const st = this.ctl.status(this.node);

    if (this.node.path.includes('/')) {
      el.createDiv({ cls: 'gdrive-fod-details-path', text: this.node.path.split('/').slice(0, -1).join(' / ') });
    }

    if (st.kind === 'syncing') {
      const prog = st.progress;
      const bar = el.createEl('progress', { cls: 'gdrive-fod-details-progress' });
      if (prog && prog.total > 0) {
        bar.max = prog.total;
        bar.value = prog.done;
        el.createDiv({ cls: 'gdrive-fod-details-count', text: t('details.progress', { done: prog.done, total: prog.total }) });
      }
    }

    if (st.failed.length > 0) {
      const box = el.createDiv({ cls: 'gdrive-fod-details-failed' });
      box.createDiv({ text: t('details.failed', { count: st.failed.length }) });
      const list = box.createEl('ul');
      for (const p of st.failed.slice(0, 5)) list.createEl('li', { text: p.split('/').pop() ?? p });
      if (st.failed.length > 5) list.createEl('li', { text: t('details.failedMore', { count: st.failed.length - 5 }) });
    }

    const actions = el.createDiv({ cls: 'gdrive-fod-details-actions' });
    const button = (label: string, cls: string, onClick: () => void) => {
      const b = actions.createEl('button', { text: label, cls });
      b.onclick = onClick;
    };
    if (st.kind === 'syncing') {
      button(t('details.cancel'), '', () => this.ctl.cancel(this.node));
    } else if (st.kind === 'offline' && st.failed.length === 0) {
      // Une seule action, comme la pastille : synchronisé → libérer, sinon → synchroniser.
      button(t('details.freeUp'), '', () => this.ctl.freeUp(this.node));
      el.createDiv({ cls: 'gdrive-fod-details-hint', text: t('details.freeUpHint') });
    } else {
      button(st.failed.length > 0 ? t('details.retry') : t('details.makeOffline'), 'mod-cta', () => this.ctl.makeOffline(this.node));
    }

    // Pied : lien Drive discret à gauche, état en tout petit à droite.
    const footer = el.createDiv({ cls: 'gdrive-fod-details-footer' });
    const open = footer.createEl('a', { cls: 'gdrive-fod-details-drive', text: t('details.openInDrive') });
    open.href = `https://drive.google.com/open?id=${encodeURIComponent(this.node.id)}`;
    open.target = '_blank';
    open.rel = 'noopener';
    open.onclick = (e) => {
      e.preventDefault();
      window.open(open.href, '_blank');
    };
    footer.createSpan({
      cls: 'gdrive-fod-details-state',
      text: st.kind === 'syncing' ? t('details.status.syncing') : st.kind === 'offline' ? t('details.status.synced') : t('details.status.notSynced'),
    });
  }
}
