import type { SettingsBackend } from '@/core/settings-store';

type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void;

export function createMemoryBackend(options: { failWrites?: boolean } = {}) {
  const data: Record<string, unknown> = {};
  const listeners = new Set<Listener>();
  let gate: Promise<void> | undefined;
  const emit = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName = 'local') => {
    for (const listener of listeners) listener(changes, areaName);
  };
  const backend: SettingsBackend = {
    area: {
      get: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
      },
      set: async (items) => {
        if (gate) await gate;
        if (options.failWrites) throw new Error('QUOTA_BYTES quota exceeded');
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: data[key], newValue: value };
          data[key] = value;
        }
        emit(changes);
      },
      remove: async (keys) => {
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          changes[key] = { oldValue: data[key] };
          delete data[key];
        }
        emit(changes);
      },
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
  };
  /** Suspends every write until the returned release function is called. */
  const holdWrites = () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = () => ((gate = undefined), resolve())));
    return release;
  };
  return { backend, data, emit, holdWrites };
}
