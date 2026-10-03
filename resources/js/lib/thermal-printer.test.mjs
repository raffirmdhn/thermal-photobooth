import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createEscPosPrintJob,
    createEscPosRasterBands,
    getPrintLayoutDimensions,
    packMonochromeRaster,
    processPixels,
    RPP02N_BAUD_RATE,
    RPP02N_BLUETOOTH_NAME,
    RPP02N_BLUETOOTH_SERVICE_CLASS_ID,
    RPP02N_TEST_FEED_COMMAND,
    RPP02N_USB_PRODUCT_ID,
    RPP02N_USB_VENDOR_ID,
    isRpp02nBluetoothPort,
} from './thermal-printer.ts';

test('keeps a small border around the photobooth print layout', () => {
    assert.deepEqual(getPrintLayoutDimensions(240), {
        photoWidth: 348,
        height: 400,
    });
});

test('uses the RPP02N Bluetooth name and serial settings from its self-test', () => {
    assert.equal(RPP02N_BLUETOOTH_NAME, 'RPP02N-2A38');
    assert.equal(RPP02N_BAUD_RATE, 115200);
    assert.equal(
        RPP02N_BLUETOOTH_SERVICE_CLASS_ID,
        '00001101-0000-1000-8000-00805f9b34fb',
    );
});

test('creates an ESC/POS feed-only connection test command', () => {
    assert.deepEqual([...RPP02N_TEST_FEED_COMMAND], [27, 100, 3]);
});

test('only reuses an authorized RPP02N Bluetooth serial port', () => {
    assert.equal(
        isRpp02nBluetoothPort({
            bluetoothServiceClassId: '00001101-0000-1000-8000-00805F9B34FB',
        }),
        true,
    );
    assert.equal(
        isRpp02nBluetoothPort({
            bluetoothServiceClassId: '00001102-0000-1000-8000-00805f9b34fb',
        }),
        false,
    );
});

test('uses the detected RPP02N USB identifiers', () => {
    assert.equal(RPP02N_USB_VENDOR_ID, 0x0fe6);
    assert.equal(RPP02N_USB_PRODUCT_ID, 0x811e);
});

test('thresholds pixels after brightness and contrast adjustments', () => {
    const rgba = new Uint8ClampedArray([
        0, 0, 0, 255, 127, 127, 127, 255, 128, 128, 128, 255, 255, 255, 255,
        255,
    ]);

    assert.deepEqual(
        [
            ...processPixels(rgba, 4, 1, {
                brightness: 0,
                contrast: 0,
                threshold: 128,
                mode: 'threshold',
            }),
        ],
        [0, 0, 255, 255],
    );
});

test('Floyd-Steinberg dithering distributes error to later pixels', () => {
    const rgba = new Uint8ClampedArray([
        96, 96, 96, 255, 96, 96, 96, 255, 96, 96, 96, 255, 96, 96, 96, 255,
    ]);

    assert.deepEqual(
        [
            ...processPixels(rgba, 4, 1, {
                brightness: 0,
                contrast: 0,
                threshold: 128,
                mode: 'dither',
            }),
        ],
        [0, 255, 0, 0],
    );
});

test('packs eight monochrome dots into one printer byte', () => {
    const pixels = new Uint8ClampedArray([0, 255, 0, 255, 0, 255, 0, 255]);

    assert.deepEqual([...packMonochromeRaster(pixels, 8, 1)], [0b10101010]);
    assert.throws(() => packMonochromeRaster(pixels, 7, 1));
});

test('creates 48-byte rows and splits tall 384-dot images into bands', () => {
    const pixels = new Uint8ClampedArray(384 * 257).fill(255);
    const bands = createEscPosRasterBands(pixels, 384, 257, 256);

    assert.equal(bands.length, 2);
    assert.deepEqual(
        bands[0].slice(0, 8),
        new Uint8Array([29, 118, 48, 0, 48, 0, 0, 1]),
    );
    assert.equal(bands[0].length, 8 + 48 * 256);
    assert.deepEqual(
        bands[1].slice(0, 8),
        new Uint8Array([29, 118, 48, 0, 48, 0, 1, 0]),
    );
});

test('wraps the raster bands in the RPP02N ESC/POS print job', () => {
    const job = createEscPosPrintJob(new Uint8ClampedArray(384), 384, 1);

    assert.deepEqual([...job[0]], [27, 64, 27, 97, 1]);
    assert.deepEqual([...job.at(-1)], [10, 10, 10]);
});
