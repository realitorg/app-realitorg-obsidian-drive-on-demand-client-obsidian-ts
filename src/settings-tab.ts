import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
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
      new Setting(containerEl)
        .setName(t('settings.syncNowName'))
        .setDesc(t('settings.syncNowDesc'))
        .addButton((b) =>
          b.setButtonText(t('settings.syncNow')).onClick(async () => {
            b.setDisabled(true);
            try {
              await this.plugin.syncNow();
              new Notice(t('settings.syncNowDone'));
            } catch (e) {
              new Notice(t('settings.syncNowError', { error: String(e) }));
            } finally {
              b.setDisabled(false);
            }
          }),
        );
    }

    // --- Synchroniser les réglages du vault (.obsidian) ---
    if (connected) {
      new Setting(containerEl)
        .setName(t('settings.vaultSettingsName'))
        .setDesc(t('settings.vaultSettingsDesc'))
        .addToggle((tg) =>
          tg.setValue(this.plugin.getVaultSettingsSync()).onChange(async (v) => {
            await this.plugin.setVaultSettingsSync(v);
            if (v) new Notice(t('settings.vaultSettingsOn'));
          }),
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
