import type { HttpFn } from '../http';
import type { CancelToken } from '../util/cancel-token';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  md5Checksum?: string;
  headRevisionId?: string;
  size?: string;
}

export interface DriveNode extends DriveMeta {
  path: string;
  isFolder: boolean;
}

export function isFolder(mime: string): boolean {
  return mime === FOLDER_MIME;
}
export function isGoogleNative(mime: string): boolean {
  return mime.startsWith('application/vnd.google-apps.') && mime !== FOLDER_MIME;
}

/** encodeURIComponent ne protège pas l'apostrophe → on l'encode explicitement. */
function q(query: string): string {
  return encodeURIComponent(query).replace(/'/g, '%27');
}

export class DriveClient {
  constructor(
    private http: HttpFn,
    private token: () => Promise<string>,
    private rootId = 'root',
  ) {}

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}` };
  }

  async children(folderId: string): Promise<DriveMeta[]> {
    const fields = 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,headRevisionId,size)';
    const out: DriveMeta[] = [];
    let pageToken: string | undefined;
    do {
      const url =
        `${API}/files?q=${q(`'${folderId}' in parents and trashed=false`)}` +
        `&fields=${encodeURIComponent(fields)}&pageSize=1000` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const res = await this.http({ url, headers: await this.headers() });
      if (res.status !== 200) throw new Error(`Drive children ${res.status}: ${res.text}`);
      const j = res.json<{ nextPageToken?: string; files?: DriveMeta[] }>();
      out.push(...(j.files ?? []));
      pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }

  get root(): string {
    return this.rootId;
  }

  /** Compte Google connecté (email affiché dans le panneau). */
  async aboutUser(): Promise<{ email?: string; name?: string }> {
    const res = await this.http({
      url: `${API}/about?fields=${encodeURIComponent('user(emailAddress,displayName)')}`,
      headers: await this.headers(),
    });
    if (res.status !== 200) throw new Error(`Drive about ${res.status}: ${res.text}`);
    const j = res.json<{ user?: { emailAddress?: string; displayName?: string } }>();
    return { email: j.user?.emailAddress, name: j.user?.displayName };
  }

  /** Jeton de départ pour l'API Changes : point de référence « maintenant » (aucun
   *  changement antérieur). À obtenir une fois, puis à faire évoluer via listChanges. */
  /** Id RÉEL du dossier racine du Drive (l'alias « root » ne correspond pas aux `parents`
   *  renvoyés par l'API, qui donnent le vrai id) — nécessaire pour mapper un parent = racine. */
  async getRootFolderId(): Promise<string> {
    const res = await this.http({ url: `${API}/files/root?fields=id`, headers: await this.headers() });
    if (res.status !== 200) throw new Error(`Drive root id ${res.status}: ${res.text}`);
    return res.json<{ id: string }>().id;
  }

  async getStartPageToken(): Promise<string> {
    const res = await this.http({ url: `${API}/changes/startPageToken`, headers: await this.headers() });
    if (res.status !== 200) throw new Error(`Drive startPageToken ${res.status}: ${res.text}`);
    return res.json<{ startPageToken: string }>().startPageToken;
  }

  /** Liste les changements Drive depuis `pageToken` (efficace : un appel = tout ce qui a
   *  changé). Paginer via `nextPageToken` ; quand `newStartPageToken` apparaît, c'est le
   *  jeton à conserver. Chaque changement porte fileId + (si non supprimé) le nom et les
   *  parents ACTUELS du fichier → permet de détecter les renommages/déplacements. */
  async listChanges(pageToken: string): Promise<{
    changes: { fileId: string; removed: boolean; name?: string; parents?: string[]; mimeType?: string }[];
    newStartPageToken?: string;
    nextPageToken?: string;
  }> {
    const fields = 'newStartPageToken,nextPageToken,changes(fileId,removed,file(name,parents,trashed,mimeType))';
    const url =
      `${API}/changes?pageToken=${encodeURIComponent(pageToken)}` +
      `&pageSize=200&fields=${encodeURIComponent(fields)}`;
    const res = await this.http({ url, headers: await this.headers() });
    if (res.status !== 200) throw new Error(`Drive changes ${res.status}: ${res.text}`);
    const j = res.json<{
      changes?: {
        fileId: string;
        removed?: boolean;
        file?: { name?: string; parents?: string[]; trashed?: boolean; mimeType?: string };
      }[];
      newStartPageToken?: string;
      nextPageToken?: string;
    }>();
    const changes = (j.changes ?? []).map((c) => ({
      fileId: c.fileId,
      removed: Boolean(c.removed || c.file?.trashed),
      name: c.file?.name,
      parents: c.file?.parents,
      mimeType: c.file?.mimeType,
    }));
    return { changes, newStartPageToken: j.newStartPageToken, nextPageToken: j.nextPageToken };
  }

  async readText(fileId: string): Promise<string> {
    const res = await this.http({ url: `${API}/files/${fileId}?alt=media`, headers: await this.headers() });
    if (res.status !== 200) throw new Error(`Drive readText ${res.status}`);
    return res.text;
  }

  async readBinary(fileId: string): Promise<ArrayBuffer> {
    const res = await this.http({ url: `${API}/files/${fileId}?alt=media`, headers: await this.headers() });
    if (res.status !== 200 || !res.arrayBuffer) throw new Error(`Drive readBinary ${res.status}`);
    return res.arrayBuffer;
  }

  async subtree(folderId: string, parentPath = '', token?: CancelToken): Promise<DriveNode[]> {
    const nodes: DriveNode[] = [];
    const walk = async (fid: string, prefix: string): Promise<void> => {
      token?.throwIfCancelled();
      for (const it of await this.children(fid)) {
        token?.throwIfCancelled();
        const path = prefix ? `${prefix}/${it.name}` : it.name;
        const folder = isFolder(it.mimeType);
        nodes.push({ ...it, path, isFolder: folder });
        if (folder) await walk(it.id, path);
      }
    };
    await walk(folderId, parentPath);
    return nodes;
  }

  async listTree(): Promise<DriveNode[]> {
    return this.subtree(this.rootId, '');
  }

  async updateText(fileId: string, content: string): Promise<string | undefined> {
    const res = await this.http({
      url: `${UPLOAD}/files/${fileId}?uploadType=media&fields=headRevisionId`,
      method: 'PATCH',
      headers: { ...(await this.headers()), 'Content-Type': 'text/plain; charset=UTF-8' },
      body: content,
    });
    if (res.status !== 200) throw new Error(`Drive updateText ${res.status}: ${res.text}`);
    return res.json<{ headRevisionId?: string }>().headRevisionId;
  }

  async getRevision(fileId: string): Promise<{ headRevisionId?: string; modifiedTime?: string }> {
    const res = await this.http({
      url: `${API}/files/${fileId}?fields=headRevisionId,modifiedTime`,
      headers: await this.headers(),
    });
    if (res.status !== 200) throw new Error(`Drive getRevision ${res.status}`);
    return res.json<{ headRevisionId?: string; modifiedTime?: string }>();
  }

  async createFile(parentId: string, name: string, content: string): Promise<{ id: string; headRevisionId?: string }> {
    const boundary = 'gdrive-fod-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const meta = JSON.stringify({ name, parents: [parentId] });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    const res = await this.http({
      url: `${UPLOAD}/files?uploadType=multipart&fields=id,headRevisionId`,
      method: 'POST',
      headers: { ...(await this.headers()), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (res.status !== 200) throw new Error(`Drive createFile ${res.status}: ${res.text}`);
    const j = res.json<{ id: string; headRevisionId?: string }>();
    return { id: j.id, headRevisionId: j.headRevisionId };
  }

  async createBinaryFile(
    parentId: string,
    name: string,
    data: ArrayBuffer,
    mimeType: string,
  ): Promise<{ id: string; headRevisionId?: string }> {
    const boundary = 'gdrive-fod-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const meta = JSON.stringify({ name, parents: [parentId] });
    const encoder = new TextEncoder();
    const preamble = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    );
    const epilogue = encoder.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(preamble.length + data.byteLength + epilogue.length);
    body.set(preamble, 0);
    body.set(new Uint8Array(data), preamble.length);
    body.set(epilogue, preamble.length + data.byteLength);
    const res = await this.http({
      url: `${UPLOAD}/files?uploadType=multipart&fields=id,headRevisionId`,
      method: 'POST',
      headers: { ...(await this.headers()), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: body.buffer,
    });
    if (res.status !== 200) throw new Error(`Drive createBinaryFile ${res.status}: ${res.text}`);
    const j = res.json<{ id: string; headRevisionId?: string }>();
    return { id: j.id, headRevisionId: j.headRevisionId };
  }

  async createDriveFolder(parentId: string, name: string): Promise<{ id: string }> {
    const res = await this.http({
      url: `${API}/files?fields=id`,
      method: 'POST',
      headers: { ...(await this.headers()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (res.status !== 200) throw new Error(`Drive createDriveFolder ${res.status}: ${res.text}`);
    return { id: res.json<{ id: string }>().id };
  }

  /** Met un fichier ou dossier dans la corbeille Drive (récupérable 30 jours), jamais une
   *  suppression définitive. Déjà absent (404) : rien à faire. */
  async trashFile(fileId: string): Promise<void> {
    const res = await this.http({
      url: `${API}/files/${fileId}?fields=id`,
      method: 'PATCH',
      headers: { ...(await this.headers()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    if (res.status !== 200 && res.status !== 404) throw new Error(`Drive trashFile ${res.status}: ${res.text}`);
  }

  /** Déplace et/ou renomme un fichier/dossier Drive : le rattache à `addParentId`
   *  (en retirant ses parents actuels) et met à jour son nom. Sur Drive, déplacer un
   *  dossier déplace tout son contenu (les enfants gardent ce dossier pour parent). */
  async moveFile(fileId: string, opts: { name?: string; addParentId: string }): Promise<void> {
    const cur = await this.http({ url: `${API}/files/${fileId}?fields=parents`, headers: await this.headers() });
    if (cur.status !== 200) throw new Error(`Drive moveFile(get parents) ${cur.status}: ${cur.text}`);
    const parents = cur.json<{ parents?: string[] }>().parents ?? [];
    const removeParents = parents.filter((p) => p !== opts.addParentId);
    let url = `${API}/files/${fileId}?addParents=${encodeURIComponent(opts.addParentId)}&fields=id`;
    if (removeParents.length) url += `&removeParents=${encodeURIComponent(removeParents.join(','))}`;
    const res = await this.http({
      url,
      method: 'PATCH',
      headers: { ...(await this.headers()), 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.name ? { name: opts.name } : {}),
    });
    if (res.status !== 200) throw new Error(`Drive moveFile ${res.status}: ${res.text}`);
  }
}
