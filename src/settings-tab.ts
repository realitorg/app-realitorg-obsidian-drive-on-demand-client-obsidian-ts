import { App, PluginSettingTab, Setting, Notice, type ButtonComponent } from 'obsidian';
import { CancelToken, isCancelledError } from './util/cancel-token';
import type GoogleDriveFodPlugin from './main';
import { t } from './i18n';

type Mode = 'default' | 'self-hosted';

/** Onglet de réglages. Déconnecté → seule la section compte (mode + connexion). Connecté →
 *  ajoute « Synchroniser maintenant ». Les réglages de mode/identifiants sont STAGÉS : ils ne
 *  s'appliquent qu'au clic sur « Enregistrer » d'une barre façon Discord (visible si édition). */
export class DriveOnDemandSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GoogleDriveFodPlugin) {
    super(app, plugin);
  }

  display(): void {
    void this.render();
  }

  /** Ligne d'action longue : le bouton affiche la progression en %, et un bouton
   *  « Annuler » n'apparaît que pendant l'exécution. */
  private addProgressAction(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    label: string,
    run: (onProgress: (done: number, total: number) => void, token: CancelToken) => Promise<string>,
    confirmMsg?: string,
  ): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);
    let token: CancelToken | null = null;
    let cancelBtn: ButtonComponent | null = null;

    setting.addButton((b) =>
      b.setButtonText(label).onClick(async () => {
        if (confirmMsg && !confirm(confirmMsg)) return;
        token = new CancelToken();
        if (cancelBtn) cancelBtn.buttonEl.style.display = '';
        b.setDisabled(true);
        try {
          const msg = await run((done, total) => {
            b.setButtonText(total > 0 ? `${Math.round((done / total) * 100)} %` : label);
          }, token);
          new Notice(msg);
        } catch (e) {
          new Notice(isCancelledError(e) ? t('settings.cancelled') : t('settings.vaultError', { error: String(e) }));
        } finally {
          token = null;
          b.setDisabled(false).setButtonText(label);
          if (cancelBtn) cancelBtn.buttonEl.style.display = 'none';
        }
      }),
    );
    setting.addButton((b) => {
      cancelBtn = b;
      b.setButtonText(t('settings.cancel')).setWarning().onClick(() => token?.cancel());
      b.buttonEl.style.display = 'none';
    });
  }

  private async render(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    const connected = await this.plugin.isConnected();
    const existing = this.plugin.getByoConfig();
    const currentMode: Mode = existing ? 'self-hosted' : 'default';

    // État stagé : appliqué seulement via la barre « Enregistrer ».
    let pendingMode: Mode = currentMode;
    let pendingClientId = existing?.clientId ?? '';
    let pendingClientSecret = '';

    // --- Section compte Google (toujours) ---
    const account = new Setting(containerEl).setName(t('settings.accountName'));
    if (!connected) {
      account.setDesc(t('settings.accountNotConnected')).addButton((b) =>
        b.setButtonText(t('settings.connect')).setCta().onClick(() => {
          this.plugin.startAuth();
          new Notice(t('settings.connectStarted'));
        }),
      );
    } else {
      let email = '';
      try { email = (await this.plugin.accountEmail()) ?? ''; } catch { /* hors-ligne */ }
      account
        .setDesc(email ? t('settings.accountConnected', { email }) : t('settings.accountConnectedNoEmail'))
        .addButton((b) =>
          b.setButtonText(t('settings.disconnect')).setWarning().onClick(async () => {
            await this.plugin.disconnect();
            new Notice(t('settings.disconnected'));
            this.display();
          }),
        );
    }

    // --- Mode de connexion (dropdown) + champs dynamiques ---
    const modeSection = containerEl.createDiv();

    // --- Synchroniser maintenant (seulement connecté) ---
    if (connected) {
      this.addProgressAction(
        containerEl,
        t('settings.syncNowName'),
        t('settings.syncNowDesc'),
        t('settings.syncNow'),
        async (onProgress, token) => {
          await this.plugin.syncNow(onProgress, token);
          return t('settings.syncNowDone');
        },
      );
    }

    // --- Dossier de travail (la sélection vit ici, plus dans le panneau) ---
    if (connected) {
      new Setting(containerEl)
        .setName(t('settings.workingRootName'))
        .setDesc(t('settings.workingRootDesc', { current: this.plugin.getWorkingRootName() ?? t('picker.driveRoot') }))
        .addButton((b) =>
          b.setButtonText(t('settings.workingRootChange')).onClick(() => this.plugin.openWorkingRootPicker()),
        );
    }

    // --- Réglages du vault (.obsidian) : transfert ponctuel, dans un sens ou l'autre ---
    if (connected) {
      new Setting(containerEl).setName(t('settings.vaultHeading')).setDesc(t('settings.vaultDesc')).setHeading();

      this.addProgressAction(
        containerEl,
        t('settings.vaultPushName'),
        t('settings.vaultPushDesc'),
        t('settings.vaultPush'),
        async (onProgress, token) => {
          const r = await this.plugin.pushVaultSettings(onProgress, token);
          return t('settings.vaultPushDone', { created: r.created, updated: r.updated });
        },
        t('settings.vaultPushConfirm'),
      );

      this.addProgressAction(
        containerEl,
        t('settings.vaultPullName'),
        t('settings.vaultPullDesc'),
        t('settings.vaultPull'),
        async (onProgress, token) => {
          const r = await this.plugin.pullVaultSettings(onProgress, token);
          return r === 'absent' ? t('settings.vaultPullAbsent') : t('settings.vaultPullDone', { pulled: r.pulled });
        },
        t('settings.vaultPullConfirm'), // confirmation AVANT : le tirage écrase le local
      );
    }

    // --- Barre « modifications non enregistrées » (façon Discord), toujours en bas ---
    const saveBar = containerEl.createDiv({ cls: 'dod-save-bar' });
    saveBar.createSpan({ text: t('settings.unsaved') });
    const saveBtn = saveBar.createEl('button', { text: t('settings.save'), cls: 'mod-cta' });

    const existingSecret = existing?.clientSecret ?? '';
    const isDirty = (): boolean => {
      if (pendingMode !== currentMode) return true;
      if (pendingMode === 'self-hosted') {
        if (pendingClientId.trim() !== (existing?.clientId ?? '')) return true;
        if (pendingClientSecret.trim() !== '') return true;
      }
      return false;
    };
    const refreshSaveBar = () => { saveBar.style.display = isDirty() ? 'flex' : 'none'; };

    const renderMode = () => {
      modeSection.empty();
      new Setting(modeSection).setName(t('settings.modeName')).addDropdown((dd) =>
        dd
          .addOption('default', t('settings.modeDefault'))
          .addOption('self-hosted', t('settings.modeSelfHosted'))
          .setValue(pendingMode)
          .onChange((v) => {
            pendingMode = v as Mode;
            renderMode();
            refreshSaveBar();
          }),
      );

      // Mode par défaut : rien de plus. Auto-hébergé : identifiants de l'utilisateur.
      if (pendingMode === 'self-hosted') {
        modeSection.createEl('p', { text: t('settings.selfHostedDesc') }).addClass('setting-item-description');
        new Setting(modeSection)
          .setName(t('settings.byoRedirectLabel'))
          .setDesc(t('settings.byoRedirectDesc'))
          .addText((text) => {
            text.setValue(this.plugin.byoRedirectUri());
            text.inputEl.readOnly = true;
            text.inputEl.style.width = '100%';
          });
        new Setting(modeSection)
          .setName(t('settings.byoClientId'))
          .addText((text) => text.setValue(pendingClientId).onChange((v) => { pendingClientId = v; refreshSaveBar(); }));
        new Setting(modeSection)
          .setName(t('settings.byoClientSecret'))
          .addText((text) => {
            text.setPlaceholder(existing ? '••••••••' : t('settings.byoClientSecretPlaceholder'));
            text.inputEl.type = 'password';
            text.onChange((v) => { pendingClientSecret = v; refreshSaveBar(); });
          });
      }
    };
    renderMode();
    refreshSaveBar();

    saveBtn.onclick = async () => {
      if (pendingMode === 'self-hosted') {
        const secret = pendingClientSecret.trim() || existingSecret; // secret laissé vide = on garde l'existant
        if (!pendingClientId.trim() || !secret) { new Notice(t('settings.byoMissing')); return; }
        await this.plugin.setByoConfig({ clientId: pendingClientId.trim(), clientSecret: secret });
      } else if (currentMode === 'self-hosted') {
        await this.plugin.clearByoConfig(); // retour au mode par défaut
      }
      new Notice(t('settings.saved'));
      this.display();
    };
  }
}
