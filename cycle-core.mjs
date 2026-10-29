// Host-independent rules. Host event provenance and live gates: DEVELOPMENT.md.
export function adjustmentKey(owner, activeId) {
    return activeId ? owner + '::library::' + activeId : owner;
}

export function migratePositions(settings) {
    let changed = false;
    for (const [owner, id] of Object.entries(settings.libraryActive)) {
        if (!id || !Object.hasOwn(settings.positions, owner)) continue;
        const key = adjustmentKey(owner, id);
        if (!Object.hasOwn(settings.positions, key)) settings.positions[key] = { ...settings.positions[owner] };
        delete settings.positions[owner];
        changed = true;
    }
    return changed;
}

export function normalizeCycle(value = {}) {
    const every = Number(value?.every);
    return {
        enabled: value?.enabled === true,
        every: Number.isSafeInteger(every) && every > 0 ? every : 3,
        mode: value?.mode === 'random' ? 'random' : 'sequence',
        progress: Number.isSafeInteger(value?.progress) && value.progress >= 0 ? value.progress : 0,
        remaining: Array.isArray(value?.remaining) ? [...new Set(value.remaining.filter(x => typeof x === 'string'))] : [],
    };
}

export function nextCycleImage(ids, current, config, random = Math.random) {
    ids = [...new Set(ids)];
    if (ids.length < 2) return null;
    if (config.mode !== 'random') {
        return { id: ids[(ids.indexOf(current) + 1) % ids.length], remaining: [] };
    }
    let remaining = config.remaining.filter(id => ids.includes(id));
    if (!remaining.some(id => id !== current)) remaining = [...ids];
    const choices = remaining.filter(id => id !== current);
    const chosen = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
    const index = remaining.indexOf(chosen);
    const [id] = remaining.splice(index, 1);
    return { id, remaining };
}

export function chatIdentity(context) {
    const id = context?.chatId;
    if (typeof id !== 'string' || !id) return '';
    const owner = context.groupId ? 'group:' + context.groupId : context.characters?.[context.characterId]?.avatar;
    return owner ? JSON.stringify([owner, id]) : '';
}

const isNewReplyType = type => type === undefined || type === null || type === '' || type === 'normal';

export function createReplyTracker() {
    let pending = null;
    return {
        start(context, type, dryRun) {
            pending = null;
            const identity = chatIdentity(context);
            // Native group regeneration is re-emitted as normal generation by core.
            // A multi-person character card is still a normal single-card chat.
            if (dryRun || context?.groupId || !identity || !Array.isArray(context.chat) || !isNewReplyType(type)) return;
            pending = { identity, chat: context.chat, length: context.chat.length, seen: new Set(context.chat) };
        },
        clear() { pending = null; },
        end(context) {
            // Core streaming unlocks the UI (GENERATION_ENDED) before final rendering.
            const stream = context?.streamingProcessor;
            if (!stream?.isFinished || stream.isStopped || stream.abortController?.signal?.aborted) pending = null;
        },
        accept(context, messageId, type) {
            if (!pending || !isNewReplyType(type) || !Number.isInteger(messageId)
                || chatIdentity(context) !== pending.identity || context.chat !== pending.chat
                || messageId < pending.length) return null;
            const message = context.chat[messageId];
            const stream = context.streamingProcessor;
            if (!message || pending.seen.has(message) || message.is_user !== false || message.is_system
                || typeof message.mes !== 'string' || !message.mes.trim() || !message.gen_finished
                || !Number.isFinite(new Date(message.gen_finished).getTime())
                || stream?.isStopped || stream?.abortController?.signal?.aborted) return null;
            const avatar = context.groupId ? message.original_avatar : context.characters?.[context.characterId]?.avatar;
            if (typeof avatar !== 'string' || !avatar || avatar === 'none') return null;
            // Group messages must identify an actual card; never match by display name.
            if (context.groupId && !context.characters?.some(character => character.avatar === avatar)) return null;
            const identity = pending.identity;
            pending = null;
            return { key: 'avatar:' + avatar, identity };
        },
    };
}
