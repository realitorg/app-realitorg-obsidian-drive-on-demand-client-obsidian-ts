import { describe, it, expect, vi } from 'vitest';
import { listRootFiles } from './drive-list';
import type { HttpFn, HttpResponse } from './http';

function jsonResponse(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return { status, text, json: <T>() => JSON.parse(text) as T };
}

describe('listRootFiles', () => {
  it('interroge la racine (root in parents) et mappe les fichiers', async () => {
    const http = vi.fn(async () => jsonResponse(200, {
      files: [{ id: 'a', name: 'Note.md', mimeType: 'text/markdown' }],
    })) as unknown as HttpFn;

    const files = await listRootFiles(http, 'AT');
    expect(files).toEqual([{ id: 'a', name: 'Note.md', mimeType: 'text/markdown' }]);

    const call = vi.mocked(http).mock.calls[0][0];
    expect(call.url).toContain('%27root%27%20in%20parents');
    expect(call.headers?.Authorization).toBe('Bearer AT');
  });

  it('retourne [] si aucune clé files', async () => {
    const http = vi.fn(async () => jsonResponse(200, {})) as unknown as HttpFn;
    expect(await listRootFiles(http, 'AT')).toEqual([]);
  });
});
