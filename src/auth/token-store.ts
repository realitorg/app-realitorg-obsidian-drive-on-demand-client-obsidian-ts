import { utf8ToBase64, base64ToUtf8 } from '../util/base64';
export interface PersistAdapter {
  load(): Promise<Record<string, unknown>>;
  save(data: Record<string, unknown>): Promise<void>;
}

const KEY = 'rt';

/** Obfuscation réversible (base64 du texte UTF-8). Pas du chiffrement :
 *  évite juste le refresh token en clair au coup d'œil dans data.json. */
function obfuscate(s: string): string {
  return utf8ToBase64(s);
}
function deobfuscate(s: string): string {
  return base64ToUtf8(s);
}

export class TokenStore {
  constructor(private adapter: PersistAdapter) {}

  async getRefresh(): Promise<string | null> {
    const data = await this.adapter.load();
    const v = data[KEY];
    return typeof v === 'string' && v.length > 0 ? deobfuscate(v) : null;
  }

  async setRefresh(token: string): Promise<void> {
    const data = await this.adapter.load();
    data[KEY] = obfuscate(token);
    await this.adapter.save(data);
  }

  async clear(): Promise<void> {
    const data = await this.adapter.load();
    delete data[KEY];
    await this.adapter.save(data);
  }
}
