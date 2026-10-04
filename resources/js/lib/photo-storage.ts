export interface HistoryPhoto {
    id: string;
    timestamp: number;
    name: string;
    source: 'camera' | 'upload';
    dataUrl: string;
    thumbnailUrl: string;
    settings?: {
        brightness: number;
        contrast: number;
        threshold: number;
        mode: 'threshold' | 'dither';
    };
}

const DB_NAME = 'thermal_photobooth_db';
const DB_VERSION = 1;
const STORE_NAME = 'photos';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof window === 'undefined' || !window.indexedDB) {
            reject(new Error('IndexedDB not supported in this environment'));
            return;
        }

        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open database'));
    });
}

export async function getAllHistoryPhotos(): Promise<HistoryPhoto[]> {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                const photos = (request.result as HistoryPhoto[]) || [];
                photos.sort((a, b) => b.timestamp - a.timestamp);
                resolve(photos);
            };

            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('IndexedDB unavailable, falling back to empty list', e);
        return [];
    }
}

export async function savePhotoToHistory(
    photo: Omit<HistoryPhoto, 'id' | 'timestamp'> & { id?: string; timestamp?: number }
): Promise<HistoryPhoto> {
    const newPhoto: HistoryPhoto = {
        id: photo.id || `photo_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        timestamp: photo.timestamp || Date.now(),
        name: photo.name,
        source: photo.source,
        dataUrl: photo.dataUrl,
        thumbnailUrl: photo.thumbnailUrl,
        settings: photo.settings,
    };

    try {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(newPhoto);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('Could not save photo to IndexedDB', e);
    }

    return newPhoto;
}

export async function deletePhotoFromHistory(id: string): Promise<void> {
    try {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('Could not delete photo from IndexedDB', e);
    }
}

export async function clearAllHistoryPhotos(): Promise<void> {
    try {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('Could not clear photos from IndexedDB', e);
    }
}

export function createThumbnailDataUrl(
    img: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    maxDimension = 240
): string {
    const canvas = document.createElement('canvas');
    let width = sourceWidth;
    let height = sourceHeight;

    if (width > height) {
        if (width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
        }
    } else {
        if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
        }
    }

    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.85);
}
