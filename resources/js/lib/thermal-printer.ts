export const PRINTER_WIDTH = 384;
export const RASTER_BAND_HEIGHT = 256;
export const PRINT_LAYOUT = {
    horizontalPadding: 18,
    topPadding: 18,
    headerHeight: 70,
    headerGap: 14,
    footerGap: 16,
    footerHeight: 24,
    bottomPadding: 18,
} as const;
export const RPP02N_BLUETOOTH_NAME = 'RPP02N-2A38';
export const RPP02N_BAUD_RATE = 115200;
export const RPP02N_BLUETOOTH_SERVICE_CLASS_ID =
    '00001101-0000-1000-8000-00805f9b34fb';
export const RPP02N_TEST_FEED_COMMAND = [0x1b, 0x64, 0x03] as const;
export const RPP02N_USB_VENDOR_ID = 0x0fe6;
export const RPP02N_USB_PRODUCT_ID = 0x811e;

export function isRpp02nBluetoothPort(info: {
    bluetoothServiceClassId?: string;
}): boolean {
    return (
        info.bluetoothServiceClassId?.toLowerCase() ===
        RPP02N_BLUETOOTH_SERVICE_CLASS_ID
    );
}

export type ProcessingMode = 'threshold' | 'dither';

export type ProcessingSettings = {
    brightness: number;
    contrast: number;
    threshold: number;
    mode: ProcessingMode;
};

export function getPrintLayoutDimensions(photoHeight: number): {
    photoWidth: number;
    height: number;
} {
    return {
        photoWidth: PRINTER_WIDTH - PRINT_LAYOUT.horizontalPadding * 2,
        height:
            PRINT_LAYOUT.topPadding +
            PRINT_LAYOUT.headerHeight +
            PRINT_LAYOUT.headerGap +
            photoHeight +
            PRINT_LAYOUT.footerGap +
            PRINT_LAYOUT.footerHeight +
            PRINT_LAYOUT.bottomPadding,
    };
}

const clamp = (value: number): number => Math.max(0, Math.min(255, value));

export function processPixels(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    settings: ProcessingSettings,
): Uint8ClampedArray {
    const grayscale = new Float32Array(width * height);
    const contrast = settings.contrast * 2.55;
    const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));

    for (let pixel = 0; pixel < grayscale.length; pixel++) {
        const offset = pixel * 4;
        const luminance =
            rgba[offset] * 0.299 +
            rgba[offset + 1] * 0.587 +
            rgba[offset + 2] * 0.114;
        const brightened = luminance + settings.brightness * 2.55;

        grayscale[pixel] = clamp(contrastFactor * (brightened - 128) + 128);
    }

    const output = new Uint8ClampedArray(grayscale.length);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const oldValue = grayscale[pixel];
            const newValue = oldValue < settings.threshold ? 0 : 255;

            output[pixel] = newValue;

            if (settings.mode === 'dither') {
                const error = oldValue - newValue;

                if (x + 1 < width) {
                    grayscale[pixel + 1] += (error * 7) / 16;
                }
                if (y + 1 < height) {
                    if (x > 0) {
                        grayscale[pixel + width - 1] += (error * 3) / 16;
                    }
                    grayscale[pixel + width] += (error * 5) / 16;
                    if (x + 1 < width) {
                        grayscale[pixel + width + 1] += error / 16;
                    }
                }
            }
        }
    }

    return output;
}

export function packMonochromeRaster(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
): Uint8Array {
    if (width % 8 !== 0 || pixels.length !== width * height) {
        throw new Error('Raster dimensions must contain complete 8-dot rows.');
    }

    const bytesPerRow = width / 8;
    const raster = new Uint8Array(bytesPerRow * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (pixels[y * width + x] < 128) {
                raster[y * bytesPerRow + Math.floor(x / 8)] |= 0x80 >> (x % 8);
            }
        }
    }

    return raster;
}

export function createEscPosRasterBands(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    bandHeight = RASTER_BAND_HEIGHT,
): Uint8Array[] {
    if (bandHeight < 1) {
        throw new Error('Raster band height must be positive.');
    }

    const raster = packMonochromeRaster(pixels, width, height);
    const bytesPerRow = width / 8;
    const bands: Uint8Array[] = [];

    for (let startRow = 0; startRow < height; startRow += bandHeight) {
        const rows = Math.min(bandHeight, height - startRow);
        const command = new Uint8Array(8 + bytesPerRow * rows);

        command.set([
            0x1d,
            0x76,
            0x30,
            0x00,
            bytesPerRow & 0xff,
            (bytesPerRow >> 8) & 0xff,
            rows & 0xff,
            (rows >> 8) & 0xff,
        ]);
        command.set(
            raster.subarray(
                startRow * bytesPerRow,
                (startRow + rows) * bytesPerRow,
            ),
            8,
        );
        bands.push(command);
    }

    return bands;
}

export function createEscPosPrintJob(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    bandHeight = RASTER_BAND_HEIGHT,
): Uint8Array[] {
    return [
        new Uint8Array([0x1b, 0x40, 0x1b, 0x61, 0x01]),
        ...createEscPosRasterBands(pixels, width, height, bandHeight),
        new Uint8Array([0x0a, 0x0a, 0x0a]),
    ];
}
