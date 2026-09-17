import { describe, it, expect, vi } from 'vitest';
import { DriveClient, isFolder, isGoogleNative } from './drive-client';
import { CancelToken } from '../util/cancel-token';
import type { HttpFn, HttpResponse } from '../http';

function res(status: number, body: unknown, arrayBuffer?: ArrayBuffer): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text, arrayBuffer, json: <T>() => JSON.parse(text) as T };
}
const token = async () => 'AT';

describe('helpers', () => {
  it('isFolder / isGoogleNative', () => {
    expect(isFolder('application/vnd.google-apps.folder')).toBe(true);
    expect(isGoogleNative('application/vnd.google-apps.document')).toBe(true);
    expect(isGoogleNative('application/vnd.google-apps.folder')).toBe(false);
    expect(isGoogleNative('text/markdown')).toBe(false);
  });
});

describe('DriveClient.children', () => {
  it('envoie le Bearer, encode l apostrophe en %27, et suit la pagination', async () => {
    const pages: HttpResponse[] = [
      res(200, { nextPageToken: 'p2', files: [{ id: '1', name: 'a.md', mimeType: 'text/markdown', modifiedTime: 't1' }] }),
      res(200, { files: [{ id: '2', name: 'b.md', mimeType: 'text/markdown', modifiedTime: 't2' }] }),
    ];
    let call = 0;
    const http = vi.fn(async () => pages[call++]) as unknown as HttpFn;
    const c = new DriveClient(http, token);

    const items = await c.children('FID');
    expect(items.map((f) => f.id)).toEqual(['1', '2']);

    const firstUrl = vi.mocked(http).mock.calls[0][0].url;
    expect(firstUrl).toContain('%27FID%27%20in%20parents');
    expect(vi.mocked(http).mock.calls[0][0].headers?.Authorization).toBe('Bearer AT');
    // 2e appel a un pageToken
    expect(vi.mocked(http).mock.calls[1][0].url).toContain('pageToken=p2');
  });

  it('throw sur status non-200', async () => {
    const http = vi.fn(async () => res(403, 'nope')) as unknown as HttpFn;
    await expect(new DriveClient(http, token).children('X')).rejects.toThrow('403');
  });
});

describe('DriveClient.readText / readBinary', () => {
  it('readText récupère alt=media en texte', async () => {
    const http = vi.fn(async () => res(200, 'contenu')) as unknown as HttpFn;
    expect(await new DriveClient(http, token).readText('FID')).toBe('contenu');
    expect(vi.mocked(http).mock.calls[0][0].url).toContain('/files/FID?alt=media');
  });

  it('readBinary retourne l arrayBuffer', async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const http = vi.fn(async () => res(200, '', buf)) as unknown as HttpFn;
    expect(await new DriveClient(http, token).readBinary('FID')).toBe(buf);
  });
});

describe('DriveClient.listTree', () => {
  it('parcourt récursivement et calcule les chemins relatifs', async () => {
    const byFolder: Record<string, unknown> = {
      root: { files: [
        { id: 'd1', name: 'cycles', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' },
        { id: 'f1', name: 'note.md', mimeType: 'text/markdown', modifiedTime: 't' },
      ] },
      d1: { files: [
        { id: 'f2', name: 'jan.md', mimeType: 'text/markdown', modifiedTime: 't' },
      ] },
    };
    const http = vi.fn(async (req: { url: string }) => {
      const m = /%27([^%]+)%27%20in%20parents/.exec(req.url);
      const folder = m ? m[1] : 'root';
      return res(200, byFolder[folder] ?? { files: [] });
    }) as unknown as HttpFn;

    const nodes = await new DriveClient(http, token).listTree();
    const paths = nodes.map((n) => n.path).sort();
    expect(paths).toEqual(['cycles', 'cycles/jan.md', 'note.md']);
    const cycles = nodes.find((n) => n.path === 'cycles')!;
    expect(cycles.isFolder).toBe(true);
    expect(nodes.find((n) => n.path === 'cycles/jan.md')!.isFolder).toBe(false);
  });
});

describe('DriveClient.subtree', () => {
  it('parcourt un dossier quelconque avec chemins relatifs au parent', async () => {
    const byFolder: Record<string, unknown> = {
      D: { files: [
        { id: 's1', name: 'sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't' },
        { id: 'f1', name: 'a.md', mimeType: 'text/markdown', modifiedTime: 't' },
      ] },
      s1: { files: [{ id: 'f2', name: 'b.md', mimeType: 'text/markdown', modifiedTime: 't' }] },
    };
    const http = vi.fn(async (req: { url: string }) => {
      const m = /%27([^%]+)%27%20in%20parents/.exec(req.url);
      return res(200, byFolder[m ? m[1] : ''] ?? { files: [] });
    }) as unknown as HttpFn;
    const nodes = await new DriveClient(http, token).subtree('D', 'dir');
    expect(nodes.map((n) => n.path).sort()).toEqual(['dir/a.md', 'dir/sub', 'dir/sub/b.md']);
  });

  it('rejette avec CancelledError si le token est déjà annulé', async () => {
    const http = vi.fn(async () => res(200, { files: [] })) as unknown as HttpFn;
    const client = new DriveClient(http, token);
    const cancelToken = new CancelToken();
    cancelToken.cancel();
    await expect(client.subtree('root', '', cancelToken)).rejects.toThrow('Annulé');
  });
});

describe('DriveClient.updateText', () => {
  it('PATCH le contenu en upload média', async () => {
    const http = vi.fn(async () => res(200, { id: 'x' })) as unknown as HttpFn;
    await new DriveClient(http, token).updateText('FID', 'nouveau');
    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.method).toBe('PATCH');
    expect(call.url).toContain('/upload/drive/v3/files/FID');
    expect(call.url).toContain('uploadType=media');
    expect(call.body).toBe('nouveau');
    expect(call.headers?.Authorization).toBe('Bearer AT');
  });

  it('throw si status ≠ 200', async () => {
    const http = vi.fn(async () => res(403, 'no')) as unknown as HttpFn;
    await expect(new DriveClient(http, token).updateText('X', 'c')).rejects.toThrow('403');
  });
});

describe('DriveClient.getRevision', () => {
  it('GET les métadonnées de révision', async () => {
    const http = vi.fn(async () => res(200, { headRevisionId: 'rev9', modifiedTime: 't9' })) as unknown as HttpFn;
    const r = await new DriveClient(http, token).getRevision('FID');
    expect(r.headRevisionId).toBe('rev9');
    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.url).toContain('/files/FID');
    expect(call.url).toContain('headRevisionId');
  });
});

describe('DriveClient.updateText renvoie la révision', () => {
  it('retourne headRevisionId de la réponse', async () => {
    const http = vi.fn(async () => res(200, { headRevisionId: 'rNEW' })) as unknown as HttpFn;
    expect(await new DriveClient(http, token).updateText('FID', 'c')).toBe('rNEW');
  });
});

describe('DriveClient.createFile', () => {
  it('POST multipart avec métadonnées + contenu, renvoie id+rev', async () => {
    const http = vi.fn(async () => res(200, { id: 'NEW', headRevisionId: 'r1' })) as unknown as HttpFn;
    const r = await new DriveClient(http, token).createFile('PARENT', 'note.md', 'contenu');
    expect(r).toEqual({ id: 'NEW', headRevisionId: 'r1' });
    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/upload/drive/v3/files');
    expect(call.url).toContain('uploadType=multipart');
    expect(call.body).toContain('note.md');
    expect(call.body).toContain('"parents":["PARENT"]');
    expect(call.body).toContain('contenu');
  });
});

describe('DriveClient.createBinaryFile', () => {
  it('construit un corps multipart binaire-safe (métadonnées JSON + octets bruts intacts)', async () => {
    const http = vi.fn(async () => res(200, { id: 'NEWBIN', headRevisionId: 'r1' })) as unknown as HttpFn;
    const data = new Uint8Array([0, 1, 2, 255, 254, 253]).buffer;
    const r = await new DriveClient(http, token).createBinaryFile('PARENT', 'photo.png', data, 'image/png');
    expect(r).toEqual({ id: 'NEWBIN', headRevisionId: 'r1' });
    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.method).toBe('POST');
    expect(call.url).toContain('uploadType=multipart');
    expect(call.headers?.['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    expect(call.body).toBeInstanceOf(ArrayBuffer);
    const bytes = new Uint8Array(call.body as ArrayBuffer);
    // les octets binaires bruts apparaissent intacts quelque part dans le corps envoyé
    const dataBytes = new Uint8Array(data);
    let found = -1;
    for (let i = 0; i <= bytes.length - dataBytes.length; i++) {
      if (dataBytes.every((b, j) => bytes[i + j] === b)) { found = i; break; }
    }
    expect(found).toBeGreaterThanOrEqual(0);
    // les métadonnées (nom + parent) sont présentes en clair
    const asText = new TextDecoder().decode(bytes);
    expect(asText).toContain('"photo.png"');
    expect(asText).toContain('"PARENT"');
  });
});

describe('DriveClient.aboutUser', () => {
  it('récupère l email et le nom du compte connecté', async () => {
    const http = vi.fn(async () => res(200, { user: { emailAddress: 'loic@example.com', displayName: 'Loïc' } })) as unknown as HttpFn;
    const r = await new DriveClient(http, token).aboutUser();
    expect(r).toEqual({ email: 'loic@example.com', name: 'Loïc' });
    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.url).toContain('/about?fields=');
    expect(call.headers?.Authorization).toBe('Bearer AT');
  });

  it('throw sur status non-200', async () => {
    const http = vi.fn(async () => res(401, 'unauthorized')) as unknown as HttpFn;
    await expect(new DriveClient(http, token).aboutUser()).rejects.toThrow('401');
  });
});

describe('DriveClient.moveFile', () => {
  it('récupère les parents actuels puis PATCH addParents/removeParents + nom', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const http = vi.fn(async (req: { url: string; method?: string; body?: string }) => {
      calls.push(req);
      if (req.url.includes('fields=parents')) return res(200, { parents: ['OLD_PARENT'] });
      return res(200, { id: 'F' });
    }) as unknown as HttpFn;
    await new DriveClient(http, token).moveFile('F', { name: 'nouveau.md', addParentId: 'NEW_PARENT' });
    // 1er appel : GET parents ; 2e : PATCH move
    expect(calls[0].url).toContain('/files/F?fields=parents');
    const patch = calls[1];
    expect(patch.method).toBe('PATCH');
    expect(patch.url).toContain('addParents=NEW_PARENT');
    expect(patch.url).toContain('removeParents=OLD_PARENT');
    expect(patch.body).toContain('"name":"nouveau.md"');
  });

  it('ne retire pas un parent égal au nouveau (déplacement dans le même dossier = simple renommage)', async () => {
    const calls: { url: string }[] = [];
    const http = vi.fn(async (req: { url: string }) => {
      calls.push(req);
      if (req.url.includes('fields=parents')) return res(200, { parents: ['SAME'] });
      return res(200, { id: 'F' });
    }) as unknown as HttpFn;
    await new DriveClient(http, token).moveFile('F', { name: 'x.md', addParentId: 'SAME' });
    expect(calls[1].url).not.toContain('removeParents');
  });
});

describe('DriveClient.getStartPageToken / listChanges', () => {
  it('getStartPageToken renvoie le jeton de départ', async () => {
    const http = vi.fn(async () => res(200, { startPageToken: 'TOK1' })) as unknown as HttpFn;
    expect(await new DriveClient(http, token).getStartPageToken()).toBe('TOK1');
    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.url).toContain('/changes/startPageToken');
  });

  it('listChanges remonte fileId + removed (removed ou trashed) + nom/parents actuels', async () => {
    const http = vi.fn(async () => res(200, {
      changes: [
        { fileId: 'A', file: { name: 'Renommé.md', parents: ['P1'], trashed: false } },
        { fileId: 'B', removed: true },
        { fileId: 'C', file: { trashed: true } },
      ],
      newStartPageToken: 'TOK2',
    })) as unknown as HttpFn;
    const r = await new DriveClient(http, token).listChanges('TOK1');
    expect(r.changes).toEqual([
      { fileId: 'A', removed: false, name: 'Renommé.md', parents: ['P1'], mimeType: undefined },
      { fileId: 'B', removed: true, name: undefined, parents: undefined, mimeType: undefined },
      { fileId: 'C', removed: true, name: undefined, parents: undefined, mimeType: undefined },
    ]);
    expect(r.newStartPageToken).toBe('TOK2');
    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.url).toContain('pageToken=TOK1');
    expect(call.url).toContain(encodeURIComponent('file(name,parents,trashed,mimeType)'));
  });

  it('listChanges remonte nextPageToken pour la pagination', async () => {
    const http = vi.fn(async () => res(200, { changes: [{ fileId: 'X' }], nextPageToken: 'P2' })) as unknown as HttpFn;
    const r = await new DriveClient(http, token).listChanges('P1');
    expect(r.nextPageToken).toBe('P2');
    expect(r.newStartPageToken).toBeUndefined();
  });
});

describe('DriveClient.createDriveFolder', () => {
  it('POST un dossier et renvoie l id', async () => {
    const http = vi.fn(async () => res(200, { id: 'FID' })) as unknown as HttpFn;
    const r = await new DriveClient(http, token).createDriveFolder('PARENT', 'dossier');
    expect(r).toEqual({ id: 'FID' });
    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.method).toBe('POST');
    expect(call.body).toContain('application/vnd.google-apps.folder');
    expect(call.body).toContain('"parents":["PARENT"]');
  });
});
