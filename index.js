import {
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

const MODULE_NAME = 'sillytavern-avatar-focus';
const RESOURCE_NAME = 'third-party/sillytavern-avatar-focus';
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
});
const TRIPLE_CLICK_WINDOW_MS = 420;

const originalObjectPositions = new WeakMap();
const replayedClicks = new WeakSet();
let editorState = null;
let pendingPress = null;
let suppressClickUntil = 0;
let suppressClickKey = '';
let clickSequence = null;
let replacementTarget = null;
let settingsPanelInstalling = false;
let mutationFrame = 0;
const mutationImages = new Set();

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
    return current;
}

function notify(level, message) {
    const toast = globalThis.toastr?.[level];
    if (typeof toast === 'function') {
        toast(message, '头像取景调整');
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
    return { x: clamp(x), y: clamp(y) };
}

function roundPosition(value) {
    return Math.round(clamp(value) * 10) / 10;
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
    if (direct) {
        return direct;
    }
    if (!(target instanceof Element)
        || !Number.isFinite(clientX)
        || !Number.isFinite(clientY)) {
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
                containsPoint: pointInsideRect(clientX, clientY, rect, 18),
            };
        })
        .filter((candidate) => candidate.containsPoint)
        .sort((left, right) => right.score - left.score);
    if (candidates.length) {
        return candidates[0].image;
    }

    const wrapper = message.querySelector('.mesAvatarWrapper');
    if (wrapper && pointInsideRect(clientX, clientY, wrapper.getBoundingClientRect(), 24)) {
        return bestAvatarImage(message.querySelectorAll('img'));
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

function rememberOriginalPosition(image) {
    if (!originalObjectPositions.has(image)) {
        originalObjectPositions.set(image, {
            value: image.style.getPropertyValue('object-position'),
            priority: image.style.getPropertyPriority('object-position'),
        });
    }
}

function restoreImagePosition(image) {
    rememberOriginalPosition(image);
    const original = originalObjectPositions.get(image);
    if (original.value) {
        image.style.setProperty('object-position', original.value, original.priority);
    } else {
        image.style.removeProperty('object-position');
    }
}

function setImagePosition(image, position) {
    rememberOriginalPosition(image);
    image.style.setProperty(
        'object-position',
        roundPosition(position.x) + '% ' + roundPosition(position.y) + '%',
        'important',
    );
}

function applySavedPosition(image) {
    if (!isAvatarImage(image)) {
        return;
    }
    if (!getSettings().enabled) {
        restoreImagePosition(image);
        return;
    }
    const position = cleanPosition(getSettings().positions[getImageKey(image)]);
    if (position) {
        setImagePosition(image, position);
    } else {
        restoreImagePosition(image);
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
    forEachAvatar(restoreImagePosition);
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
        return { x: value, y: value };
    }
    return {
        x: parsePositionToken(tokens[0], 'x'),
        y: parsePositionToken(tokens[1], 'y'),
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
        };
    }
    if (key.startsWith('persona:')) {
        return {
            kind: 'persona',
            key,
            avatarId: key.slice('persona:'.length),
            label: getAvatarLabel(image),
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
        notify('warning', '这个头像不是角色或用户头像，无法直接替换。');
        return;
    }

    if (descriptor.kind === 'persona') {
        const input = document.getElementById('avatar_upload_file');
        const overwrite = document.getElementById('avatar_upload_overwrite');
        if (!(input instanceof HTMLInputElement) || !(overwrite instanceof HTMLInputElement)) {
            notify('warning', '请先打开一次“用户设置 → 角色扮演”，让酒馆加载用户头像管理器。');
            return;
        }
        input.value = '';
        overwrite.value = descriptor.avatarId;
        input.click();
        return;
    }

    const input = document.getElementById('stafe_replace_input');
    if (!(input instanceof HTMLInputElement)) {
        notify('error', '头像文件选择器没有加载成功，请刷新酒馆后再试。');
        return;
    }
    replacementTarget = descriptor;
    input.value = '';
    input.click();
}

async function replaceCharacterAvatar(file) {
    const target = replacementTarget;
    replacementTarget = null;
    if (!target || target.kind !== 'character') {
        return;
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
    } catch (error) {
        console.error('[Avatar Focus] Character avatar replacement failed:', error);
        notify('error', '头像替换失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
        if (input instanceof HTMLInputElement) {
            input.disabled = false;
            input.value = '';
        }
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
    const viewportHeight = Math.max(
        320,
        Math.round(window.visualViewport?.height || window.innerHeight || 0),
    );
    document.documentElement.style.setProperty('--stafe-viewport-height', viewportHeight + 'px');
}

function renderEditorPosition(position, applyLive = true) {
    if (!editorState) {
        return;
    }
    const clean = { x: roundPosition(position.x), y: roundPosition(position.y) };
    editorState.draft = clean;
    const preview = document.getElementById('stafe_preview_image');
    const xInput = document.getElementById('stafe_x_position');
    const yInput = document.getElementById('stafe_y_position');
    const xValue = document.getElementById('stafe_x_value');
    const yValue = document.getElementById('stafe_y_value');
    preview.style.setProperty('object-position', clean.x + '% ' + clean.y + '%', 'important');
    xInput.value = String(clean.x);
    yInput.value = String(clean.y);
    xValue.textContent = Math.round(clean.x) + '%';
    yValue.textContent = Math.round(clean.y) + '%';
    if (applyLive) {
        applyPositionForKey(editorState.key, clean);
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
    const start = saved || readComputedPosition(image);
    editorState = {
        image,
        key,
        initialSaved: saved ? { ...saved } : null,
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
    const dialog = editor.querySelector('.stafe-dialog');
    if (dialog instanceof HTMLElement) {
        dialog.scrollTop = 0;
    }
    requestAnimationFrame(() => {
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
        };
        applyPositionForKey(state.key, state.draft);
        saveSettingsDebounced();
        updateSavedCount();
        notify('success', '头像位置已保存。');
    } else {
        applyPositionForKey(state.key, state.initialSaved);
    }

    const editor = document.getElementById('stafe_editor');
    editor.hidden = true;
    editor.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('stafe-modal-open');
    document.getElementById('stafe_preview_frame')?.classList.remove('stafe-dragging');
    editorState = null;
}

function calculatePreviewOverflow(frame, image) {
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
        return { x: 0, y: 0 };
    } else {
        scale = Math.max(width / naturalWidth, height / naturalHeight);
    }
    return {
        x: Math.max(0, naturalWidth * scale - width),
        y: Math.max(0, naturalHeight * scale - height),
    };
}

function bindEditor() {
    const editor = document.getElementById('stafe_editor');
    const frame = document.getElementById('stafe_preview_frame');
    const preview = document.getElementById('stafe_preview_image');
    const xInput = document.getElementById('stafe_x_position');
    const yInput = document.getElementById('stafe_y_position');
    if (!editor || !frame || !preview || !xInput || !yInput) {
        return;
    }

    editor.addEventListener('click', (event) => {
        const action = event.target.closest('[data-stafe-action]')?.dataset.stafeAction;
        if (action === 'save') {
            closeEditor(true);
        } else if (action === 'cancel') {
            closeEditor(false);
        } else if (action === 'center') {
            renderEditorPosition({ x: 50, y: 50 });
        }
    });

    xInput.addEventListener('input', () => {
        if (editorState) {
            renderEditorPosition({ x: Number(xInput.value), y: editorState.draft.y });
        }
    });
    yInput.addEventListener('input', () => {
        if (editorState) {
            renderEditorPosition({ x: editorState.draft.x, y: Number(yInput.value) });
        }
    });

    frame.addEventListener('pointerdown', (event) => {
        if (!editorState || (event.pointerType === 'mouse' && event.button !== 0)) {
            return;
        }
        event.preventDefault();
        const overflow = calculatePreviewOverflow(frame, preview);
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
        const file = event.target.files?.[0];
        if (!file) {
            replacementTarget = null;
            return;
        }
        void replaceCharacterAvatar(file);
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
        target.textContent = String(Object.keys(getSettings().positions).length);
    }
}

function clearAllSavedPositions() {
    const count = Object.keys(getSettings().positions).length;
    if (!count) {
        notify('info', '还没有保存过头像位置。');
        return;
    }
    if (!window.confirm('确定要让全部 ' + count + ' 个头像恢复主题默认位置吗？')) {
        return;
    }
    getSettings().positions = {};
    restoreAllPositions();
    saveSettingsDebounced();
    updateSavedCount();
    notify('success', '全部头像已恢复主题默认位置。');
}

async function installSettingsPanel() {
    if (settingsPanelInstalling || document.getElementById('stafe_settings')) {
        return;
    }
    const target = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!target) {
        return;
    }
    settingsPanelInstalling = true;
    try {
        const html = await renderExtensionTemplateAsync(RESOURCE_NAME, 'settings');
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
        console.error('[Avatar Focus] Failed to install settings panel:', error);
    } finally {
        settingsPanelInstalling = false;
    }
}

async function installEditor() {
    if (document.getElementById('stafe_editor')) {
        return;
    }
    const html = await renderExtensionTemplateAsync(RESOURCE_NAME, 'editor');
    document.body.insertAdjacentHTML('beforeend', html);
    bindEditor();
}

async function initialize() {
    getSettings();
    updateEditorViewportHeight();
    window.addEventListener('resize', updateEditorViewportHeight, { passive: true });
    window.visualViewport?.addEventListener('resize', updateEditorViewportHeight, { passive: true });
    try {
        await installEditor();
        await installSettingsPanel();
    } catch (error) {
        console.error('[Avatar Focus] UI initialization failed:', error);
    }
    applyAllSavedPositions();
    bindLongPress();
    bindTripleClickReplacement();
    observeAvatars();
    console.info('[Avatar Focus] Ready. Long-press to adjust; triple-click to replace.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initialize(), { once: true });
} else {
    void initialize();
}
