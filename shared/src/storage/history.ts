import { StudioError } from "../errors";
import type { VideoRecord } from "../types";

const DB_NAME = "youtube-transcript-studio";
const DB_VERSION = 1;
const STORE = "videos";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new StudioError("cache", "IndexedDB is not available in this browser."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "videoId" });
        store.createIndex("processedAt", "processedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StudioError("cache", "The local history database could not be opened."));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StudioError("cache", "A local history request failed."));
  });
}

export async function saveVideo(record: VideoRecord): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function getVideo(videoId: string): Promise<VideoRecord | null> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, "readonly");
    const record = await requestToPromise(tx.objectStore(STORE).get(videoId));
    return (record as VideoRecord | undefined) ?? null;
  } finally {
    db.close();
  }
}

export async function listVideos(): Promise<VideoRecord[]> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, "readonly");
    const records = (await requestToPromise(tx.objectStore(STORE).getAll())) as VideoRecord[];
    return records.sort((a, b) => b.processedAt - a.processedAt);
  } finally {
    db.close();
  }
}

export async function deleteVideo(videoId: string): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(videoId);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function clearVideos(): Promise<void> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new StudioError("cache", "The local history update failed."));
    tx.onabort = () => reject(new StudioError("cache", "The local history update was aborted."));
  });
}
