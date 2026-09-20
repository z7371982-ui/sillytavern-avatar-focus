import {
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = 'sillytavern-avatar-focus';
const AVATAR_SELECTOR = [
    '#chat .mesAvatarWrapper img',
    '#chat .mes [class*="avatar"] img',
    '#rm_print_characters_block .character_select img',
    '#user_avatar_block .avatar-container img',
    '.avatars_inline img',
].join(',');
const AVATAR_HIT_REGION_SELECTOR = [
    '.mesAvatarWrapper',
    '.avatar:not(.avatar_collage)',
    '.character_select',
    '.avatar-container',
    '.avatars_inline',
    '[class*="avatar-frame"]',
    '[class*="avatarFrame"]',
    '[class*="avatar-mask"]',
    '[class*="avatarMask"]',
    '[class*="avatar-border"]',
    '[class*="avatarBorder"]',
].join(',');
const DEFAULTS = Object.freeze({
    enabled: true,
    tripleClickEnabled: true,
    longPressMs: 450,
    positions: {},
    saturations: {},
    libraryActive: {},
});
const TRIPLE_CLICK_WINDOW_MS = 420;
const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
const DEFAULT_ZOOM = 100;
const MIN_SATURATION = 0;
const MAX_SATURATION = 300;
const DEFAULT_SATURATION = 100;
const LIBRARY_DB_NAME = 'sillytavern-avatar-focus-library';
const LIBRARY_STORE_NAME = 'images';
const LIBRARY_DB_VERSION = 1;

const originalObjectPositions = new WeakMap();
const zoomLibrarySources = new Map();
const zoomLibrarySourcePromises = new Map();
const replayedClicks = new WeakSet();
let editorState = null;
let pendingPress = null;
let suppressClickUntil = 0;
let suppressClickKey = '';
let clickSequence = null;
let replacementTarget = null;
let galleryBusy = false;
let galleryDatabasePromise = null;
let settingsPanelInstalling = false;
let settingsPanelUnavailable = false;
let mutationFrame = 0;
const mutationImages = new Set();
const templateCache = new Map();
const galleryEntries = new Map();
const galleryRecordOrder = [];
const galleryObjectUrls = [];
let galleryCursor = 0;
let galleryPendingSelectionId = '';

function isImageFile(file) {
    return file instanceof Blob
        && file.size > 0
        && (String(file.type).startsWith('image/')
            || /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(String(file.name || '')));
}

async function loadOwnTemplate(name) {
    if (templateCache.has(name)) {
        return templateCache.get(name);
    }

    const templateUrl = new URL(`./${name}.html`, import.meta.url);
    const response = await fetch(templateUrl);
    if (!response.ok) {
        throw new Error(`Unable to load ${name}.html (${response.status})`);
    }

    const html = await response.text();
    if (!html.trim()) {
        throw new Error(`${name}.html is empty`);
    }

    templateCache.set(name, html);
    return html;
}

function openGalleryDatabase() {
    if (galleryDatabasePromise) {
        return galleryDatabasePromise;
    }
    if (!globalThis.indexedDB) {
        return Promise.reject(new Error('当前浏览器不支持本地头像库。'));
    }

    galleryDatabasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(LIBRARY_STORE_NAME)) {
                const store = database.createObjectStore(LIBRARY_STORE_NAME, { keyPath: 'id' });
                store.createIndex('ownerKey', 'ownerKey', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('头像库数据库打开失败。'));
        request.onblocked = () => reject(new Error('头像库正在被另一个页面占用，请关闭其它酒馆页面后重试。'));
    }).catch((error) => {
        galleryDatabasePromise = null;
        throw error;
    });
    return galleryDatabasePromise;
}

async function getGalleryRecords(ownerKey) {
    const database = await openGalleryDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(LIBRARY_STORE_NAME, 'readonly');
        const request = transaction.objectStore(LIBRARY_STORE_NAME).index('ownerKey').getAll(ownerKey);
        request.onsuccess = () => {
            const records = Array.isArray(request.result) ? request.result : [];
            records.sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
            resolve(records);
        };
        request.onerror = () => reject(request.error || new Error('头像库读取失败。'));
    });
}

async function getGalleryRecord(id) {
    if (!id) {
        return null;
    }
    const database = await openGalleryDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(LIBRARY_STORE_NAME, 'readonly');
        const request = transaction.objectStore(LIBRARY_STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('头像原图读取失败。'));
    });
}

function createGalleryRecord(ownerKey, file, options = {}) {
    const fallbackId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    return {
        id: globalThis.crypto?.randomUUID?.() || fallbackId,
        ownerKey,
        name: options.name || file.name || '头像图片',
        type: file.type || 'image/png',
        size: Number(file.size) || 0,
        createdAt: Date.now() + Math.random(),
        original: Boolean(options.original),
        blob: file,
    };
}

async function addGalleryRecords(ownerKey, files, options = {}) {
    const validFiles = Array.from(files).filter(isImageFile);
    if (!validFiles.length) {
        return [];
    }

    const records = validFiles.map((file, index) => createGalleryRecord(ownerKey, file, {
        name: options.name && index === 0 ? options.name : file.name,
        original: options.original && index === 0,
    }));
    const database = await openGalleryDatabase();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(LIBRARY_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(LIBRARY_STORE_NAME);
        records.forEach((record) => store.put(record));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('头像图片保存失败。'));
        transaction.onabort = () => reject(transaction.error || new Error('头像图片保存被浏览器中止。'));
    });
    return records;
}

async function deleteGalleryRecord(id) {
    const database = await openGalleryDatabase();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(LIBRARY_STORE_NAME, 'readwrite');
        transaction.objectStore(LIBRARY_STORE_NAME).delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('头像图片删除失败。'));
        transaction.onabort = () => reject(transaction.error || new Error('头像图片删除被浏览器中止。'));
    });
}

function getSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }

    const current = extension_settings[MODULE_NAME];
    if (typeof current.enabled !== 'boolean') {
        current.enabled = DEFAULTS.enabled;
    }
    if (typeof current.tripleClickEnabled !== 'boolean') {
        current.tripleClickEnabled = DEFAULTS.tripleClickEnabled;
    }
    if (![350, 450, 600].includes(Number(current.longPressMs))) {
        current.longPressMs = DEFAULTS.longPressMs;
    }
    if (!current.positions || typeof current.positions !== 'object' || Array.isArray(current.positions)) {
        current.positions = {};
    }
    if (!current.saturations || typeof current.saturations !== 'object' || Array.isArray(current.saturations)) {
        current.saturations = {};
    }
    if (!current.libraryActive || typeof current.libraryActive !== 'object' || Array.isArray(current.libraryActive)) {
        current.libraryActive = {};
    }
    return current;
}

function notify(level, message) {
    const toast = globalThis.toastr?.[level];
    if (typeof toast === 'function') {
        toast(message, '头像取景与头像库');
    } else {
        console.info('[Avatar Focus] ' + message);
    }
}

function clamp(value, minimum = 0, maximum = 100) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function cleanPosition(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    const zoom = Number(value.zoom);
    return {
        x: clamp(x),
        y: clamp(y),
        zoom: Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : DEFAULT_ZOOM,
    };
}

function roundPosition(value) {
    return Math.round(clamp(value) * 10) / 10;
}

function roundZoom(value) {
    return Math.round(clamp(value, MIN_ZOOM, MAX_ZOOM));
}

function cleanSaturation(value) {
    const saturation = Number(value);
    return Number.isFinite(saturation)
        ? clamp(saturation, MIN_SATURATION, MAX_SATURATION)
        : null;
}

function roundSaturation(value) {
    return Math.round(clamp(value, MIN_SATURATION, MAX_SATURATION));
}

function getZoomClipPath(position) {
    const zoom = roundZoom(position.zoom ?? DEFAULT_ZOOM);
    if (zoom <= DEFAULT_ZOOM) {
        return null;
    }

    const insetRange = 100 * (1 - DEFAULT_ZOOM / zoom);
    const x = roundPosition(position.x) / 100;
    const y = roundPosition(position.y) / 100;
    const values = [
        y * insetRange,
        (1 - x) * insetRange,
        (1 - y) * insetRange,
        x * insetRange,
    ].map((value) => Math.round(value * 1000) / 1000);
    return `inset(${values[0]}% ${values[1]}% ${values[2]}% ${values[3]}%)`;
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function smallHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function getImageKey(image) {
    const source = image.getAttribute('src') || image.currentSrc || image.src || '';
    if (!source) {
        return '';
    }
    if (source.startsWith('data:') || source.startsWith('blob:')) {
        return 'embedded:' + smallHash(source);
    }

    try {
        const url = new URL(source, location.href);
        const type = String(url.searchParams.get('type') || '').toLowerCase();
        const file = url.searchParams.get('file') || url.searchParams.get('avatar');
        if (file && (type === 'avatar' || type === 'persona')) {
            return type + ':' + safeDecode(file);
        }

        const path = safeDecode(url.pathname);
        const characterMatch = path.match(/\/characters\/([^/]+)$/i);
        if (characterMatch) {
            return 'avatar:' + characterMatch[1];
        }
        const personaMatch = path.match(/\/(?:user[ _-]?avatars?|personas?)\/([^/]+)$/i);
        if (personaMatch) {
            return 'persona:' + personaMatch[1];
        }

        const stableParams = new URLSearchParams();
        const ignored = new Set(['_', 't', 'v', 'cache', 'cacheBust', 'cb']);
        Array.from(url.searchParams.keys()).sort().forEach((name) => {
            if (!ignored.has(name)) {
                url.searchParams.getAll(name).forEach((value) => stableParams.append(name, value));
            }
        });
        const query = stableParams.toString();
        return 'url:' + url.pathname + (query ? '?' + query : '');
    } catch {
        return 'raw:' + smallHash(source);
    }
}

function getLibrarySaturationKey(imageKey, recordId) {
    return imageKey + '::library::' + recordId;
}

function getSaturationKey(image) {
    const imageKey = getImageKey(image);
    if (!imageKey) {
        return '';
    }
    const activeLibraryId = getSettings().libraryActive[imageKey];
    return activeLibraryId
        ? getLibrarySaturationKey(imageKey, activeLibraryId)
        : imageKey;
}

function avatarCandidateScore(image) {
    if (!(image instanceof HTMLImageElement)
        || !image.getAttribute('src')
        || image.closest('.avatar_collage')) {
        return -Infinity;
    }

    const source = image.getAttribute('src') || image.currentSrc || image.src || '';
    const identity = [
        image.id,
        image.className,
        image.alt,
        image.parentElement?.id,
        image.parentElement?.className,
    ].join(' ').toLowerCase();
    let score = 0;

    if (/\/thumbnail\?.*type=(avatar|persona)|\/characters\/|user[ _-]?avatars?|\/personas?\//i.test(source)) {
        score += 140;
    }
    if (image.closest('.avatar:not(.avatar_collage)')) {
        score += 70;
    }
    if (image.closest('.mesAvatarWrapper')) {
        score += 35;
    }
    if (/(avatar|portrait|profile|face|head)/i.test(identity)) {
        score += 28;
    }
    if (getComputedStyle(image).objectFit === 'cover') {
        score += 18;
    }
    const rect = image.getBoundingClientRect();
    if (rect.width > 8 && rect.height > 8) {
        score += 12;
    }
    if (/(frame|border|overlay|decor|ornament|badge|foreground)/i.test(identity)) {
        score -= 120;
    }
    return score;
}

function isAvatarImage(image) {
    return image instanceof HTMLImageElement
        && image.matches(AVATAR_SELECTOR)
        && avatarCandidateScore(image) >= 30;
}

function bestAvatarImage(images) {
    return Array.from(images)
        .filter((image) => image instanceof HTMLImageElement)
        .map((image) => ({ image, score: avatarCandidateScore(image) }))
        .filter((candidate) => candidate.score >= 30)
        .sort((left, right) => right.score - left.score)[0]?.image || null;
}

function findAvatarFromTarget(target) {
    if (!(target instanceof Element)) {
        return null;
    }
    if (target instanceof HTMLImageElement && isAvatarImage(target)) {
        return target;
    }

    const hitRegion = target.closest(AVATAR_HIT_REGION_SELECTOR);
    if (!hitRegion) {
        return null;
    }

    const message = target.closest('#chat .mes');
    const messageAvatarWrapper = message?.querySelector('.mesAvatarWrapper');
    const searchRegion = messageAvatarWrapper || hitRegion;
    const candidates = [
        ...searchRegion.querySelectorAll('img'),
        ...(message && searchRegion !== message ? message.querySelectorAll('[class*="avatar"] img') : []),
    ];
    return bestAvatarImage(candidates);
}

function pointInsideRect(x, y, rect, padding = 0) {
    return x >= rect.left - padding
        && x <= rect.right + padding
        && y >= rect.top - padding
        && y <= rect.bottom + padding;
}

function findAvatarFromInteraction(target, clientX, clientY) {
    const direct = findAvatarFromTarget(target);
    const hasPointerLocation = Number.isFinite(clientX) && Number.isFinite(clientY);
    if (direct && (!hasPointerLocation
        || pointInsideRect(clientX, clientY, direct.getBoundingClientRect(), 8))) {
        return direct;
    }
    if (!(target instanceof Element) || !hasPointerLocation) {
        return null;
    }

    const message = target.closest('#chat .mes');
    if (!message) {
        return null;
    }
    const candidates = Array.from(message.querySelectorAll('img'))
        .filter((image) => avatarCandidateScore(image) >= 30)
        .map((image) => {
            const rect = image.getBoundingClientRect();
            return {
                image,
                rect,
                score: avatarCandidateScore(image),
                containsPoint: pointInsideRect(clientX, clientY, rect, 8),
            };
        })
        .filter((candidate) => candidate.containsPoint)
        .sort((left, right) => right.score - left.score);
    if (candidates.length) {
        return candidates[0].image;
    }

    return null;
}

function findAvatarFeedbackElement(target, image) {
    const imageRegion = image?.closest('.mesAvatarWrapper, .avatar:not(.avatar_collage), .character_select, .avatar-container');
    if (imageRegion) {
        return imageRegion;
    }
    if (target instanceof Element) {
        return target.closest(AVATAR_HIT_REGION_SELECTOR) || image;
    }
    return image;
}

function loadZoomLibrarySource(record) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(record.blob);
        const probe = new Image();
        probe.onload = () => resolve({
            recordId: record.id,
            url,
            width: probe.naturalWidth,
            height: probe.naturalHeight,
        });
        probe.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('无法读取头像库原图'));
        };
        probe.src = url;
    });
}

function releaseZoomLibrarySource(key) {
    const cached = zoomLibrarySources.get(key);
    zoomLibrarySources.delete(key);
    zoomLibrarySourcePromises.delete(key);
    if (cached?.url) {
        URL.revokeObjectURL(cached.url);
    }
}

async function prepareZoomLibrarySource(key, preferredRecord = null) {
    const activeId = getSettings().libraryActive[key] || '';
    if (!key.startsWith('persona:') || !activeId) {
        releaseZoomLibrarySource(key);
        return null;
    }
    const cached = zoomLibrarySources.get(key);
    if (cached?.recordId === activeId) {
        return cached;
    }
    const pending = zoomLibrarySourcePromises.get(key);
    if (pending?.recordId === activeId) {
        return pending.promise;
    }

    const promise = (async () => {
        const record = preferredRecord?.id === activeId
            ? preferredRecord
            : await getGalleryRecord(activeId);
        if (!record || record.ownerKey !== key || !(record.blob instanceof Blob)) {
            return null;
        }
        const source = await loadZoomLibrarySource(record);
        if (getSettings().libraryActive[key] !== activeId) {
            URL.revokeObjectURL(source.url);
            return null;
        }
        const previous = zoomLibrarySources.get(key);
        zoomLibrarySources.set(key, source);
        if (previous?.url && previous.url !== source.url) {
            URL.revokeObjectURL(previous.url);
        }
        const livePosition = editorState?.key === key
            ? editorState.position
            : cleanPosition(getSettings().positions[key]);
        if (livePosition) {
            applyPositionForKey(key, livePosition);
        }
        return source;
    })().catch((error) => {
        console.warn('[Avatar Focus] Could not prepare the full avatar image for zooming:', error);
        return null;
    }).finally(() => {
        if (zoomLibrarySourcePromises.get(key)?.promise === promise) {
            zoomLibrarySourcePromises.delete(key);
        }
    });
    zoomLibrarySourcePromises.set(key, { recordId: activeId, promise });
    return promise;
}

function getZoomSource(image) {
    const key = getImageKey(image);
    const activeId = getSettings().libraryActive[key] || '';
    const cached = zoomLibrarySources.get(key);
    if (key.startsWith('persona:') && activeId) {
        if (cached?.recordId === activeId) {
            return cached;
        }
        void prepareZoomLibrarySource(key);
    }
    return {
        recordId: '',
        url: image.currentSrc || image.getAttribute('src') || image.src || '',
        width: image.naturalWidth,
        height: image.naturalHeight,
    };
}

function stripThemeSaturation(filterValue) {
    const filtered = String(filterValue || '')
        .replace(/\b(?:saturate|grayscale)\([^)]*\)/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return filtered === 'none' ? '' : filtered;
}

function rememberOriginalPosition(image) {
    if (!originalObjectPositions.has(image)) {
        const computedFilter = getComputedStyle(image).filter;
        originalObjectPositions.set(image, {
            value: image.style.getPropertyValue('object-position'),
            priority: image.style.getPropertyPriority('object-position'),
            scaleValue: image.style.getPropertyValue('scale'),
            scalePriority: image.style.getPropertyPriority('scale'),
            originValue: image.style.getPropertyValue('transform-origin'),
            originPriority: image.style.getPropertyPriority('transform-origin'),
            clipValue: image.style.getPropertyValue('clip-path'),
            clipPriority: image.style.getPropertyPriority('clip-path'),
            fitValue: image.style.getPropertyValue('object-fit'),
            fitPriority: image.style.getPropertyPriority('object-fit'),
            backgroundImageValue: image.style.getPropertyValue('background-image'),
            backgroundImagePriority: image.style.getPropertyPriority('background-image'),
            backgroundSizeValue: image.style.getPropertyValue('background-size'),
            backgroundSizePriority: image.style.getPropertyPriority('background-size'),
            backgroundPositionValue: image.style.getPropertyValue('background-position'),
            backgroundPositionPriority: image.style.getPropertyPriority('background-position'),
            backgroundRepeatValue: image.style.getPropertyValue('background-repeat'),
            backgroundRepeatPriority: image.style.getPropertyPriority('background-repeat'),
            filterValue: image.style.getPropertyValue('filter'),
            filterPriority: image.style.getPropertyPriority('filter'),
            filterWithoutSaturation: stripThemeSaturation(computedFilter),
        });
    }
}

function restoreOriginalProperty(image, name, value, priority) {
    if (value) {
        image.style.setProperty(name, value, priority);
    } else {
        image.style.removeProperty(name);
    }
}

function restoreImagePosition(image) {
    rememberOriginalPosition(image);
    const original = originalObjectPositions.get(image);
    restoreOriginalProperty(image, 'object-position', original.value, original.priority);
    restoreOriginalProperty(image, 'scale', original.scaleValue, original.scalePriority);
    restoreOriginalProperty(image, 'transform-origin', original.originValue, original.originPriority);
    restoreOriginalProperty(image, 'clip-path', original.clipValue, original.clipPriority);
    restoreOriginalProperty(image, 'object-fit', original.fitValue, original.fitPriority);
    restoreOriginalProperty(image, 'background-image', original.backgroundImageValue, original.backgroundImagePriority);
    restoreOriginalProperty(image, 'background-size', original.backgroundSizeValue, original.backgroundSizePriority);
    restoreOriginalProperty(image, 'background-position', original.backgroundPositionValue, original.backgroundPositionPriority);
    restoreOriginalProperty(image, 'background-repeat', original.backgroundRepeatValue, original.backgroundRepeatPriority);
}

function restoreImageSaturation(image) {
    rememberOriginalPosition(image);
    const original = originalObjectPositions.get(image);
    restoreOriginalProperty(image, 'filter', original.filterValue, original.filterPriority);
}

function setImageSaturation(image, saturation) {
    rememberOriginalPosition(image);
    const original = originalObjectPositions.get(image);
    const filter = [
        original.filterWithoutSaturation,
        `saturate(${roundSaturation(saturation)}%)`,
    ].filter(Boolean).join(' ');
    image.style.setProperty('filter', filter, 'important');
}

function restoreZoomOutRendering(image, original) {
    restoreOriginalProperty(image, 'object-fit', original.fitValue, original.fitPriority);
    restoreOriginalProperty(image, 'background-image', original.backgroundImageValue, original.backgroundImagePriority);
    restoreOriginalProperty(image, 'background-size', original.backgroundSizeValue, original.backgroundSizePriority);
    restoreOriginalProperty(image, 'background-position', original.backgroundPositionValue, original.backgroundPositionPriority);
    restoreOriginalProperty(image, 'background-repeat', original.backgroundRepeatValue, original.backgroundRepeatPriority);
}

function zoomCssUrl(source) {
    const escaped = String(source)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\n\r\f]/g, '');
    return `url("${escaped}")`;
}

function setZoomOutRendering(image, position, zoom, original) {
    const source = getZoomSource(image);
    const boxWidth = image.clientWidth || image.getBoundingClientRect().width;
    const boxHeight = image.clientHeight || image.getBoundingClientRect().height;
    if (!source.url || !source.width || !source.height || !boxWidth || !boxHeight) {
        return false;
    }

    const coverScale = Math.max(boxWidth / source.width, boxHeight / source.height);
    const containScale = Math.min(boxWidth / source.width, boxHeight / source.height);
    const progress = (zoom - MIN_ZOOM) / (DEFAULT_ZOOM - MIN_ZOOM);
    const renderScale = containScale + (coverScale - containScale) * progress;
    const renderedWidth = Math.round(source.width * renderScale * 1000) / 1000;
    const renderedHeight = Math.round(source.height * renderScale * 1000) / 1000;
    const x = roundPosition(position.x);
    const y = roundPosition(position.y);
    const layer = zoomCssUrl(source.url);

    restoreOriginalProperty(image, 'scale', original.scaleValue, original.scalePriority);
    restoreOriginalProperty(image, 'transform-origin', original.originValue, original.originPriority);
    restoreOriginalProperty(image, 'clip-path', original.clipValue, original.clipPriority);
    image.style.setProperty('object-fit', 'none', 'important');
    image.style.setProperty('object-position', '-100000px -100000px', 'important');
    image.style.setProperty('background-image', `${layer}, ${layer}`, 'important');
    image.style.setProperty('background-size', `${renderedWidth}px ${renderedHeight}px, cover`, 'important');
    image.style.setProperty('background-position', `${x}% ${y}%, ${x}% ${y}%`, 'important');
    image.style.setProperty('background-repeat', 'no-repeat', 'important');
    return true;
}

function setImagePosition(image, position) {
    rememberOriginalPosition(image);
    const zoom = roundZoom(position.zoom ?? DEFAULT_ZOOM);
    image.style.setProperty(
        'object-position',
        roundPosition(position.x) + '% ' + roundPosition(position.y) + '%',
        'important',
    );
    const original = originalObjectPositions.get(image);
    if (zoom < DEFAULT_ZOOM && setZoomOutRendering(image, position, zoom, original)) {
        return;
    }

    restoreZoomOutRendering(image, original);
    image.style.setProperty(
        'object-position',
        roundPosition(position.x) + '% ' + roundPosition(position.y) + '%',
        'important',
    );
    if (zoom === DEFAULT_ZOOM) {
        restoreOriginalProperty(image, 'scale', original.scaleValue, original.scalePriority);
        restoreOriginalProperty(image, 'transform-origin', original.originValue, original.originPriority);
        restoreOriginalProperty(image, 'clip-path', original.clipValue, original.clipPriority);
    } else {
        image.style.setProperty('scale', String(zoom / 100), 'important');
        image.style.setProperty(
            'transform-origin',
            roundPosition(position.x) + '% ' + roundPosition(position.y) + '%',
            'important',
        );
        const clipPath = getZoomClipPath(position);
        if (clipPath) {
            image.style.setProperty('clip-path', clipPath, 'important');
        } else {
            restoreOriginalProperty(image, 'clip-path', original.clipValue, original.clipPriority);
        }
    }
}

function applySavedPosition(image) {
    if (!isAvatarImage(image)) {
        return;
    }
    if (!getSettings().enabled) {
        restoreImagePosition(image);
        restoreImageSaturation(image);
        return;
    }
    const settings = getSettings();
    const position = cleanPosition(settings.positions[getImageKey(image)]);
    if (position) {
        setImagePosition(image, position);
    } else {
        restoreImagePosition(image);
    }
    const saturation = cleanSaturation(settings.saturations[getSaturationKey(image)]);
    if (saturation === null) {
        restoreImageSaturation(image);
    } else {
        setImageSaturation(image, saturation);
    }
}

function forEachAvatar(callback) {
    document.querySelectorAll(AVATAR_SELECTOR).forEach((image) => {
        if (isAvatarImage(image)) {
            callback(image);
        }
    });
}

function applyAllSavedPositions() {
    forEachAvatar(applySavedPosition);
}

function restoreAllPositions() {
    forEachAvatar((image) => {
        restoreImagePosition(image);
        restoreImageSaturation(image);
    });
}

function applyPositionForKey(key, position) {
    forEachAvatar((image) => {
        if (getImageKey(image) !== key) {
            return;
        }
        if (position) {
            setImagePosition(image, position);
        } else {
            restoreImagePosition(image);
        }
    });
}

function applySaturationForKey(key, saturation) {
    forEachAvatar((image) => {
        if (getSaturationKey(image) !== key) {
            return;
        }
        if (saturation === null) {
            restoreImageSaturation(image);
        } else {
            setImageSaturation(image, saturation);
        }
    });
}

function applySavedAdjustmentsForImageKey(key) {
    forEachAvatar((image) => {
        if (getImageKey(image) === key) {
            applySavedPosition(image);
        }
    });
}

function parsePositionToken(token, axis) {
    const normalized = String(token || '').trim().toLowerCase();
    const keywords = {
        left: 0,
        top: 0,
        center: 50,
        right: 100,
        bottom: 100,
    };
    if (Object.hasOwn(keywords, normalized)) {
        return keywords[normalized];
    }
    const percentage = normalized.match(/^(-?\d+(?:\.\d+)?)%$/);
    if (percentage) {
        return clamp(Number(percentage[1]));
    }
    return axis === 'x' || axis === 'y' ? 50 : 50;
}

function readComputedPosition(image) {
    const tokens = getComputedStyle(image).objectPosition.trim().split(/\s+/);
    if (tokens.length === 1) {
        const value = parsePositionToken(tokens[0], 'x');
        return { x: value, y: value, zoom: DEFAULT_ZOOM };
    }
    return {
        x: parsePositionToken(tokens[0], 'x'),
        y: parsePositionToken(tokens[1], 'y'),
        zoom: DEFAULT_ZOOM,
    };
}

function getAvatarLabel(image) {
    const messageName = image.closest('.mes')?.getAttribute('ch_name');
    if (messageName) {
        return messageName;
    }
    const character = image.closest('.character_select, .avatar-container');
    const characterName = character?.querySelector('.ch_name, .name_text')?.textContent?.trim();
    return characterName || image.alt || image.title || '当前头像';
}

function getReplacementDescriptor(image) {
    const key = getImageKey(image);
    if (key.startsWith('avatar:')) {
        return {
            kind: 'character',
            key,
            avatarId: key.slice('avatar:'.length),
            label: getAvatarLabel(image),
            imageSource: image.currentSrc || image.src,
        };
    }
    if (key.startsWith('persona:')) {
        return {
            kind: 'persona',
            key,
            avatarId: key.slice('persona:'.length),
            label: getAvatarLabel(image),
            imageSource: image.currentSrc || image.src,
        };
    }
    return null;
}

function bustVisibleAvatarCache(key) {
    const stamp = String(Date.now());
    forEachAvatar((image) => {
        if (getImageKey(image) !== key) {
            return;
        }
        try {
            const url = new URL(image.getAttribute('src') || image.src, location.href);
            if (url.protocol === 'http:' || url.protocol === 'https:') {
                url.searchParams.set('t', stamp);
                image.src = url.href;
            }
        } catch {
            // The core refresh already handled non-URL image sources.
        }
    });
}

function chooseAvatarReplacement(image) {
    const descriptor = getReplacementDescriptor(image);
    if (!descriptor) {
        notify('warning', '这个头像不是角色或用户头像，无法使用头像库。');
        return;
    }
    replacementTarget = descriptor;
    void openAvatarGallery();
}

async function replaceCharacterAvatar(file, target = replacementTarget) {
    if (!target || target.kind !== 'character') {
        return false;
    }

    const input = document.getElementById('stafe_replace_input');
    if (input instanceof HTMLInputElement) {
        input.disabled = true;
    }
    notify('info', '正在替换“' + target.label + '”的头像……');

    try {
        const formData = new FormData();
        formData.append('avatar', file, file.name || 'avatar.png');
        formData.append('avatar_url', target.avatarId);
        const response = await fetch('/api/characters/edit-avatar', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
        });
        if (!response.ok) {
            const details = await response.text();
            throw new Error(details || 'HTTP ' + response.status);
        }

        bustVisibleAvatarCache(target.key);

        const formAvatar = document.querySelector('#form_create [name="avatar_url"]');
        if (formAvatar instanceof HTMLInputElement && formAvatar.value === target.avatarId) {
            const preview = document.getElementById('avatar_load_preview');
            if (preview instanceof HTMLImageElement) {
                preview.src = '/characters/' + encodeURIComponent(target.avatarId) + '?t=' + Date.now();
            }
        }
        notify('success', '“' + target.label + '”的头像已替换；需要时可再长按微调取景。');
        return true;
    } catch (error) {
        console.error('[Avatar Focus] Character avatar replacement failed:', error);
        notify('error', '头像替换失败：' + (error instanceof Error ? error.message : String(error)));
        return false;
    } finally {
        if (input instanceof HTMLInputElement) {
            input.disabled = false;
            input.value = '';
        }
    }
}

function loadPersonaSourceImage(file) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => resolve({ image, objectUrl });
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('无法读取这张头像图片'));
        };
        image.src = objectUrl;
    });
}

function personaCanvasToFile(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('头像图片处理失败'));
                return;
            }
            resolve(new File([blob], 'avatar.png', {
                type: 'image/png',
                lastModified: Date.now(),
            }));
        }, 'image/png');
    });
}

async function preparePersonaCoverFile(file) {
    const { image, objectUrl } = await loadPersonaSourceImage(file);
    try {
        const sourceWidth = image.naturalWidth;
        const sourceHeight = image.naturalHeight;
        if (!sourceWidth || !sourceHeight) {
            throw new Error('无法读取头像尺寸');
        }

        // Persona files are forced to 400 x 600 by the backend. Produce a
        // proportional 2:3 cover first so the default 100% view fills its
        // frame without stretching. The uncut source remains in IndexedDB and
        // is used by setZoomOutRendering below 100%.
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 1200;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('当前浏览器无法处理头像');
        }
        const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        context.drawImage(
            image,
            (canvas.width - width) / 2,
            (canvas.height - height) / 2,
            width,
            height,
        );
        return await personaCanvasToFile(canvas);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function replacePersonaAvatar(file, target = replacementTarget) {
    if (!target || target.kind !== 'persona') {
        return false;
    }

    try {
        const preparedFile = await preparePersonaCoverFile(file);
        const formData = new FormData();
        formData.append('avatar', preparedFile, preparedFile.name);
        formData.append('overwrite_name', target.avatarId);
        const response = await fetch('/api/avatars/upload', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            cache: 'no-cache',
            body: formData,
        });
        if (!response.ok) {
            const details = await response.text();
            throw new Error(details || 'HTTP ' + response.status);
        }

        bustVisibleAvatarCache(target.key);
        notify('success', '“' + target.label + '”的头像已切换。');
        return true;
    } catch (error) {
        console.error('[Avatar Focus] Persona avatar replacement failed:', error);
        notify('error', '用户头像替换失败：' + (error instanceof Error ? error.message : String(error)));
        return false;
    }
}

function revokeGalleryObjectUrls() {
    galleryObjectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
}

function setGalleryBusy(busy) {
    galleryBusy = busy;
    const gallery = document.getElementById('stafe_gallery');
    gallery?.classList.toggle('stafe-gallery-busy', busy);
    updateGalleryControlStates();
}

function getCurrentGalleryRecord() {
    return galleryRecordOrder[galleryCursor] || null;
}

function updateGalleryControlStates() {
    const gallery = document.getElementById('stafe_gallery');
    if (!gallery) {
        return;
    }
    const hasRecords = galleryRecordOrder.length > 0;
    const hasSeveral = galleryRecordOrder.length > 1;
    gallery.querySelectorAll('button').forEach((button) => {
        const action = button.dataset.stafeGalleryAction;
        if (galleryBusy) {
            button.disabled = true;
        } else if (action === 'previous' || action === 'next') {
            button.disabled = !hasSeveral;
        } else if (action === 'select' || action === 'delete') {
            button.disabled = !hasRecords;
        } else {
            button.disabled = false;
        }
    });
}

function renderGalleryCarousel() {
    const carousel = document.getElementById('stafe_gallery_carousel');
    const preview = document.getElementById('stafe_gallery_preview');
    const name = document.getElementById('stafe_gallery_name');
    const count = document.getElementById('stafe_gallery_count');
    const active = document.getElementById('stafe_gallery_active');
    const empty = document.getElementById('stafe_gallery_empty');
    if (!carousel || !(preview instanceof HTMLImageElement) || !name || !count || !active || !empty) {
        return;
    }

    revokeGalleryObjectUrls();
    const record = getCurrentGalleryRecord();
    carousel.hidden = !record;
    empty.hidden = Boolean(record);
    if (!record) {
        preview.removeAttribute('src');
        preview.alt = '';
        name.textContent = '头像图片';
        count.textContent = '0 / 0';
        active.hidden = true;
        updateGalleryControlStates();
        return;
    }

    const objectUrl = URL.createObjectURL(record.blob);
    galleryObjectUrls.push(objectUrl);
    preview.src = objectUrl;
    preview.alt = record.name || '头像图片';
    name.textContent = record.name || '头像图片';
    count.textContent = (galleryCursor + 1) + ' / ' + galleryRecordOrder.length;
    active.hidden = getSettings().libraryActive[replacementTarget?.key] !== record.id;
    updateGalleryControlStates();
}

async function renderAvatarGallery() {
    if (!replacementTarget) {
        return;
    }
    const previousRecord = getCurrentGalleryRecord();
    galleryEntries.clear();
    galleryRecordOrder.splice(0);
    const records = await getGalleryRecords(replacementTarget.key);
    records.forEach((record) => {
        galleryEntries.set(record.id, record);
        galleryRecordOrder.push(record);
    });
    const activeId = getSettings().libraryActive[replacementTarget.key] || '';
    const preferredId = galleryPendingSelectionId || previousRecord?.id || activeId;
    galleryPendingSelectionId = '';
    const preferredIndex = records.findIndex((record) => record.id === preferredId);
    galleryCursor = records.length ? (preferredIndex >= 0 ? preferredIndex : 0) : 0;
    renderGalleryCarousel();
}

function moveGalleryCursor(direction) {
    if (galleryBusy || galleryRecordOrder.length < 2) {
        return;
    }
    galleryCursor = (galleryCursor + direction + galleryRecordOrder.length) % galleryRecordOrder.length;
    renderGalleryCarousel();
}

async function saveCurrentAvatarIfLibraryEmpty() {
    if (!replacementTarget?.imageSource) {
        return;
    }
    const records = await getGalleryRecords(replacementTarget.key);
    if (records.length) {
        return;
    }

    try {
        const response = await fetch(replacementTarget.imageSource, { cache: 'no-store' });
        if (!response.ok) {
            return;
        }
        const blob = await response.blob();
        const sourceLooksLikeImage = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)(?:[?#]|$)/i.test(replacementTarget.imageSource);
        if (!blob.size || (!String(blob.type).startsWith('image/') && !sourceLooksLikeImage)) {
            return;
        }
        const extension = String(blob.type).split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const file = new File([blob], '原头像.' + extension, { type: blob.type || 'image/png' });
        const [record] = await addGalleryRecords(replacementTarget.key, [file], {
            name: '原头像',
            original: true,
        });
        if (record) {
            const settings = getSettings();
            const existingSaturation = cleanSaturation(settings.saturations[replacementTarget.key]);
            const recordSaturationKey = getLibrarySaturationKey(replacementTarget.key, record.id);
            if (existingSaturation !== null && !Object.hasOwn(settings.saturations, recordSaturationKey)) {
                settings.saturations[recordSaturationKey] = existingSaturation;
                delete settings.saturations[replacementTarget.key];
            }
            getSettings().libraryActive[replacementTarget.key] = record.id;
            saveSettingsDebounced();
            applySavedAdjustmentsForImageKey(replacementTarget.key);
            if (replacementTarget.kind === 'persona') {
                void prepareZoomLibrarySource(replacementTarget.key, record);
            }
        }
    } catch (error) {
        console.warn('[Avatar Focus] Could not preserve the current avatar in the library:', error);
    }
}

async function openAvatarGallery() {
    const gallery = document.getElementById('stafe_gallery');
    if (!replacementTarget || !gallery) {
        notify('error', '头像库没有加载成功，请刷新酒馆后再试。');
        return;
    }

    document.getElementById('stafe_gallery_avatar_name').textContent = replacementTarget.label;
    gallery.hidden = false;
    gallery.setAttribute('aria-hidden', 'false');
    document.body.classList.add('stafe-modal-open');
    updateEditorViewportHeight();
    setGalleryBusy(true);
    try {
        await saveCurrentAvatarIfLibraryEmpty();
        await renderAvatarGallery();
    } catch (error) {
        console.error('[Avatar Focus] Avatar library failed to open:', error);
        notify('error', '头像库打开失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
        setGalleryBusy(false);
    }
}

function closeAvatarGallery() {
    if (galleryBusy) {
        return;
    }
    const gallery = document.getElementById('stafe_gallery');
    if (gallery) {
        gallery.hidden = true;
        gallery.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('stafe-modal-open');
    revokeGalleryObjectUrls();
    galleryEntries.clear();
    galleryRecordOrder.splice(0);
    galleryCursor = 0;
    galleryPendingSelectionId = '';
    replacementTarget = null;
    const input = document.getElementById('stafe_replace_input');
    if (input instanceof HTMLInputElement) {
        input.value = '';
    }
}

async function importGalleryFiles(files) {
    if (!replacementTarget) {
        return;
    }
    const validFiles = Array.from(files).filter(isImageFile);
    if (!validFiles.length) {
        notify('warning', '请选择图片文件。');
        return;
    }

    setGalleryBusy(true);
    try {
        const records = await addGalleryRecords(replacementTarget.key, validFiles);
        galleryPendingSelectionId = records[0]?.id || '';
        await renderAvatarGallery();
        notify('success', '已导入 ' + records.length + ' 张头像图片。');
    } catch (error) {
        console.error('[Avatar Focus] Avatar library import failed:', error);
        notify('error', '导入失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
        setGalleryBusy(false);
    }
}

async function selectGalleryRecord(id = getCurrentGalleryRecord()?.id) {
    const record = galleryEntries.get(id);
    const target = replacementTarget;
    if (!record || !target) {
        return;
    }

    setGalleryBusy(true);
    try {
        const file = new File([record.blob], record.name || 'avatar.png', { type: record.type || record.blob.type || 'image/png' });
        const success = target.kind === 'persona'
            ? await replacePersonaAvatar(file, target)
            : await replaceCharacterAvatar(file, target);
        if (success) {
            getSettings().libraryActive[target.key] = record.id;
            saveSettingsDebounced();
            applySavedAdjustmentsForImageKey(target.key);
            if (target.kind === 'persona') {
                void prepareZoomLibrarySource(target.key, record);
            }
            await renderAvatarGallery();
        }
    } finally {
        setGalleryBusy(false);
    }
}

async function removeGalleryRecord(id = getCurrentGalleryRecord()?.id) {
    const record = galleryEntries.get(id);
    const target = replacementTarget;
    if (!record || !target) {
        return;
    }
    if (!window.confirm('确定从头像库删除“' + (record.name || '这张图片') + '”吗？当前已经显示的头像不会被还原。')) {
        return;
    }

    setGalleryBusy(true);
    try {
        const nextRecord = galleryRecordOrder.length > 1
            ? (galleryRecordOrder[galleryCursor + 1] || galleryRecordOrder[galleryCursor - 1])
            : null;
        galleryPendingSelectionId = nextRecord?.id || '';
        await deleteGalleryRecord(id);
        delete getSettings().saturations[getLibrarySaturationKey(target.key, id)];
        if (getSettings().libraryActive[target.key] === id) {
            delete getSettings().libraryActive[target.key];
            releaseZoomLibrarySource(target.key);
            applySavedAdjustmentsForImageKey(target.key);
        }
        saveSettingsDebounced();
        await renderAvatarGallery();
    } catch (error) {
        console.error('[Avatar Focus] Avatar library delete failed:', error);
        notify('error', '删除失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
        setGalleryBusy(false);
    }
}

function replayBufferedClick(sequence) {
    if (!sequence?.target?.isConnected) {
        return;
    }
    const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: 0,
        clientX: sequence.clientX,
        clientY: sequence.clientY,
        screenX: sequence.screenX,
        screenY: sequence.screenY,
        ctrlKey: sequence.ctrlKey,
        shiftKey: sequence.shiftKey,
        altKey: sequence.altKey,
        metaKey: sequence.metaKey,
        detail: 1,
    });
    replayedClicks.add(click);
    sequence.target.dispatchEvent(click);
}

function finishClickSequence(replay = true) {
    if (!clickSequence) {
        return;
    }
    const sequence = clickSequence;
    clickSequence = null;
    clearTimeout(sequence.timer);
    if (replay) {
        replayBufferedClick(sequence);
    }
}

function handleAvatarClickSequence(event) {
    if (replayedClicks.has(event)
        || !getSettings().tripleClickEnabled
        || editorState) {
        return;
    }

    const image = findAvatarFromInteraction(event.target, event.clientX, event.clientY);
    const descriptor = image ? getReplacementDescriptor(image) : null;
    if (!image || !descriptor) {
        return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const now = Date.now();
    const isContinuation = clickSequence
        && clickSequence.key === descriptor.key
        && now - clickSequence.lastAt <= TRIPLE_CLICK_WINDOW_MS;

    if (!isContinuation) {
        finishClickSequence(true);
        clickSequence = {
            key: descriptor.key,
            image,
            target: event.target,
            count: 1,
            lastAt: now,
            timer: 0,
            clientX: event.clientX,
            clientY: event.clientY,
            screenX: event.screenX,
            screenY: event.screenY,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
        };
    } else {
        clickSequence.count += 1;
        clickSequence.lastAt = now;
        clickSequence.image = image;
        clearTimeout(clickSequence.timer);
    }

    if (clickSequence.count >= 3) {
        const selectedImage = clickSequence.image;
        finishClickSequence(false);
        chooseAvatarReplacement(selectedImage);
        return;
    }

    clickSequence.timer = window.setTimeout(
        () => finishClickSequence(true),
        TRIPLE_CLICK_WINDOW_MS,
    );
}

function copyFrameAppearance(source, preview, frame) {
    const imageStyle = getComputedStyle(source);
    const holderStyle = source.parentElement ? getComputedStyle(source.parentElement) : imageStyle;
    const objectFit = ['cover', 'contain', 'fill', 'none', 'scale-down'].includes(imageStyle.objectFit)
        ? imageStyle.objectFit
        : 'cover';
    preview.style.objectFit = objectFit;
    preview.style.borderRadius = imageStyle.borderRadius;
    frame.style.borderRadius = holderStyle.borderRadius || imageStyle.borderRadius;

    const imageProperties = [
        ['clipPath', 'clipPath'],
        ['webkitClipPath', 'webkitClipPath'],
        ['maskImage', 'maskImage'],
        ['webkitMaskImage', 'webkitMaskImage'],
        ['maskSize', 'maskSize'],
        ['webkitMaskSize', 'webkitMaskSize'],
        ['maskPosition', 'maskPosition'],
        ['webkitMaskPosition', 'webkitMaskPosition'],
        ['maskRepeat', 'maskRepeat'],
        ['webkitMaskRepeat', 'webkitMaskRepeat'],
    ];
    imageProperties.forEach(([targetName, sourceName]) => {
        const value = imageStyle[sourceName];
        if (value && value !== 'none') {
            preview.style[targetName] = value;
        } else {
            preview.style[targetName] = '';
        }
    });

    const holderClip = holderStyle.clipPath || holderStyle.webkitClipPath;
    frame.style.clipPath = holderClip && holderClip !== 'none' ? holderClip : '';
}

function sizePreviewFrame(source, frame) {
    const rect = source.getBoundingClientRect();
    const naturalRatio = source.naturalWidth > 0 && source.naturalHeight > 0
        ? source.naturalWidth / source.naturalHeight
        : 1;
    const ratio = rect.width > 1 && rect.height > 1 ? rect.width / rect.height : naturalRatio;
    const maxWidth = Math.min(window.innerWidth * 0.76, 320);
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const mobileHeightFactor = window.matchMedia('(max-width: 520px)').matches ? 0.36 : 0.45;
    const maxHeight = Math.min(viewportHeight * mobileHeightFactor, 360);
    let width = maxWidth;
    let height = width / Math.max(0.2, ratio);
    if (height > maxHeight) {
        height = maxHeight;
        width = height * ratio;
    }
    frame.style.width = Math.max(120, width) + 'px';
    frame.style.height = Math.max(120, height) + 'px';
}

function updateEditorViewportHeight() {
    const viewport = window.visualViewport;
    const viewportHeight = Math.max(
        1,
        Math.floor(viewport?.height || window.innerHeight || 0),
    );
    const viewportWidth = Math.max(1, Math.floor(viewport?.width || window.innerWidth || 0));
    const viewportTop = Math.max(0, Math.floor(viewport?.offsetTop || 0));
    const viewportLeft = Math.max(0, Math.floor(viewport?.offsetLeft || 0));
    const root = document.documentElement;

    root.style.setProperty('--stafe-viewport-width', viewportWidth + 'px');
    document.documentElement.style.setProperty('--stafe-viewport-height', viewportHeight + 'px');
    root.style.setProperty('--stafe-viewport-top', viewportTop + 'px');
    root.style.setProperty('--stafe-viewport-left', viewportLeft + 'px');
    root.classList.toggle(
        'stafe-compact-viewport',
        viewportWidth <= 700 || window.matchMedia('(pointer: coarse)').matches,
    );
}

function renderEditorPosition(position, applyLive = true) {
    if (!editorState) {
        return;
    }
    const clean = {
        x: roundPosition(position.x),
        y: roundPosition(position.y),
        zoom: roundZoom(position.zoom ?? DEFAULT_ZOOM),
        saturation: roundSaturation(
            position.saturation ?? editorState.draft?.saturation ?? DEFAULT_SATURATION,
        ),
    };
    editorState.draft = clean;
    const preview = document.getElementById('stafe_preview_image');
    const xInput = document.getElementById('stafe_x_position');
    const yInput = document.getElementById('stafe_y_position');
    const zoomInput = document.getElementById('stafe_zoom');
    const saturationInput = document.getElementById('stafe_saturation');
    const xValue = document.getElementById('stafe_x_value');
    const yValue = document.getElementById('stafe_y_value');
    const zoomValue = document.getElementById('stafe_zoom_value');
    const saturationValue = document.getElementById('stafe_saturation_value');
    preview.style.setProperty('object-position', clean.x + '% ' + clean.y + '%', 'important');
    preview.style.setProperty('scale', String(clean.zoom / 100), 'important');
    preview.style.setProperty('transform-origin', clean.x + '% ' + clean.y + '%', 'important');
    preview.style.setProperty(
        'filter',
        [editorState.filterWithoutSaturation, `saturate(${clean.saturation}%)`].filter(Boolean).join(' '),
        'important',
    );
    const previewClipPath = getZoomClipPath(clean);
    if (previewClipPath) {
        preview.style.setProperty('clip-path', previewClipPath, 'important');
    } else {
        preview.style.removeProperty('clip-path');
    }
    xInput.value = String(clean.x);
    yInput.value = String(clean.y);
    zoomInput.value = String(clean.zoom);
    saturationInput.value = String(clean.saturation);
    xValue.textContent = Math.round(clean.x) + '%';
    yValue.textContent = Math.round(clean.y) + '%';
    zoomValue.textContent = clean.zoom + '%';
    saturationValue.textContent = clean.saturation + '%';
    if (applyLive) {
        applyPositionForKey(editorState.key, clean);
        applySaturationForKey(editorState.saturationKey, clean.saturation);
    }
}

function openEditor(image) {
    const editor = document.getElementById('stafe_editor');
    const preview = document.getElementById('stafe_preview_image');
    const frame = document.getElementById('stafe_preview_frame');
    if (!editor || !preview || !frame) {
        notify('error', '调整窗口没有加载成功，请刷新酒馆后再试。');
        return;
    }

    const key = getImageKey(image);
    if (!key) {
        notify('warning', '这个头像没有可识别的图片地址。');
        return;
    }
    const saved = cleanPosition(getSettings().positions[key]);
    const saturationKey = getSaturationKey(image);
    const savedSaturation = cleanSaturation(getSettings().saturations[saturationKey]);
    const start = {
        ...(saved || readComputedPosition(image)),
        saturation: savedSaturation ?? DEFAULT_SATURATION,
    };
    rememberOriginalPosition(image);
    const original = originalObjectPositions.get(image);
    editorState = {
        image,
        key,
        saturationKey,
        initialSaved: saved ? { ...saved } : null,
        initialSaturation: savedSaturation,
        filterWithoutSaturation: original.filterWithoutSaturation,
        draft: { ...start },
        drag: null,
    };

    preview.src = image.currentSrc || image.src;
    preview.alt = getAvatarLabel(image);
    document.getElementById('stafe_avatar_name').textContent = getAvatarLabel(image);
    copyFrameAppearance(image, preview, frame);
    updateEditorViewportHeight();
    sizePreviewFrame(image, frame);
    renderEditorPosition(start, true);

    editor.hidden = false;
    editor.setAttribute('aria-hidden', 'false');
    document.body.classList.add('stafe-modal-open');
    const content = editor.querySelector('.stafe-dialog-content');
    if (content instanceof HTMLElement) {
        content.scrollTop = 0;
    }
    requestAnimationFrame(() => {
        updateEditorViewportHeight();
        sizePreviewFrame(image, frame);
        editor.querySelector('[data-stafe-action="save"]')?.focus();
    });
}

function closeEditor(commit) {
    if (!editorState) {
        return;
    }
    const state = editorState;
    if (commit) {
        getSettings().positions[state.key] = {
            x: roundPosition(state.draft.x),
            y: roundPosition(state.draft.y),
            zoom: roundZoom(state.draft.zoom),
        };
        getSettings().saturations[state.saturationKey] = roundSaturation(state.draft.saturation);
        applyPositionForKey(state.key, state.draft);
        applySaturationForKey(state.saturationKey, state.draft.saturation);
        saveSettingsDebounced();
        updateSavedCount();
        notify('success', '头像位置、缩放与饱和度已保存。');
    } else {
        applyPositionForKey(state.key, state.initialSaved);
        applySaturationForKey(state.saturationKey, state.initialSaturation);
    }

    const editor = document.getElementById('stafe_editor');
    editor.hidden = true;
    editor.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('stafe-modal-open');
    document.getElementById('stafe_preview_frame')?.classList.remove('stafe-dragging');
    editorState = null;
}

function calculatePreviewOverflow(frame, image, zoom = DEFAULT_ZOOM) {
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    const naturalWidth = image.naturalWidth || width;
    const naturalHeight = image.naturalHeight || height;
    const fit = getComputedStyle(image).objectFit;
    let scale = 1;
    if (fit === 'contain') {
        scale = Math.min(width / naturalWidth, height / naturalHeight);
    } else if (fit === 'none') {
        scale = 1;
    } else if (fit === 'scale-down') {
        scale = Math.min(1, Math.min(width / naturalWidth, height / naturalHeight));
    } else if (fit === 'fill') {
        const zoomScale = roundZoom(zoom) / 100;
        return {
            x: Math.max(0, width * zoomScale - width),
            y: Math.max(0, height * zoomScale - height),
        };
    } else {
        scale = Math.max(width / naturalWidth, height / naturalHeight);
    }
    const zoomScale = roundZoom(zoom) / 100;
    return {
        x: Math.max(0, naturalWidth * scale * zoomScale - width),
        y: Math.max(0, naturalHeight * scale * zoomScale - height),
    };
}

function bindEditor() {
    const editor = document.getElementById('stafe_editor');
    const frame = document.getElementById('stafe_preview_frame');
    const preview = document.getElementById('stafe_preview_image');
    const xInput = document.getElementById('stafe_x_position');
    const yInput = document.getElementById('stafe_y_position');
    const zoomInput = document.getElementById('stafe_zoom');
    const saturationInput = document.getElementById('stafe_saturation');
    if (!editor || !frame || !preview || !xInput || !yInput || !zoomInput || !saturationInput) {
        return;
    }

    editor.addEventListener('click', (event) => {
        const action = event.target.closest('[data-stafe-action]')?.dataset.stafeAction;
        if (action === 'save') {
            closeEditor(true);
        } else if (action === 'cancel') {
            closeEditor(false);
        } else if (action === 'center') {
            renderEditorPosition({ x: 50, y: 50, zoom: editorState.draft.zoom });
        } else if (action === 'natural-color') {
            renderEditorPosition({
                x: editorState.draft.x,
                y: editorState.draft.y,
                zoom: editorState.draft.zoom,
                saturation: DEFAULT_SATURATION,
            });
        }
    });

    xInput.addEventListener('input', () => {
        if (editorState) {
            renderEditorPosition({
                x: Number(xInput.value),
                y: editorState.draft.y,
                zoom: editorState.draft.zoom,
            });
        }
    });
    yInput.addEventListener('input', () => {
        if (editorState) {
            renderEditorPosition({
                x: editorState.draft.x,
                y: Number(yInput.value),
                zoom: editorState.draft.zoom,
            });
        }
    });
    zoomInput.addEventListener('input', () => {
        if (editorState) {
            renderEditorPosition({
                x: editorState.draft.x,
                y: editorState.draft.y,
                zoom: Number(zoomInput.value),
            });
        }
    });
    saturationInput.addEventListener('input', () => {
        if (editorState) {
            renderEditorPosition({
                x: editorState.draft.x,
                y: editorState.draft.y,
                zoom: editorState.draft.zoom,
                saturation: Number(saturationInput.value),
            });
        }
    });

    frame.addEventListener('pointerdown', (event) => {
        if (!editorState || (event.pointerType === 'mouse' && event.button !== 0)) {
            return;
        }
        event.preventDefault();
        const overflow = calculatePreviewOverflow(frame, preview, editorState.draft.zoom);
        editorState.drag = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: editorState.draft.x,
            startY: editorState.draft.y,
            overflow,
        };
        frame.classList.add('stafe-dragging');
        frame.setPointerCapture(event.pointerId);
    });

    frame.addEventListener('pointermove', (event) => {
        const drag = editorState?.drag;
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        event.preventDefault();
        const deltaX = event.clientX - drag.startClientX;
        const deltaY = event.clientY - drag.startClientY;
        const denominatorX = Math.max(drag.overflow.x, frame.clientWidth * 0.32);
        const denominatorY = Math.max(drag.overflow.y, frame.clientHeight * 0.32);
        const next = {
            x: drag.overflow.x > 0.5 ? drag.startX - (deltaX / denominatorX) * 100 : drag.startX,
            y: drag.overflow.y > 0.5 ? drag.startY - (deltaY / denominatorY) * 100 : drag.startY,
            zoom: editorState.draft.zoom,
        };
        renderEditorPosition(next);
    });

    const finishDrag = (event) => {
        if (!editorState?.drag || editorState.drag.pointerId !== event.pointerId) {
            return;
        }
        editorState.drag = null;
        frame.classList.remove('stafe-dragging');
        if (frame.hasPointerCapture(event.pointerId)) {
            frame.releasePointerCapture(event.pointerId);
        }
    };
    frame.addEventListener('pointerup', finishDrag);
    frame.addEventListener('pointercancel', finishDrag);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && editorState) {
            closeEditor(false);
        }
    });
}

function clearPendingPress() {
    if (!pendingPress) {
        return;
    }
    clearTimeout(pendingPress.timer);
    clearTimeout(pendingPress.hintTimer);
    pendingPress.image.classList.remove('stafe-holding');
    pendingPress.feedbackElement?.classList.remove('stafe-holding-target');
    pendingPress.feedbackElement?.classList.remove('stafe-gesture-surface');
    pendingPress = null;
}

function beginLongPress(event) {
    if (!getSettings().enabled || editorState || event.isPrimary === false) {
        return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
    }
    const image = findAvatarFromInteraction(event.target, event.clientX, event.clientY);
    if (!image) {
        return;
    }

    clearPendingPress();
    const key = getImageKey(image);
    const press = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        image,
        feedbackElement: findAvatarFeedbackElement(event.target, image),
        key,
        startX: event.clientX,
        startY: event.clientY,
        timer: 0,
        hintTimer: 0,
    };
    press.feedbackElement?.classList.add('stafe-gesture-surface');
    press.hintTimer = window.setTimeout(() => {
        image.classList.add('stafe-holding');
        press.feedbackElement?.classList.add('stafe-holding-target');
    }, 140);
    press.timer = window.setTimeout(() => {
        if (pendingPress !== press) {
            return;
        }
        image.classList.remove('stafe-holding');
        press.feedbackElement?.classList.remove('stafe-holding-target');
        press.feedbackElement?.classList.remove('stafe-gesture-surface');
        pendingPress = null;
        suppressClickUntil = Date.now() + 900;
        suppressClickKey = key;
        try {
            navigator.vibrate?.(18);
        } catch {
            // Vibration is optional and may be blocked by the host.
        }
        openEditor(image);
    }, Number(getSettings().longPressMs));
    pendingPress = press;
}

function moveLongPress(event) {
    if (!pendingPress || pendingPress.pointerId !== event.pointerId) {
        return;
    }
    const distance = Math.hypot(
        event.clientX - pendingPress.startX,
        event.clientY - pendingPress.startY,
    );
    const cancelDistance = pendingPress.pointerType === 'touch' ? 20 : 12;
    if (distance > cancelDistance) {
        clearPendingPress();
    }
}

function bindLongPress() {
    document.addEventListener('pointerdown', beginLongPress, true);
    document.addEventListener('pointermove', moveLongPress, true);
    document.addEventListener('pointerup', clearPendingPress, true);
    document.addEventListener('pointercancel', clearPendingPress, true);
    document.addEventListener('scroll', clearPendingPress, true);
    document.addEventListener('contextmenu', (event) => {
        const image = findAvatarFromInteraction(event.target, event.clientX, event.clientY);
        const shouldSuppress = image && (
            pendingPress?.image === image
            || (Date.now() < suppressClickUntil && getImageKey(image) === suppressClickKey)
        );
        if (shouldSuppress) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    document.addEventListener('click', (event) => {
        if (Date.now() >= suppressClickUntil) {
            return;
        }
        const image = findAvatarFromInteraction(event.target, event.clientX, event.clientY);
        if (image && getImageKey(image) === suppressClickKey) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    document.addEventListener('dragstart', (event) => {
        if (pendingPress && findAvatarFromInteraction(event.target, event.clientX, event.clientY) === pendingPress.image) {
            event.preventDefault();
        }
    }, true);

    if (!('PointerEvent' in window)) {
        document.addEventListener('touchstart', (event) => {
            if (event.touches.length !== 1 || pendingPress) {
                return;
            }
            const touch = event.touches[0];
            beginLongPress({
                target: event.target,
                isPrimary: true,
                pointerType: 'touch',
                button: 0,
                pointerId: 'touch-' + touch.identifier,
                clientX: touch.clientX,
                clientY: touch.clientY,
            });
        }, { capture: true, passive: true });
        document.addEventListener('touchmove', (event) => {
            const touch = Array.from(event.touches).find(
                (item) => 'touch-' + item.identifier === pendingPress?.pointerId,
            );
            if (touch) {
                moveLongPress({
                    pointerId: pendingPress.pointerId,
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                });
            }
        }, { capture: true, passive: true });
        document.addEventListener('touchend', clearPendingPress, true);
        document.addEventListener('touchcancel', clearPendingPress, true);
    }
}

function bindTripleClickReplacement() {
    document.addEventListener('click', handleAvatarClickSequence, true);
    const input = document.getElementById('stafe_replace_input');
    input?.addEventListener('change', (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) {
            return;
        }
        void importGalleryFiles(files).finally(() => {
            event.target.value = '';
        });
    });
}

function bindAvatarGallery() {
    const gallery = document.getElementById('stafe_gallery');
    const input = document.getElementById('stafe_replace_input');
    const carousel = document.getElementById('stafe_gallery_carousel');
    if (!gallery || !(input instanceof HTMLInputElement)) {
        return;
    }

    let swipeStart = null;

    gallery.addEventListener('click', (event) => {
        const actionTarget = event.target instanceof Element
            ? event.target.closest('[data-stafe-gallery-action]')
            : null;
        const action = actionTarget?.dataset.stafeGalleryAction;
        if (!action) {
            return;
        }
        if (action === 'close') {
            closeAvatarGallery();
        } else if (action === 'import') {
            input.value = '';
            input.click();
        } else if (action === 'previous') {
            moveGalleryCursor(-1);
        } else if (action === 'next') {
            moveGalleryCursor(1);
        } else if (action === 'select') {
            void selectGalleryRecord();
        } else if (action === 'delete') {
            void removeGalleryRecord();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (gallery.hidden) {
            return;
        }
        if (event.key === 'Escape') {
            closeAvatarGallery();
        } else if (event.key === 'ArrowLeft') {
            moveGalleryCursor(-1);
        } else if (event.key === 'ArrowRight') {
            moveGalleryCursor(1);
        }
    });

    carousel?.addEventListener('pointerdown', (event) => {
        if (event.target instanceof Element && event.target.closest('button')) {
            return;
        }
        swipeStart = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
        };
    });
    carousel?.addEventListener('pointerup', (event) => {
        if (!swipeStart || swipeStart.pointerId !== event.pointerId) {
            return;
        }
        const deltaX = event.clientX - swipeStart.x;
        const deltaY = event.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.abs(deltaX) >= 44 && Math.abs(deltaX) > Math.abs(deltaY)) {
            moveGalleryCursor(deltaX < 0 ? 1 : -1);
        }
    });
    carousel?.addEventListener('pointercancel', () => {
        swipeStart = null;
    });
}

function queueMutationImage(image) {
    if (isAvatarImage(image)) {
        mutationImages.add(image);
    }
    if (mutationFrame) {
        return;
    }
    mutationFrame = requestAnimationFrame(() => {
        mutationFrame = 0;
        mutationImages.forEach(applySavedPosition);
        mutationImages.clear();
    });
}

function observeAvatars() {
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                queueMutationImage(mutation.target);
                continue;
            }
            mutation.addedNodes.forEach((node) => {
                if (!(node instanceof Element)) {
                    return;
                }
                if (node instanceof HTMLImageElement) {
                    queueMutationImage(node);
                }
                node.querySelectorAll?.(AVATAR_SELECTOR).forEach(queueMutationImage);
            });
        }
        if (!document.getElementById('stafe_settings')) {
            void installSettingsPanel();
        }
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset'],
    });
}

function updateSavedCount() {
    const target = document.getElementById('stafe_saved_count');
    if (target) {
        const settings = getSettings();
        const saturationKeys = Object.keys(settings.saturations);
        const savedImages = new Set(saturationKeys);
        Object.keys(settings.positions).forEach((positionKey) => {
            if (!saturationKeys.some((key) => key === positionKey || key.startsWith(positionKey + '::library::'))) {
                savedImages.add(positionKey);
            }
        });
        target.textContent = String(savedImages.size);
    }
}

function clearAllSavedPositions() {
    const settings = getSettings();
    const count = Object.keys(settings.positions).length + Object.keys(settings.saturations).length;
    if (!count) {
        notify('info', '还没有保存过头像调整。');
        return;
    }
    if (!window.confirm('确定要让全部头像恢复主题默认的取景、缩放和颜色吗？')) {
        return;
    }
    settings.positions = {};
    settings.saturations = {};
    restoreAllPositions();
    saveSettingsDebounced();
    updateSavedCount();
    notify('success', '全部头像已恢复主题默认显示。');
}

async function installSettingsPanel() {
    if (settingsPanelInstalling || settingsPanelUnavailable || document.getElementById('stafe_settings')) {
        return;
    }
    const target = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!target) {
        return;
    }
    settingsPanelInstalling = true;
    try {
        const html = await loadOwnTemplate('settings');
        target.insertAdjacentHTML('beforeend', html);
        const enabled = document.getElementById('stafe_enabled');
        const tripleClickEnabled = document.getElementById('stafe_triple_click_enabled');
        const longPress = document.getElementById('stafe_long_press');
        enabled.checked = getSettings().enabled;
        tripleClickEnabled.checked = getSettings().tripleClickEnabled;
        longPress.value = String(getSettings().longPressMs);
        enabled.addEventListener('change', () => {
            getSettings().enabled = enabled.checked;
            if (enabled.checked) {
                applyAllSavedPositions();
                notify('success', '长按头像调整已启用。');
            } else {
                clearPendingPress();
                restoreAllPositions();
                if (editorState) {
                    closeEditor(false);
                }
            }
            saveSettingsDebounced();
        });
        tripleClickEnabled.addEventListener('change', () => {
            getSettings().tripleClickEnabled = tripleClickEnabled.checked;
            if (!tripleClickEnabled.checked) {
                finishClickSequence(true);
            }
            saveSettingsDebounced();
        });
        longPress.addEventListener('change', () => {
            getSettings().longPressMs = Number(longPress.value);
            saveSettingsDebounced();
        });
        document.getElementById('stafe_clear_all')?.addEventListener('click', clearAllSavedPositions);
        updateSavedCount();
    } catch (error) {
        settingsPanelUnavailable = true;
        console.error('[Avatar Focus] Failed to install settings panel:', error);
    } finally {
        settingsPanelInstalling = false;
    }
}

async function installEditor() {
    if (document.getElementById('stafe_editor')) {
        return;
    }
    const html = await loadOwnTemplate('editor');
    document.body.insertAdjacentHTML('beforeend', html);
    bindEditor();
}

async function installAvatarGallery() {
    if (document.getElementById('stafe_gallery')) {
        return;
    }
    const html = await loadOwnTemplate('gallery');
    document.body.insertAdjacentHTML('beforeend', html);
    bindAvatarGallery();
}

async function initialize() {
    getSettings();
    updateEditorViewportHeight();
    window.addEventListener('resize', updateEditorViewportHeight, { passive: true });
    window.visualViewport?.addEventListener('resize', updateEditorViewportHeight, { passive: true });
    window.visualViewport?.addEventListener('scroll', updateEditorViewportHeight, { passive: true });
    try {
        await installEditor();
        await installAvatarGallery();
        await installSettingsPanel();
    } catch (error) {
        console.error('[Avatar Focus] UI initialization failed:', error);
    }
    applyAllSavedPositions();
    bindLongPress();
    bindTripleClickReplacement();
    observeAvatars();
    console.info('[Avatar Focus] Ready. Long-press to adjust; triple-click to open avatar library.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initialize(), { once: true });
} else {
    void initialize();
}
