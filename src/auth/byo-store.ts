import { utf8ToBase64, base64ToUtf8 } from '../util/base64';
import type { PersistAdapter } from './token-store';
import type { AppCredentials } from './google-oauth';

/** Obfuscation réversible du secret (base64 UTF-8) — même logique que le refresh token :
 *  évite le client_secret en clair au coup d'œil dans data.json. Ce n'est pas du chiffrement. */
function obfuscate(s: string): string {
  return utf8ToBase64(s);
}
function deobfuscate(s: string): string {
  return base64ToUtf8(s);
}

/** Identifiants OAuth « BYO » (Bring Your Own) : le projet Google Cloud de l'utilisateur.
 *  Présents => le plugin s'authentifie directement chez Google, sans le broker Real-IT
 *  (pas de cap 100 users, pas d'audit CASA, pas d'expiration 7 jours). */
export class ByoCredentialsStore {
  constructor(private adapter: PersistAdapter) {}

  async get(): Promise<AppCredentials | null> {
    const d = await this.adapter.load();
    const id = d.clientId;
    const secret = d.clientSecret;
    if (typeof id === 'string' && id.length > 0 && typeof secret === 'string' && secret.length > 0) {
      return { clientId: id, clientSecret: deobfuscate(secret) };
    }
    return null;
  }

  async set(creds: AppCredentials): Promise<void> {
    const d = await this.adapter.load();
    await this.adapter.save({ ...d, clientId: creds.clientId.trim(), clientSecret: obfuscate(creds.clientSecret.trim()) });
  }

  async clear(): Promise<void> {
    const d = await this.adapter.load();
    const next = { ...d };
    delete next.clientId;
    delete next.clientSecret;
    await this.adapter.save(next);
  }
}
