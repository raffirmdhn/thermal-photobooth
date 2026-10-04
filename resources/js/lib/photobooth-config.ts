import type { ProcessingMode } from './thermal-printer';

export interface PhotoboothConfig {
    brightness: number;
    contrast: number;
    threshold: number;
    mode: ProcessingMode;
    isPixelZoom: boolean;
    countdown: number;
    mirrorCamera: boolean;
}

export const DEFAULT_CONFIG: PhotoboothConfig = {
    brightness: 0,
    contrast: 0,
    threshold: 128,
    mode: 'dither',
    isPixelZoom: false,
    countdown: 0,
    mirrorCamera: true,
};

export const CONFIG_STORAGE_KEY = 'thermal_photobooth_config_v1';

export function loadStoredConfig(): PhotoboothConfig {
    if (typeof window === 'undefined' || !window.localStorage) {
        return DEFAULT_CONFIG;
    }

    try {
        const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
        if (!raw) {
            return DEFAULT_CONFIG;
        }

        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
            return DEFAULT_CONFIG;
        }

        return {
            brightness:
                typeof parsed.brightness === 'number' &&
                parsed.brightness >= -100 &&
                parsed.brightness <= 100
                    ? parsed.brightness
                    : DEFAULT_CONFIG.brightness,
            contrast:
                typeof parsed.contrast === 'number' &&
                parsed.contrast >= -100 &&
                parsed.contrast <= 100
                    ? parsed.contrast
                    : DEFAULT_CONFIG.contrast,
            threshold:
                typeof parsed.threshold === 'number' &&
                parsed.threshold >= 0 &&
                parsed.threshold <= 255
                    ? parsed.threshold
                    : DEFAULT_CONFIG.threshold,
            mode:
                parsed.mode === 'dither' || parsed.mode === 'threshold'
                    ? parsed.mode
                    : DEFAULT_CONFIG.mode,
            isPixelZoom:
                typeof parsed.isPixelZoom === 'boolean'
                    ? parsed.isPixelZoom
                    : DEFAULT_CONFIG.isPixelZoom,
            countdown:
                typeof parsed.countdown === 'number' && [0, 3, 5, 10].includes(parsed.countdown)
                    ? parsed.countdown
                    : DEFAULT_CONFIG.countdown,
            mirrorCamera:
                typeof parsed.mirrorCamera === 'boolean'
                    ? parsed.mirrorCamera
                    : DEFAULT_CONFIG.mirrorCamera,
        };
    } catch (e) {
        console.warn('Failed to load photobooth config from localStorage', e);
        return DEFAULT_CONFIG;
    }
}

export function saveStoredConfig(config: PhotoboothConfig): void {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }

    try {
        window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
        console.warn('Failed to save photobooth config to localStorage', e);
    }
}

export function clearStoredConfig(): void {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }

    try {
        window.localStorage.removeItem(CONFIG_STORAGE_KEY);
    } catch (e) {
        console.warn('Failed to remove photobooth config from localStorage', e);
    }
}
