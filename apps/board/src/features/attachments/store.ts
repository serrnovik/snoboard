// Image bytes for basket attachments live in IndexedDB, not in localStorage: the
// basket (localStorage, about 5 MB per origin) only keeps the reference edit.

export type StoredImage = {
  bytes: Uint8Array;
  contentType: string;
  name: string;
};

export type ImageBackend = {
  put(key: string, value: StoredImage): Promise<void>;
  get(key: string): Promise<StoredImage | undefined>;
  delete(key: string): Promise<void>;
};

const DB_NAME = "snoboard-attachments";
const STORE = "images";

let backend: ImageBackend | undefined;

/** Tests swap in an in-memory backend. Pass undefined to go back to IndexedDB. */
export function setImageBackend(next: ImageBackend | undefined): void {
  backend = next;
}

export function memoryImageBackend(): ImageBackend & { size(): number } {
  const map = new Map<string, StoredImage>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key),
    delete: async (key) => {
      map.delete(key);
    },
    size: () => map.size,
  };
}

function current(): ImageBackend {
  backend ??= indexedDbBackend();
  return backend;
}

export function putImage(key: string, value: StoredImage): Promise<void> {
  return current().put(key, value);
}

export function getImage(key: string): Promise<StoredImage | undefined> {
  return current().get(key);
}

/** Best-effort: a missing database or key is not an error. */
export function deleteImage(key: string): Promise<void> {
  return current()
    .delete(key)
    .catch(() => undefined);
}

/** A random key for a new image (URL-safe, 22 characters). */
export function newImageKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function indexedDbBackend(): ImageBackend {
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser cannot store images."));
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open image storage."));
    });
    return opened;
  };
  const run = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Image storage failed."));
    });
  };
  return {
    put: async (key, value) => {
      await run("readwrite", (store) => store.put(value, key));
    },
    get: async (key) => {
      const value: unknown = await run("readonly", (store) => store.get(key));
      return isStoredImage(value) ? value : undefined;
    },
    delete: async (key) => {
      await run("readwrite", (store) => store.delete(key));
    },
  };
}

function isStoredImage(value: unknown): value is StoredImage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.bytes instanceof Uint8Array && typeof record.contentType === "string" && typeof record.name === "string";
}
