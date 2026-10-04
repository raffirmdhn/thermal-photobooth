import { Head } from '@inertiajs/react';
import {
    Bluetooth,
    Camera,
    Check,
    Clock,
    Copy,
    Download,
    FileImage,
    FlipHorizontal,
    Focus,
    Image as ImageIcon,
    Printer,
    RotateCcw,
    SlidersHorizontal,
    Sparkles,
    Timer,
    Trash2,
    Unplug,
    Usb,
} from 'lucide-react';
import {
    type ChangeEvent,
    type DragEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { toast } from 'sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    clearAllHistoryPhotos,
    createThumbnailDataUrl,
    deletePhotoFromHistory,
    getAllHistoryPhotos,
    type HistoryPhoto,
    savePhotoToHistory,
} from '@/lib/photo-storage';
import {
    clearStoredConfig,
    DEFAULT_CONFIG,
    loadStoredConfig,
    saveStoredConfig,
} from '@/lib/photobooth-config';
import {
    createEscPosPrintJob,
    getPrintLayoutDimensions,
    isRpp02nBluetoothPort,
    PRINTER_WIDTH,
    PRINT_LAYOUT,
    processPixels,
    type ProcessingMode,
    RPP02N_BAUD_RATE,
    RPP02N_BLUETOOTH_NAME,
    RPP02N_BLUETOOTH_SERVICE_CLASS_ID,
    RPP02N_TEST_FEED_COMMAND,
    RPP02N_USB_PRODUCT_ID,
    RPP02N_USB_VENDOR_ID,
} from '@/lib/thermal-printer';

type PrinterState =
    | 'unsupported'
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'printing'
    | 'testing'
    | 'ready'
    | 'error';

type SerialPortLike = {
    getInfo?(): {
        bluetoothServiceClassId?: string;
        usbProductId?: number;
        usbVendorId?: number;
    };
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    open(options: {
        baudRate: number;
        dataBits: number;
        stopBits: number;
        parity: 'none';
        flowControl: 'none';
    }): Promise<void>;
    close(): Promise<void>;
};

type SerialRequestOptions = {
    allowedBluetoothServiceClassIds?: string[];
};

type SerialApi = {
    getPorts(): Promise<SerialPortLike[]>;
    requestPort(options?: SerialRequestOptions): Promise<SerialPortLike>;
};

type PrinterWrite = (data: Uint8Array) => Promise<void>;
type PrinterCommand = (write: PrinterWrite) => Promise<void>;

type UsbEndpointLike = {
    direction: 'in' | 'out';
    endpointNumber: number;
    type: string;
};

type UsbAlternateInterfaceLike = {
    alternateSetting: number;
    endpoints: UsbEndpointLike[];
    interfaceClass: number;
};

type UsbInterfaceLike = {
    alternates: UsbAlternateInterfaceLike[];
    interfaceNumber: number;
};

type UsbConfigurationLike = {
    configurationValue: number;
    interfaces: UsbInterfaceLike[];
};

type UsbDeviceLike = {
    configurations: UsbConfigurationLike[];
    configuration: UsbConfigurationLike | null;
    opened: boolean;
    productId: number;
    transferOut(
        endpointNumber: number,
        data: Uint8Array,
    ): Promise<{ bytesWritten: number; status: string }>;
    vendorId: number;
    claimInterface(interfaceNumber: number): Promise<void>;
    close(): Promise<void>;
    open(): Promise<void>;
    releaseInterface(interfaceNumber: number): Promise<void>;
    selectAlternateInterface(
        interfaceNumber: number,
        alternateSetting: number,
    ): Promise<void>;
    selectConfiguration(configurationValue: number): Promise<void>;
};

type UsbApi = {
    getDevices(): Promise<UsbDeviceLike[]>;
    requestDevice(options: {
        filters: Array<{ productId: number; vendorId: number }>;
    }): Promise<UsbDeviceLike>;
};

type UsbEndpointSelection = {
    alternateSetting: number;
    endpointNumber: number;
    interfaceNumber: number;
};

function findUsbOutputEndpoint(
    configuration: UsbConfigurationLike,
): UsbEndpointSelection {
    const candidates: Array<UsbEndpointSelection & { interfaceClass: number }> =
        [];

    for (const usbInterface of configuration.interfaces) {
        for (const alternate of usbInterface.alternates) {
            const endpoint = alternate.endpoints.find(
                ({ direction, type }) => direction === 'out' && type === 'bulk',
            );

            if (endpoint) {
                candidates.push({
                    alternateSetting: alternate.alternateSetting,
                    endpointNumber: endpoint.endpointNumber,
                    interfaceClass: alternate.interfaceClass,
                    interfaceNumber: usbInterface.interfaceNumber,
                });
            }
        }
    }

    const endpoint =
        candidates.find(({ interfaceClass }) => interfaceClass === 0x07) ??
        candidates[0];

    if (!endpoint) {
        throw new Error('The USB printer has no writable bulk endpoint.');
    }

    return endpoint;
}

async function sendEscPosPrintJob(
    write: PrinterWrite,
    pixels: Uint8ClampedArray,
    height: number,
): Promise<void> {
    for (const band of createEscPosPrintJob(pixels, PRINTER_WIDTH, height)) {
        for (let offset = 0; offset < band.length; offset += 4096) {
            await write(band.subarray(offset, offset + 4096));
        }
    }
}

const stateCopy: Record<PrinterState, string> = {
    unsupported:
        'Use Chrome or Edge desktop on HTTPS or localhost for USB/Bluetooth printing.',
    disconnected: `Connect Virtual PRN by USB or pair ${RPP02N_BLUETOOTH_NAME} by Bluetooth, then choose it in the browser picker.`,
    connecting: `Select Virtual PRN (USB) or ${RPP02N_BLUETOOTH_NAME} (Bluetooth) in the browser picker…`,
    connected: 'Printer transport opened. Preparing command…',
    printing: 'Sending image to the printer…',
    testing: 'Sending feed-only test command…',
    ready: 'Printer command sent. Ready to print.',
    error: 'Printer connection failed. Check the cable, pairing, or printer paper.',
};

function playAudioBeep(freq = 880, duration = 0.08) {
    try {
        const AudioContextClass =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
                .webkitAudioContext;
        if (!AudioContextClass) {
            return;
        }
        const audioCtx = new AudioContextClass();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(
            0.001,
            audioCtx.currentTime + duration,
        );
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    } catch {
        // Audio playback unavailable or blocked by browser policy
    }
}

function playShutterSound() {
    try {
        const AudioContextClass =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
                .webkitAudioContext;
        if (!AudioContextClass) {
            return;
        }
        const audioCtx = new AudioContextClass();
        const bufferSize = Math.floor(audioCtx.sampleRate * 0.06);
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] =
                (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.25));
        }
        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1400;
        noise.connect(filter);
        filter.connect(audioCtx.destination);
        noise.start();
    } catch {
        // Silent fallback
    }
}

function Control({
    label,
    value,
    min,
    max,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
}) {
    return (
        <label className="grid gap-2 font-mono text-xs font-semibold tracking-[0.12em] uppercase">
            <span className="flex items-center justify-between">
                {label}
                <output className="min-w-12 border border-stone-300 bg-white px-2 py-1 text-center text-sm tracking-normal tabular-nums">
                    {value}
                </output>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                value={value}
                onChange={(event) => onChange(Number(event.target.value))}
                className="thermal-range"
            />
        </label>
    );
}

function ActionButton({
    children,
    disabled,
    onClick,
    tone = 'paper',
    className = '',
}: {
    children: ReactNode;
    disabled?: boolean;
    onClick: () => void;
    tone?: 'paper' | 'ink' | 'red' | 'subtle';
    className?: string;
}) {
    const tones = {
        paper: 'border-stone-950 bg-[#f7f1e3] text-stone-950 hover:bg-white',
        ink: 'border-stone-950 bg-stone-950 text-[#f7f1e3] hover:bg-stone-800',
        red: 'border-[#b42b1e] bg-[#b42b1e] text-white hover:bg-[#8f2017]',
        subtle: 'border-stone-400 bg-white/60 text-stone-800 hover:bg-white',
    };

    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={`inline-flex min-h-11 items-center justify-center gap-2 border-2 px-4 font-mono text-xs font-bold tracking-[0.1em] uppercase shadow-[3px_3px_0_#1c1917] transition-[transform,box-shadow,background-color] hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1c1917] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#b42b1e] disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none ${tones[tone]} ${className}`}
        >
            {children}
        </button>
    );
}

export default function Welcome() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const cameraStreamRef = useRef<MediaStream | null>(null);
    const bluetoothPortRef = useRef<SerialPortLike | null>(null);
    const processedPixelsRef = useRef<Uint8ClampedArray | null>(null);
    const isCapturingRef = useRef(false);

    // Load initial configuration from localStorage
    const [initialConfig] = useState(() => loadStoredConfig());

    const [sourceImage, setSourceImage] = useState<HTMLImageElement | null>(
        null,
    );
    const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
    const [headerLogo, setHeaderLogo] = useState<HTMLImageElement | null>(null);
    const [sourceUrl, setSourceUrl] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);

    // Configuration states (automatically saved to localStorage)
    const [brightness, setBrightness] = useState(initialConfig.brightness);
    const [contrast, setContrast] = useState(initialConfig.contrast);
    const [threshold, setThreshold] = useState(initialConfig.threshold);
    const [mode, setMode] = useState<ProcessingMode>(initialConfig.mode);
    const [isPixelZoom, setIsPixelZoom] = useState(initialConfig.isPixelZoom);
    const [countdownSetting, setCountdownSetting] = useState(
        initialConfig.countdown,
    );
    const [mirrorCamera, setMirrorCamera] = useState(
        initialConfig.mirrorCamera,
    );

    // UI & Action states
    const [error, setError] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isCameraOpen, setIsCameraOpen] = useState(false);
    const [isCameraStarting, setIsCameraStarting] = useState(false);
    const [isCopied, setIsCopied] = useState(false);
    const [activeCountdown, setActiveCountdown] = useState<number | null>(null);
    const [isFlashActive, setIsFlashActive] = useState(false);

    // History state
    const [historyPhotos, setHistoryPhotos] = useState<HistoryPhoto[]>([]);
    const [isClearHistoryOpen, setIsClearHistoryOpen] = useState(false);

    const [printerState, setPrinterState] = useState<PrinterState>(() =>
        typeof navigator !== 'undefined' &&
        ('serial' in navigator || 'usb' in navigator)
            ? 'disconnected'
            : 'unsupported',
    );

    const hasImage = sourceImage !== null;

    // Load history photos from IndexedDB on mount
    useEffect(() => {
        let mounted = true;
        void getAllHistoryPhotos().then((photos) => {
            if (mounted) {
                setHistoryPhotos(photos);
            }
        });
        return () => {
            mounted = false;
        };
    }, []);

    // Save configuration automatically to localStorage on change
    useEffect(() => {
        saveStoredConfig({
            brightness,
            contrast,
            threshold,
            mode,
            isPixelZoom,
            countdown: countdownSetting,
            mirrorCamera,
        });
    }, [
        brightness,
        contrast,
        threshold,
        mode,
        isPixelZoom,
        countdownSetting,
        mirrorCamera,
    ]);

    useEffect(() => {
        return () => {
            if (sourceUrl) {
                URL.revokeObjectURL(sourceUrl);
            }
        };
    }, [sourceUrl]);

    useEffect(() => {
        const image = new Image();
        image.onload = () => setHeaderLogo(image);
        image.src = '/gdg.png';
    }, []);

    useEffect(() => {
        if (!isCameraOpen) {
            setActiveCountdown(null);
            return;
        }

        let cancelled = false;

        const startCamera = async () => {
            if (!navigator.mediaDevices?.getUserMedia) {
                setError(
                    'Live camera access requires Chrome, Edge, or Safari on HTTPS or localhost.',
                );
                return;
            }

            setIsCameraStarting(true);
            setError(null);

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: 'user',
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                    },
                });

                if (cancelled) {
                    stream.getTracks().forEach((track) => track.stop());
                    return;
                }

                cameraStreamRef.current = stream;
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    await videoRef.current.play();
                }
            } catch (cameraError) {
                if (
                    cameraError instanceof DOMException &&
                    cameraError.name === 'NotAllowedError'
                ) {
                    setError(
                        'Camera permission was denied. Allow camera access in your browser settings and try again.',
                    );
                } else if (
                    cameraError instanceof DOMException &&
                    cameraError.name === 'NotFoundError'
                ) {
                    setError('No camera was found on this device.');
                } else {
                    setError(
                        'The camera could not be started. Check that it is not in use.',
                    );
                }
            } finally {
                if (!cancelled) {
                    setIsCameraStarting(false);
                }
            }
        };

        void startCamera();

        return () => {
            cancelled = true;
            cameraStreamRef.current
                ?.getTracks()
                .forEach((track) => track.stop());
            cameraStreamRef.current = null;
        };
    }, [isCameraOpen]);

    // Canvas render effect
    useEffect(() => {
        const canvas = canvasRef.current;

        if (!canvas || !sourceImage) {
            processedPixelsRef.current = null;
            return;
        }

        const photoWidth = PRINTER_WIDTH - PRINT_LAYOUT.horizontalPadding * 2;
        const scale = Math.min(1, photoWidth / sourceImage.naturalWidth);
        const drawWidth = Math.max(
            1,
            Math.round(sourceImage.naturalWidth * scale),
        );
        const drawHeight = Math.max(
            1,
            Math.round(sourceImage.naturalHeight * scale),
        );
        const drawX = Math.floor((PRINTER_WIDTH - drawWidth) / 2);
        const imageTop =
            PRINT_LAYOUT.topPadding +
            PRINT_LAYOUT.headerHeight +
            PRINT_LAYOUT.headerGap;
        const { height: layoutHeight } = getPrintLayoutDimensions(drawHeight);
        const workingCanvas = document.createElement('canvas');
        const workingContext = workingCanvas.getContext('2d', {
            willReadFrequently: true,
        });
        const context = canvas.getContext('2d');

        if (!workingContext || !context) {
            setError('This browser cannot create the image-processing canvas.');
            return;
        }

        workingCanvas.width = PRINTER_WIDTH;
        workingCanvas.height = layoutHeight;
        workingContext.fillStyle = '#ffffff';
        workingContext.fillRect(0, 0, PRINTER_WIDTH, layoutHeight);

        const logoHeight = 48;
        const logoWidth = headerLogo
            ? Math.round(
                  (headerLogo.naturalWidth / headerLogo.naturalHeight) *
                      logoHeight,
              )
            : 0;
        const headerTextX = headerLogo
            ? PRINT_LAYOUT.horizontalPadding + logoWidth + 10
            : PRINT_LAYOUT.horizontalPadding;

        if (headerLogo) {
            workingContext.drawImage(
                headerLogo,
                PRINT_LAYOUT.horizontalPadding,
                PRINT_LAYOUT.topPadding +
                    Math.floor((PRINT_LAYOUT.headerHeight - logoHeight) / 2),
                logoWidth,
                logoHeight,
            );
        }

        workingContext.fillStyle = '#111827';
        workingContext.textAlign = 'left';
        workingContext.textBaseline = 'alphabetic';
        workingContext.font = '700 16px Arial, sans-serif';
        workingContext.fillText(
            'Google Developer Groups',
            headerTextX,
            PRINT_LAYOUT.topPadding + 32,
        );
        workingContext.fillStyle = '#4b5563';
        workingContext.font = '12px Arial, sans-serif';
        workingContext.fillText(
            'On Campus • STT Terpadu Nurul Fikri',
            headerTextX,
            PRINT_LAYOUT.topPadding + 53,
        );

        workingContext.drawImage(
            sourceImage,
            drawX,
            imageTop,
            drawWidth,
            drawHeight,
        );

        const footerTop = imageTop + drawHeight + PRINT_LAYOUT.footerGap;
        workingContext.save();
        workingContext.strokeStyle = '#9ca3af';
        workingContext.lineWidth = 1;
        workingContext.setLineDash([5, 4]);
        workingContext.beginPath();
        workingContext.moveTo(PRINT_LAYOUT.horizontalPadding, footerTop);
        workingContext.lineTo(
            PRINTER_WIDTH - PRINT_LAYOUT.horizontalPadding,
            footerTop,
        );
        workingContext.stroke();
        workingContext.restore();

        workingContext.fillStyle = '#111827';
        workingContext.textAlign = 'center';
        workingContext.font = '700 11px Arial, sans-serif';
        workingContext.fillText(
            'instagram: @gdgoc.nf',
            PRINTER_WIDTH / 2,
            footerTop + 17,
        );

        const source = workingContext.getImageData(
            0,
            0,
            PRINTER_WIDTH,
            layoutHeight,
        );
        const pixels = processPixels(
            source.data,
            PRINTER_WIDTH,
            layoutHeight,
            {
                brightness: 0,
                contrast: 0,
                threshold: 128,
                mode: 'threshold',
            },
        );
        const photo = workingContext.getImageData(
            drawX,
            imageTop,
            drawWidth,
            drawHeight,
        );
        const processedPhoto = processPixels(
            photo.data,
            drawWidth,
            drawHeight,
            { brightness, contrast, threshold, mode },
        );

        for (let y = 0; y < drawHeight; y++) {
            for (let x = 0; x < drawWidth; x++) {
                pixels[(imageTop + y) * PRINTER_WIDTH + drawX + x] =
                    processedPhoto[y * drawWidth + x];
            }
        }

        const output = context.createImageData(PRINTER_WIDTH, layoutHeight);

        for (let pixel = 0; pixel < pixels.length; pixel++) {
            const offset = pixel * 4;
            output.data[offset] = pixels[pixel];
            output.data[offset + 1] = pixels[pixel];
            output.data[offset + 2] = pixels[pixel];
            output.data[offset + 3] = 255;
        }

        canvas.width = PRINTER_WIDTH;
        canvas.height = layoutHeight;
        context.putImageData(output, 0, 0);
        processedPixelsRef.current = pixels;
        setError(null);
    }, [brightness, contrast, headerLogo, mode, sourceImage, threshold]);

    // Load an image file into state and save to history
    const loadFile = useCallback(
        (file?: File, shouldAddToHistory = true) => {
            if (!file) {
                return;
            }

            if (file.type && !file.type.startsWith('image/')) {
                setError('Choose an image file your browser can decode.');
                toast.error('Please choose a valid image file (JPEG, PNG, WebP).');
                return;
            }

            const nextUrl = URL.createObjectURL(file);
            const image = new Image();

            image.onload = () => {
                setSourceImage(image);
                setSourceUrl(nextUrl);
                const resolvedName = file.name || 'Imported photo';
                setFileName(resolvedName);
                setError(null);

                if (shouldAddToHistory) {
                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        const dataUrl = e.target?.result as string;
                        if (dataUrl) {
                            const thumbnail = createThumbnailDataUrl(
                                image,
                                image.naturalWidth,
                                image.naturalHeight,
                                200,
                            );
                            const saved = await savePhotoToHistory({
                                name: resolvedName,
                                source: 'upload',
                                dataUrl,
                                thumbnailUrl: thumbnail || dataUrl,
                                settings: {
                                    brightness,
                                    contrast,
                                    threshold,
                                    mode,
                                },
                            });
                            setActivePhotoId(saved.id);
                            setHistoryPhotos((prev) => [
                                saved,
                                ...prev.filter((p) => p.id !== saved.id),
                            ]);
                        }
                    };
                    reader.readAsDataURL(file);
                }
            };

            image.onerror = () => {
                URL.revokeObjectURL(nextUrl);
                setError(
                    'This image format could not be decoded. Try JPEG, PNG, or WebP.',
                );
                toast.error('This image could not be decoded.');
            };

            image.src = nextUrl;
        },
        [brightness, contrast, mode, threshold],
    );

    const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
        loadFile(event.target.files?.[0]);
        event.target.value = '';
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDragging(false);
        loadFile(event.dataTransfer.files[0]);
    };

    // Load a photo from history into active preview
    const loadHistoryPhoto = useCallback((photo: HistoryPhoto) => {
        const image = new Image();
        image.onload = () => {
            setSourceImage(image);
            setFileName(photo.name);
            setActivePhotoId(photo.id);
            setError(null);
            toast.success(`Loaded "${photo.name}" into preview.`);
        };
        image.onerror = () => {
            toast.error('Failed to load this photo.');
        };
        image.src = photo.dataUrl;
    }, []);

    // Delete single photo from history
    const handleDeletePhoto = useCallback(
        async (photoId: string, event?: React.MouseEvent) => {
            event?.stopPropagation();
            await deletePhotoFromHistory(photoId);
            setHistoryPhotos((prev) => prev.filter((p) => p.id !== photoId));
            if (activePhotoId === photoId) {
                setActivePhotoId(null);
            }
            toast.info('Photo removed from history.');
        },
        [activePhotoId],
    );

    // Clear all photos from history
    const handleClearAllHistory = useCallback(async () => {
        await clearAllHistoryPhotos();
        setHistoryPhotos([]);
        setIsClearHistoryOpen(false);
        toast.info('Photo history cleared.');
    }, []);

    // Perform the camera frame capture
    const performCapture = useCallback(() => {
        const video = videoRef.current;

        if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            setError('Wait for the camera preview before taking a photo.');
            toast.error('Wait for camera preview to initialize.');
            isCapturingRef.current = false;
            return;
        }

        const captureCanvas = document.createElement('canvas');
        const context = captureCanvas.getContext('2d');

        if (!context) {
            setError('This browser cannot capture the camera image.');
            isCapturingRef.current = false;
            return;
        }

        captureCanvas.width = video.videoWidth;
        captureCanvas.height = video.videoHeight;

        if (mirrorCamera) {
            context.translate(captureCanvas.width, 0);
            context.scale(-1, 1);
        }

        context.drawImage(video, 0, 0);

        playShutterSound();
        setIsFlashActive(true);
        setTimeout(() => setIsFlashActive(false), 200);

        const dataUrl = captureCanvas.toDataURL('image/png', 0.95);
        const thumbnail = createThumbnailDataUrl(
            captureCanvas,
            captureCanvas.width,
            captureCanvas.height,
            240,
        );

        const photoName = `Camera photo ${new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        })}`;

        const image = new Image();
        image.onload = async () => {
            setSourceImage(image);
            setFileName(photoName);

            const saved = await savePhotoToHistory({
                name: photoName,
                source: 'camera',
                dataUrl,
                thumbnailUrl: thumbnail || dataUrl,
                settings: { brightness, contrast, threshold, mode },
            });

            setActivePhotoId(saved.id);
            setHistoryPhotos((prev) => [
                saved,
                ...prev.filter((p) => p.id !== saved.id),
            ]);

            setIsCameraOpen(false);
            setActiveCountdown(null);
            isCapturingRef.current = false;
            toast.success('Photo captured and saved to history!');
        };
        image.src = dataUrl;
    }, [brightness, contrast, mirrorCamera, mode, threshold]);

    // Handle capture button with optional countdown timer
    const triggerCaptureWithCountdown = useCallback(() => {
        if (isCapturingRef.current) {
            return;
        }

        if (countdownSetting <= 0) {
            isCapturingRef.current = true;
            performCapture();
            return;
        }

        isCapturingRef.current = true;
        let count = countdownSetting;
        setActiveCountdown(count);
        playAudioBeep(880, 0.09);

        const timer = setInterval(() => {
            count -= 1;
            if (count > 0) {
                setActiveCountdown(count);
                playAudioBeep(880, 0.09);
            } else {
                clearInterval(timer);
                setActiveCountdown(null);
                playAudioBeep(1760, 0.16);
                performCapture();
            }
        }, 1000);
    }, [countdownSetting, performCapture]);

    // Reset controls to factory defaults
    const resetControls = () => {
        setBrightness(DEFAULT_CONFIG.brightness);
        setContrast(DEFAULT_CONFIG.contrast);
        setThreshold(DEFAULT_CONFIG.threshold);
        setMode(DEFAULT_CONFIG.mode);
        setIsPixelZoom(DEFAULT_CONFIG.isPixelZoom);
        setCountdownSetting(DEFAULT_CONFIG.countdown);
        setMirrorCamera(DEFAULT_CONFIG.mirrorCamera);
        clearStoredConfig();
        toast.info('Controls reset to default values.');
    };

    // Save/Download the preview receipt image to user's device
    const downloadReceipt = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !hasImage) {
            setError('No photo loaded to save.');
            toast.error('No photo loaded to save.');
            return;
        }

        canvas.toBlob((blob) => {
            if (!blob) {
                setError('The processed image could not be downloaded.');
                toast.error('Could not generate receipt image.');
                return;
            }

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const now = new Date();
            const pad = (n: number) => n.toString().padStart(2, '0');
            const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

            link.href = url;
            link.download = `thermal-receipt-${timestamp}.png`;
            link.click();
            URL.revokeObjectURL(url);
            toast.success('Thermal receipt saved to your device!');
        }, 'image/png');
    }, [hasImage]);

    // Copy the preview receipt image directly to clipboard
    const copyReceiptToClipboard = useCallback(async () => {
        const canvas = canvasRef.current;
        if (!canvas || !hasImage) {
            toast.error('No photo preview to copy.');
            return;
        }

        try {
            canvas.toBlob(async (blob) => {
                if (!blob) {
                    toast.error('Failed to create image blob.');
                    return;
                }

                if (!navigator.clipboard?.write) {
                    toast.error(
                        'Clipboard image write is not supported in this browser.',
                    );
                    return;
                }

                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob }),
                ]);

                setIsCopied(true);
                setTimeout(() => setIsCopied(false), 2200);
                toast.success('Receipt image copied to clipboard! Ready to paste (Ctrl+V / Cmd+V).');
            }, 'image/png');
        } catch (err) {
            console.error('Clipboard copy error:', err);
            toast.error('Could not copy image to clipboard.');
        }
    }, [hasImage]);

    // Download raw source photo
    const downloadRawPhoto = useCallback((dataUrl: string, name: string) => {
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = name.endsWith('.png') ? name : `${name}.png`;
        link.click();
        toast.success('Original photo saved to device!');
    }, []);

    // Bluetooth printer logic
    const runPrinterCommand = async (
        send: PrinterCommand,
        busyState: 'printing' | 'testing',
    ) => {
        const serial = (navigator as Navigator & { serial?: SerialApi }).serial;

        if (!serial) {
            setPrinterState('unsupported');
            setError(
                'USB/Bluetooth printing requires Chrome or Edge desktop on HTTPS or localhost.',
            );
            return;
        }

        let port: SerialPortLike | undefined;
        let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
        let completed = false;

        try {
            setError(null);
            setPrinterState('connecting');

            const authorizedPorts = bluetoothPortRef.current
                ? []
                : await serial.getPorts();
            const onlyAuthorizedPort =
                authorizedPorts.length === 1 ? authorizedPorts[0] : undefined;
            const onlyAuthorizedPortInfo =
                onlyAuthorizedPort?.getInfo?.() ?? {};
            const unidentifiedBluetoothPort =
                onlyAuthorizedPort &&
                onlyAuthorizedPortInfo.bluetoothServiceClassId === undefined &&
                onlyAuthorizedPortInfo.usbProductId === undefined &&
                onlyAuthorizedPortInfo.usbVendorId === undefined
                    ? onlyAuthorizedPort
                    : undefined;
            const bluetoothPort =
                bluetoothPortRef.current ??
                authorizedPorts.find((candidate) =>
                    isRpp02nBluetoothPort(candidate.getInfo?.() ?? {}),
                ) ??
                unidentifiedBluetoothPort;
            port =
                bluetoothPort ??
                (await serial.requestPort({
                    allowedBluetoothServiceClassIds: [
                        RPP02N_BLUETOOTH_SERVICE_CLASS_ID,
                    ],
                }));

            await port.open({
                baudRate: RPP02N_BAUD_RATE,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none',
            });
            bluetoothPortRef.current = port;
            setPrinterState('connected');

            const serialWriter = port.writable?.getWriter() ?? null;
            if (!serialWriter) {
                throw new Error('The selected port is not writable.');
            }
            writer = serialWriter;

            setPrinterState(busyState);
            await send((data) => serialWriter.write(data));
            await serialWriter.ready;
            completed = true;
        } catch (printerError) {
            if (port === bluetoothPortRef.current) {
                bluetoothPortRef.current = null;
            }

            if (
                printerError instanceof DOMException &&
                printerError.name === 'NotFoundError'
            ) {
                setPrinterState('disconnected');
                setError(
                    `No printer selected. Connect USB or pair ${RPP02N_BLUETOOTH_NAME} first.`,
                );
            } else {
                setPrinterState('error');
                setError(
                    printerError instanceof Error
                        ? printerError.message
                        : 'The printer connection failed.',
                );
            }
        } finally {
            writer?.releaseLock();

            if (port?.readable || port?.writable) {
                await port.close().catch(() => undefined);
            }

            if (completed) {
                setPrinterState('ready');
            }
        }
    };

    // USB printer logic
    const runUsbPrinterCommand = async (
        send: PrinterCommand,
        busyState: 'printing' | 'testing',
    ) => {
        const usb = (navigator as Navigator & { usb?: UsbApi }).usb;

        if (!usb) {
            setPrinterState('unsupported');
            setError(
                'USB printing requires Chrome or Edge desktop on HTTPS or localhost.',
            );
            return;
        }

        let device: UsbDeviceLike | undefined;
        let claimedInterfaceNumber: number | undefined;
        let completed = false;

        try {
            setError(null);
            setPrinterState('connecting');

            const authorizedDevices = await usb.getDevices();
            const selectedDevice =
                authorizedDevices.find(
                    ({ productId, vendorId }) =>
                        vendorId === RPP02N_USB_VENDOR_ID &&
                        productId === RPP02N_USB_PRODUCT_ID,
                ) ??
                (await usb.requestDevice({
                    filters: [
                        {
                            productId: RPP02N_USB_PRODUCT_ID,
                            vendorId: RPP02N_USB_VENDOR_ID,
                        },
                    ],
                }));

            device = selectedDevice;
            await selectedDevice.open();

            let configuration = selectedDevice.configuration;
            if (!configuration) {
                const firstConfiguration = selectedDevice.configurations[0];
                if (!firstConfiguration) {
                    throw new Error('The USB printer has no configuration.');
                }

                await selectedDevice.selectConfiguration(
                    firstConfiguration.configurationValue,
                );
                configuration = selectedDevice.configuration;
            }

            if (!configuration) {
                throw new Error(
                    'The USB printer configuration could not be opened.',
                );
            }

            const endpoint = findUsbOutputEndpoint(configuration);
            await selectedDevice.claimInterface(endpoint.interfaceNumber);
            claimedInterfaceNumber = endpoint.interfaceNumber;

            if (endpoint.alternateSetting !== 0) {
                await selectedDevice.selectAlternateInterface(
                    endpoint.interfaceNumber,
                    endpoint.alternateSetting,
                );
            }

            setPrinterState('connected');
            setPrinterState(busyState);
            await send(async (data) => {
                for (let offset = 0; offset < data.length; offset += 4096) {
                    const result = await selectedDevice.transferOut(
                        endpoint.endpointNumber,
                        data.subarray(offset, offset + 4096),
                    );

                    if (result.status !== 'ok') {
                        throw new Error(
                            `USB transfer failed with status: ${result.status}.`,
                        );
                    }
                }
            });
            completed = true;
        } catch (printerError) {
            if (
                printerError instanceof DOMException &&
                printerError.name === 'NotFoundError'
            ) {
                setPrinterState('disconnected');
                setError(
                    'No USB printer selected. Choose Virtual PRN in the picker.',
                );
            } else if (
                printerError instanceof DOMException &&
                ['NetworkError', 'SecurityError'].includes(printerError.name)
            ) {
                setPrinterState('error');
                setError(
                    'USB printer detected, but its interface is owned by the system driver. Close other printer software or use Bluetooth.',
                );
            } else {
                setPrinterState('error');
                setError(
                    printerError instanceof Error
                        ? `USB printer connection failed: ${printerError.message}`
                        : 'USB printer connection failed.',
                );
            }
        } finally {
            if (device && claimedInterfaceNumber !== undefined) {
                await device
                    .releaseInterface(claimedInterfaceNumber)
                    .catch(() => undefined);
            }

            if (device?.opened) {
                await device.close().catch(() => undefined);
            }

            if (completed) {
                setPrinterState('ready');
            }
        }
    };

    const getPhotoPrintCommand = (): PrinterCommand | null => {
        const canvas = canvasRef.current;
        const pixels = processedPixelsRef.current;

        if (!canvas || !pixels) {
            setError('Load a photo before printing.');
            toast.error('Load a photo before printing.');
            return null;
        }

        return (write) => sendEscPosPrintJob(write, pixels, canvas.height);
    };

    const printPhoto = async (
        run: (
            send: PrinterCommand,
            busyState: 'printing' | 'testing',
        ) => Promise<void>,
    ): Promise<void> => {
        const command = getPhotoPrintCommand();

        if (command) {
            await run(command, 'printing');
        }
    };

    const directUsbPrint = async () => {
        await printPhoto(runUsbPrinterCommand);
    };

    const directBluetoothPrint = async () => {
        await printPhoto(runPrinterCommand);
    };

    const testUsbConnection = async () => {
        await runUsbPrinterCommand(
            (write) => write(new Uint8Array(RPP02N_TEST_FEED_COMMAND)),
            'testing',
        );
    };

    const testBluetoothConnection = async () => {
        await runPrinterCommand(
            (write) => write(new Uint8Array(RPP02N_TEST_FEED_COMMAND)),
            'testing',
        );
    };

    const isPrinterBusy =
        printerState === 'connecting' ||
        printerState === 'printing' ||
        printerState === 'testing';

    return (
        <>
            <Head title="Thermal Photobooth" />
            <main className="thermal-studio min-h-screen text-stone-950">
                <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col px-4 py-5 sm:px-7 lg:px-10 lg:py-8">
                    <header className="flex items-end justify-between gap-6 border-b-2 border-stone-950 pb-4">
                        <div>
                            <p className="font-mono text-[10px] font-bold tracking-[0.28em] text-[#b42b1e] uppercase">
                                MP-58S-8111 · ESC/POS
                            </p>
                            <h1 className="font-serif text-3xl leading-none font-black tracking-tight sm:text-5xl">
                                Thermal Photobooth
                            </h1>
                        </div>
                        <div className="hidden text-right font-mono text-[10px] leading-5 font-semibold tracking-wider uppercase sm:block">
                            <p>58mm paper</p>
                            <p>384 dots · 203 dpi</p>
                        </div>
                    </header>

                    {/* Main 3-Column Studio Grid */}
                    <div className="grid gap-7 py-7 lg:grid-cols-[minmax(280px,0.85fr)_minmax(420px,1.3fr)_minmax(300px,0.9fr)] lg:gap-8">
                        {/* 01 / Source */}
                        <section className="flex flex-col gap-6">
                            <div>
                                <p className="thermal-kicker">01 / Source</p>
                                <h2 className="thermal-heading">
                                    Load a photograph
                                </h2>
                            </div>

                            <div
                                onDragEnter={(event) => {
                                    event.preventDefault();
                                    setIsDragging(true);
                                }}
                                onDragOver={(event) => event.preventDefault()}
                                onDragLeave={() => setIsDragging(false)}
                                onDrop={handleDrop}
                                className={`grid min-h-64 place-items-center border-2 border-dashed p-6 text-center transition-colors ${isDragging ? 'border-[#b42b1e] bg-[#b42b1e]/10' : 'border-stone-500 bg-[#f7f1e3]/60'}`}
                            >
                                <div className="grid justify-items-center gap-4">
                                    <div className="grid size-16 place-items-center rounded-full border-2 border-stone-950 bg-white shadow-[4px_4px_0_#1c1917]">
                                        <FileImage
                                            size={28}
                                            strokeWidth={1.7}
                                        />
                                    </div>
                                    <div>
                                        <p className="font-serif text-xl font-bold">
                                            Drop a photo here
                                        </p>
                                        <p className="mt-1 font-mono text-[10px] tracking-wider text-stone-600 uppercase">
                                            Browser-supported images · one at a
                                            time
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap justify-center gap-3">
                                        <ActionButton
                                            onClick={() =>
                                                fileInputRef.current?.click()
                                            }
                                        >
                                            <FileImage size={15} /> Select File
                                        </ActionButton>
                                        <ActionButton
                                            onClick={() =>
                                                setIsCameraOpen(true)
                                            }
                                            tone="red"
                                        >
                                            <Camera size={15} /> Live Camera
                                        </ActionButton>
                                    </div>
                                </div>
                            </div>

                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                onChange={handleInput}
                                className="sr-only"
                            />
                            <div className="border-y border-stone-400 py-3 font-mono text-[10px] tracking-wider uppercase">
                                <p className="flex items-center justify-between gap-4">
                                    <span className="text-stone-500">
                                        Current file
                                    </span>
                                    <span className="truncate font-bold text-stone-950">
                                        {fileName ?? 'None loaded'}
                                    </span>
                                </p>
                            </div>
                        </section>

                        {/* 02 / Preview */}
                        <section className="min-w-0">
                            <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
                                <div>
                                    <p className="thermal-kicker">
                                        02 / Preview
                                    </p>
                                    <h2 className="thermal-heading">
                                        Print simulation
                                    </h2>
                                </div>
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        disabled={!hasImage}
                                        onClick={() =>
                                            setIsPixelZoom((value) => !value)
                                        }
                                        className="inline-flex items-center gap-1.5 border-b border-stone-950 pb-1 font-mono text-[10px] font-bold tracking-wider uppercase disabled:opacity-30"
                                    >
                                        <Focus size={14} />{' '}
                                        {isPixelZoom
                                            ? 'Fit receipt'
                                            : 'Pixel zoom'}
                                    </button>
                                </div>
                            </div>

                            <div className="receipt-desk relative min-h-[520px] overflow-auto border-2 border-stone-950 p-5 sm:p-8">
                                {/* Quick floating toolbar on top of receipt */}
                                {hasImage && (
                                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-stone-400/80 bg-[#f7f1e3]/90 px-3 py-2 text-stone-900 shadow-[2px_2px_0_#1c1917] backdrop-blur-sm">
                                        <div className="flex items-center gap-2 font-mono text-[10px] font-bold tracking-wider uppercase">
                                            <span className="inline-block size-2 rounded-full bg-emerald-600" />
                                            <span>384 × 203 DPI Ready</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={copyReceiptToClipboard}
                                                className="inline-flex items-center gap-1 border border-stone-950 bg-white px-2 py-1 font-mono text-[10px] font-bold uppercase hover:bg-stone-100"
                                                title="Copy receipt image to clipboard"
                                            >
                                                {isCopied ? (
                                                    <>
                                                        <Check
                                                            size={13}
                                                            className="text-emerald-600"
                                                        />
                                                        <span className="text-emerald-700">
                                                            Copied!
                                                        </span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <Copy size={13} />
                                                        <span>Copy</span>
                                                    </>
                                                )}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={downloadReceipt}
                                                className="inline-flex items-center gap-1 border border-stone-950 bg-white px-2 py-1 font-mono text-[10px] font-bold uppercase hover:bg-stone-100"
                                                title="Save receipt image to device"
                                            >
                                                <Download size={13} />
                                                <span>Save</span>
                                            </button>
                                        </div>
                                    </div>
                                )}

                                <div className="print-receipt mx-auto min-h-[470px] w-[min(100%,290px)] bg-white px-[5mm] pt-8 pb-12 shadow-[0_16px_35px_rgba(28,25,23,0.25)]">
                                    {!hasImage && (
                                        <div className="receipt-placeholder grid min-h-80 place-items-center border border-dashed border-stone-300 text-center">
                                            <div className="grid justify-items-center gap-3 text-stone-400">
                                                <Printer
                                                    size={36}
                                                    strokeWidth={1.25}
                                                />
                                                <p className="font-mono text-[9px] tracking-[0.18em] uppercase">
                                                    Your thermal preview
                                                    <br />
                                                    appears here
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                    <div className="receipt-image">
                                        <canvas
                                            ref={canvasRef}
                                            aria-label="Processed thermal print preview"
                                            className={`${hasImage ? 'block' : 'hidden'} thermal-canvas ${isPixelZoom ? 'w-[768px] max-w-none' : 'h-auto w-full'}`}
                                        />
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* 03 / Tune */}
                        <section className="flex min-w-0 flex-col gap-6">
                            <div className="flex items-end justify-between gap-2">
                                <div>
                                    <p className="thermal-kicker">03 / Tune</p>
                                    <h2 className="thermal-heading">
                                        Shape the dots
                                    </h2>
                                </div>
                                <span className="inline-flex items-center gap-1.5 border border-stone-400/60 bg-white/70 px-2 py-1 font-mono text-[9px] font-bold tracking-wider text-stone-600 uppercase">
                                    <span className="size-1.5 rounded-full bg-emerald-600 animate-pulse" />
                                    Auto-saved
                                </span>
                            </div>

                            <div className="grid gap-5 border-2 border-stone-950 bg-[#f7f1e3] p-5 shadow-[5px_5px_0_#1c1917]">
                                <Control
                                    label="Brightness"
                                    value={brightness}
                                    min={-100}
                                    max={100}
                                    onChange={setBrightness}
                                />
                                <Control
                                    label="Contrast"
                                    value={contrast}
                                    min={-100}
                                    max={100}
                                    onChange={setContrast}
                                />
                                <Control
                                    label="Threshold"
                                    value={threshold}
                                    min={0}
                                    max={255}
                                    onChange={setThreshold}
                                />
                                <fieldset className="grid gap-2">
                                    <legend className="font-mono text-xs font-semibold tracking-[0.12em] uppercase">
                                        Dot pattern
                                    </legend>
                                    <div className="grid grid-cols-2 border-2 border-stone-950 bg-white p-1">
                                        {(
                                            [
                                                'dither',
                                                'threshold',
                                            ] as ProcessingMode[]
                                        ).map((option) => (
                                            <button
                                                key={option}
                                                type="button"
                                                onClick={() => setMode(option)}
                                                className={`px-2 py-2 font-mono text-[10px] font-bold tracking-wider uppercase transition-colors ${mode === option ? 'bg-stone-950 text-white' : 'hover:bg-stone-100'}`}
                                            >
                                                {option}
                                            </button>
                                        ))}
                                    </div>
                                </fieldset>

                                <button
                                    type="button"
                                    onClick={resetControls}
                                    className="inline-flex items-center justify-center gap-2 border-t border-stone-400 pt-3 font-mono text-[10px] font-bold tracking-wider text-stone-700 uppercase hover:text-[#b42b1e] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#b42b1e]"
                                >
                                    <RotateCcw size={13} /> Reset to defaults
                                </button>
                            </div>

                            {/* Export & Print Action Grid */}
                            <div className="grid gap-3">
                                {/* Copy & Save to Device (Top Actions) */}
                                <div className="grid grid-cols-2 gap-3">
                                    <ActionButton
                                        disabled={!hasImage}
                                        onClick={copyReceiptToClipboard}
                                        tone="ink"
                                    >
                                        {isCopied ? (
                                            <>
                                                <Check
                                                    size={15}
                                                    className="text-emerald-400"
                                                />{' '}
                                                Copied!
                                            </>
                                        ) : (
                                            <>
                                                <Copy size={15} /> Copy Image
                                            </>
                                        )}
                                    </ActionButton>
                                    <ActionButton
                                        disabled={!hasImage}
                                        onClick={downloadReceipt}
                                        tone="ink"
                                    >
                                        <Download size={15} /> Save Device
                                    </ActionButton>
                                </div>

                                {/* Direct Hardware Printing */}
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <ActionButton
                                        disabled={!hasImage || isPrinterBusy}
                                        onClick={directUsbPrint}
                                        tone="red"
                                    >
                                        <Usb size={16} />{' '}
                                        {printerState === 'printing'
                                            ? 'Printing…'
                                            : 'Print USB'}
                                    </ActionButton>
                                    <ActionButton
                                        disabled={!hasImage || isPrinterBusy}
                                        onClick={directBluetoothPrint}
                                        tone="red"
                                    >
                                        <Bluetooth size={16} />{' '}
                                        {printerState === 'printing'
                                            ? 'Printing…'
                                            : 'Print BT'}
                                    </ActionButton>
                                </div>

                                {/* Printer Diagnostics */}
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <ActionButton
                                        disabled={isPrinterBusy}
                                        onClick={testUsbConnection}
                                        tone="subtle"
                                    >
                                        <Usb size={14} />{' '}
                                        {printerState === 'testing'
                                            ? 'Testing…'
                                            : 'Feed USB'}
                                    </ActionButton>
                                    <ActionButton
                                        disabled={isPrinterBusy}
                                        onClick={testBluetoothConnection}
                                        tone="subtle"
                                    >
                                        <Bluetooth size={14} />{' '}
                                        {printerState === 'testing'
                                            ? 'Testing…'
                                            : 'Feed BT'}
                                    </ActionButton>
                                </div>

                                <div className="grid grid-cols-1">
                                    <ActionButton
                                        disabled={!hasImage}
                                        onClick={() => window.print()}
                                        tone="subtle"
                                    >
                                        <Printer size={15} /> System Print
                                        Dialog
                                    </ActionButton>
                                </div>
                            </div>

                            <div
                                role="status"
                                className="flex gap-3 border-l-2 border-[#b42b1e] pl-3 font-mono text-[10px] leading-5 tracking-wide text-stone-600"
                            >
                                {printerState === 'unsupported' ||
                                printerState === 'error' ? (
                                    <Unplug
                                        className="mt-0.5 shrink-0"
                                        size={15}
                                    />
                                ) : (
                                    <SlidersHorizontal
                                        className="mt-0.5 shrink-0"
                                        size={15}
                                    />
                                )}
                                <span>{stateCopy[printerState]}</span>
                            </div>
                            {error && (
                                <p
                                    role="alert"
                                    className="border-2 border-[#b42b1e] bg-red-50 p-3 font-mono text-[10px] leading-5 font-bold text-[#8f2017]"
                                >
                                    {error}
                                </p>
                            )}
                        </section>
                    </div>

                    {/* 04 / History Photo Roll */}
                    <section className="mt-8 border-t-2 border-stone-950 pt-8 pb-12">
                        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
                            <div>
                                <p className="thermal-kicker">04 / Roll</p>
                                <div className="flex items-center gap-3">
                                    <h2 className="thermal-heading">
                                        Photo History
                                    </h2>
                                    <span className="border border-stone-950 bg-stone-950 px-2 py-0.5 font-mono text-[11px] font-bold text-white">
                                        {historyPhotos.length}{' '}
                                        {historyPhotos.length === 1
                                            ? 'shot'
                                            : 'shots'}
                                    </span>
                                </div>
                                <p className="mt-1 font-mono text-[10px] tracking-wide text-stone-600 uppercase">
                                    Persisted in session roll · Click any photo
                                    to load onto receipt preview
                                </p>
                            </div>

                            {historyPhotos.length > 0 && (
                                <div className="flex items-center gap-3">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setIsClearHistoryOpen(true)
                                        }
                                        className="inline-flex items-center gap-1.5 border border-stone-400 bg-white/80 px-3 py-1.5 font-mono text-[10px] font-bold tracking-wider text-stone-700 uppercase shadow-[2px_2px_0_#1c1917] transition-all hover:bg-red-50 hover:text-red-700"
                                    >
                                        <Trash2 size={13} />
                                        <span>Clear History</span>
                                    </button>
                                </div>
                            )}
                        </div>

                        {historyPhotos.length === 0 ? (
                            <div className="grid min-h-48 place-items-center border-2 border-dashed border-stone-400 bg-[#f7f1e3]/40 p-8 text-center">
                                <div className="grid justify-items-center gap-3 text-stone-500">
                                    <div className="grid size-12 place-items-center rounded-full border border-stone-400 bg-white shadow-[3px_3px_0_#1c1917]">
                                        <Clock size={22} strokeWidth={1.5} />
                                    </div>
                                    <p className="font-serif text-lg font-bold text-stone-800">
                                        No photos taken in this session yet
                                    </p>
                                    <p className="max-w-md font-mono text-[10px] leading-4 tracking-wider uppercase">
                                        Take a snapshot with the camera or
                                        upload an image to automatically add
                                        shots to your historical roll.
                                    </p>
                                    <ActionButton
                                        onClick={() => setIsCameraOpen(true)}
                                        tone="red"
                                        className="mt-2"
                                    >
                                        <Camera size={15} /> Take First Photo
                                    </ActionButton>
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                                {historyPhotos.map((photo, index) => {
                                    const isActive =
                                        activePhotoId === photo.id ||
                                        fileName === photo.name;
                                    const formattedTime = new Date(
                                        photo.timestamp,
                                    ).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                    });

                                    return (
                                        <div
                                            key={photo.id}
                                            onClick={() =>
                                                loadHistoryPhoto(photo)
                                            }
                                            className={`group relative flex cursor-pointer flex-col border-2 bg-white p-2.5 transition-all hover:-translate-y-1 hover:shadow-[5px_5px_0_#1c1917] ${
                                                isActive
                                                    ? 'border-[#b42b1e] ring-2 ring-[#b42b1e] shadow-[4px_4px_0_#b42b1e]'
                                                    : 'border-stone-950 shadow-[3px_3px_0_#1c1917]'
                                            }`}
                                        >
                                            {/* Photo Thumbnail */}
                                            <div className="relative aspect-square w-full overflow-hidden border border-stone-300 bg-stone-900">
                                                <img
                                                    src={
                                                        photo.thumbnailUrl ||
                                                        photo.dataUrl
                                                    }
                                                    alt={photo.name}
                                                    className="h-full w-full object-cover"
                                                />
                                                {isActive && (
                                                    <span className="absolute top-1 left-1 bg-[#b42b1e] px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider text-white uppercase">
                                                        Active
                                                    </span>
                                                )}
                                                <span className="absolute right-1 bottom-1 bg-stone-950/80 px-1 py-0.5 font-mono text-[8px] font-semibold text-white backdrop-blur-xs">
                                                    #{historyPhotos.length - index}
                                                </span>
                                            </div>

                                            {/* Metadata */}
                                            <div className="mt-2 flex flex-col gap-1">
                                                <div className="flex items-center justify-between text-[9px] text-stone-500 font-mono uppercase">
                                                    <span className="flex items-center gap-1">
                                                        {photo.source ===
                                                        'camera' ? (
                                                            <Camera size={10} />
                                                        ) : (
                                                            <ImageIcon
                                                                size={10}
                                                            />
                                                        )}
                                                        {photo.source}
                                                    </span>
                                                    <span>{formattedTime}</span>
                                                </div>
                                                <p className="truncate font-mono text-[10px] font-bold text-stone-900">
                                                    {photo.name}
                                                </p>
                                            </div>

                                            {/* Action Strip on Card */}
                                            <div className="mt-2.5 flex items-center justify-between border-t border-stone-200 pt-2 text-stone-700">
                                                <button
                                                    type="button"
                                                    title="Save raw photo to device"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        downloadRawPhoto(
                                                            photo.dataUrl,
                                                            photo.name,
                                                        );
                                                    }}
                                                    className="inline-flex items-center gap-0.5 p-1 font-mono text-[9px] hover:text-[#b42b1e]"
                                                >
                                                    <Download size={12} />
                                                    <span className="sr-only">
                                                        Save
                                                    </span>
                                                </button>
                                                <button
                                                    type="button"
                                                    title="Delete photo from history"
                                                    onClick={(e) =>
                                                        handleDeletePhoto(
                                                            photo.id,
                                                            e,
                                                        )
                                                    }
                                                    className="inline-flex items-center gap-0.5 p-1 font-mono text-[9px] hover:text-red-700"
                                                >
                                                    <Trash2 size={12} />
                                                    <span className="sr-only">
                                                        Delete
                                                    </span>
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                </div>

                {/* Live Camera Dialog */}
                <Dialog open={isCameraOpen} onOpenChange={setIsCameraOpen}>
                    <DialogContent className="block max-w-2xl gap-0 rounded-none border-2 border-stone-950 bg-[#e8dfcc] p-4 text-stone-950 shadow-[8px_8px_0_#b42b1e] sm:max-w-2xl sm:p-6">
                        <header className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b-2 border-stone-950 pb-4">
                            <div>
                                <p className="thermal-kicker">Live camera</p>
                                <DialogTitle className="font-serif text-3xl leading-none font-black">
                                    Take your photo
                                </DialogTitle>
                                <DialogDescription className="sr-only">
                                    Live front-camera preview with controls to
                                    capture or cancel.
                                </DialogDescription>
                            </div>

                            {/* Camera Settings Toolbar (Timer, Mirror) */}
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="flex items-center gap-1 border border-stone-950 bg-white px-2 py-1 font-mono text-[10px] font-bold uppercase">
                                    <Timer size={13} />
                                    <span>Timer:</span>
                                    {[0, 3, 5].map((sec) => (
                                        <button
                                            key={sec}
                                            type="button"
                                            onClick={() =>
                                                setCountdownSetting(sec)
                                            }
                                            className={`px-1.5 py-0.5 ${
                                                countdownSetting === sec
                                                    ? 'bg-stone-950 text-white'
                                                    : 'text-stone-700 hover:bg-stone-100'
                                            }`}
                                        >
                                            {sec === 0 ? 'Off' : `${sec}s`}
                                        </button>
                                    ))}
                                </div>

                                <button
                                    type="button"
                                    onClick={() =>
                                        setMirrorCamera((val) => !val)
                                    }
                                    className={`inline-flex items-center gap-1 border border-stone-950 px-2 py-1 font-mono text-[10px] font-bold uppercase ${
                                        mirrorCamera
                                            ? 'bg-stone-950 text-white'
                                            : 'bg-white text-stone-800'
                                    }`}
                                    title="Mirror camera preview"
                                >
                                    <FlipHorizontal size={13} />
                                    <span>Mirror</span>
                                </button>
                            </div>
                        </header>

                        <div className="relative aspect-[4/3] overflow-hidden border-2 border-stone-950 bg-stone-900">
                            <video
                                ref={videoRef}
                                autoPlay
                                muted
                                playsInline
                                className={`h-full w-full object-cover ${
                                    mirrorCamera ? '-scale-x-100' : ''
                                }`}
                            />

                            {/* Camera Starting State */}
                            {isCameraStarting && (
                                <div className="absolute inset-0 grid place-items-center bg-stone-950 text-center font-mono text-xs tracking-widest text-white uppercase">
                                    Starting camera…
                                </div>
                            )}

                            {/* Countdown Display Overlay */}
                            {activeCountdown !== null && (
                                <div className="absolute inset-0 grid place-items-center bg-black/40 backdrop-blur-xs">
                                    <div className="animate-ping text-8xl font-black font-serif text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.8)]">
                                        {activeCountdown}
                                    </div>
                                </div>
                            )}

                            {/* Camera Shutter Flash Effect */}
                            {isFlashActive && (
                                <div className="absolute inset-0 bg-white opacity-90 transition-opacity duration-150" />
                            )}
                        </div>

                        {error && (
                            <p
                                role="alert"
                                className="mt-4 border-2 border-[#b42b1e] bg-red-50 p-3 font-mono text-[10px] leading-5 font-bold text-[#8f2017]"
                            >
                                {error}
                            </p>
                        )}

                        <div className="mt-5 grid gap-3 sm:grid-cols-2">
                            <ActionButton
                                onClick={() => setIsCameraOpen(false)}
                            >
                                Cancel
                            </ActionButton>
                            <ActionButton
                                disabled={
                                    isCameraStarting ||
                                    cameraStreamRef.current === null ||
                                    activeCountdown !== null
                                }
                                onClick={triggerCaptureWithCountdown}
                                tone="red"
                            >
                                <Camera size={16} />{' '}
                                {activeCountdown !== null
                                    ? `Snapping in ${activeCountdown}s…`
                                    : countdownSetting > 0
                                      ? `Capture (${countdownSetting}s timer)`
                                      : 'Capture photo'}
                            </ActionButton>
                        </div>
                    </DialogContent>
                </Dialog>

                {/* Confirmation Dialog for Clearing History */}
                <Dialog
                    open={isClearHistoryOpen}
                    onOpenChange={setIsClearHistoryOpen}
                >
                    <DialogContent className="block max-w-md gap-0 rounded-none border-2 border-stone-950 bg-[#e8dfcc] p-6 text-stone-950 shadow-[6px_6px_0_#1c1917]">
                        <header className="mb-4 border-b-2 border-stone-950 pb-3">
                            <DialogTitle className="font-serif text-2xl font-black">
                                Clear Photo History?
                            </DialogTitle>
                            <DialogDescription className="mt-1 font-mono text-xs text-stone-600">
                                This will remove all {historyPhotos.length}{' '}
                                photos from your session roll. This action
                                cannot be undone.
                            </DialogDescription>
                        </header>
                        <div className="mt-6 flex justify-end gap-3">
                            <ActionButton
                                onClick={() => setIsClearHistoryOpen(false)}
                            >
                                Keep photos
                            </ActionButton>
                            <ActionButton
                                onClick={handleClearAllHistory}
                                tone="red"
                            >
                                Yes, Clear All
                            </ActionButton>
                        </div>
                    </DialogContent>
                </Dialog>
            </main>
        </>
    );
}
