import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_CONFIG,
    CONFIG_STORAGE_KEY,
    loadStoredConfig,
    saveStoredConfig,
    clearStoredConfig,
} from './photobooth-config.ts';

test('DEFAULT_CONFIG contains expected standard values', () => {
    assert.equal(DEFAULT_CONFIG.brightness, 0);
    assert.equal(DEFAULT_CONFIG.contrast, 0);
    assert.equal(DEFAULT_CONFIG.threshold, 128);
    assert.equal(DEFAULT_CONFIG.mode, 'dither');
    assert.equal(DEFAULT_CONFIG.isPixelZoom, false);
    assert.equal(DEFAULT_CONFIG.countdown, 0);
    assert.equal(DEFAULT_CONFIG.mirrorCamera, true);
    assert.equal(CONFIG_STORAGE_KEY, 'thermal_photobooth_config_v1');
});
