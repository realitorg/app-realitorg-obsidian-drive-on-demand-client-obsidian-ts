import { describe, it, expect } from 'vitest';
import { PluginDataStore, keyedAdapter } from './plugin-data';

function backing() {
  const disk: { blob: Record<string, unknown> | null } = { blob: null };
  return {
    disk,
    load: async () => disk.blob,
    save: async (d: Record<string, unknown>) => { disk.blob = JSON.parse(JSON.stringify(d)) as Record<string, unknown>; },
  };
}

describe('PluginDataStore + keyedAdapter', () => {
  it('deux adaptateurs partagent le blob sans se clobbeer', async () => {
    const b = backing();
    const store = new PluginDataStore(b.load, b.save);
    await store.init();

    const rt = keyedAdapter(store, 'rt');
    const mirror = keyedAdapter(store, 'mirror');

    const rtData = await rt.load();
    rtData['value'] = 'token';
    await rt.save(rtData);

    const mData = await mirror.load();
    mData['x'] = 1;
    await mirror.save(mData);

    // le disque contient les DEUX sous-objets
    expect(b.disk.blob).toEqual({ rt: { value: 'token' }, mirror: { x: 1 } });
  });

  it('init lit le blob existant', async () => {
    const b = backing();
    b.disk.blob = { rt: { value: 'v' } };
    const store = new PluginDataStore(b.load, b.save);
    await store.init();
    expect(keyedAdapter(store, 'rt')).toBeDefined();
    expect(await keyedAdapter(store, 'rt').load()).toEqual({ value: 'v' });
  });
});
