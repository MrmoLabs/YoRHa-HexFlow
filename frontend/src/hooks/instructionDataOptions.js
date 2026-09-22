// Explicit option contract for useInstructionData (page <-> hook).
// Every key the pages may pass, its type, and the two ownership modes:
//   - SHARED (受管) mode: pass instructions + setInstructions -> the parent
//     owns the list; hook writes through setExternalInstructions and NEVER
//     fires onWebUpdate (avoids feedback loops into the same state).
//   - SELF (自管) mode: no setInstructions -> hook owns internal state and
//     mirrors reloads out through onWebUpdate (optional).
// Invalid usage degrades gracefully (drop the bad key + warn) instead of
// crashing later; valid calls are returned unchanged (behavior-neutral).

export const INSTRUCTION_DATA_OPTION_KEYS = [
    'instructions', // Array|null — external list (SHARED) or omit (SELF)
    'setInstructions', // Function — parent state setter (SHARED mode switch)
    'onWebUpdate', // Function — notify parent of fresh lists (SELF mode)
    'fetchInstructions', // Function (search?: string) => Promise<Array> — overrides api.getInstructions
    'disableInitialLoad' // Boolean — skip the mount-time load (SHARED pages reload themselves)
];

const isFn = (v) => typeof v === 'function';
const isArr = (v) => Array.isArray(v);

/**
 * Normalize + validate the raw options passed to useInstructionData.
 *
 * @param {Function|Object|null|undefined} raw — legacy function form is
 *   treated as `{ onWebUpdate: fn }`; objects are validated key by key.
 * @param {(msg: string) => void} [warn] — warning sink (injectable for tests).
 * @returns {{
 *   instructions: Array|null,
 *   setInstructions: Function|null,
 *   onWebUpdate: Function|null,
 *   fetchInstructions: Function|null,
 *   disableInitialLoad: boolean
 * }} a fully-populated options object (all keys present).
 */
export function normalizeInstructionDataOptions(raw, warn = console.warn) {
    // Legacy call shape: useInstructionData(onWebUpdate)
    if (isFn(raw)) {
        return {
            instructions: null,
            setInstructions: null,
            onWebUpdate: raw,
            fetchInstructions: null,
            disableInitialLoad: false
        };
    }

    if (raw !== null && raw !== undefined && (typeof raw !== 'object' || isArr(raw))) {
        warn(`[useInstructionData] 非对象选项已被忽略：${String(raw)}`);
    }
    const source = (raw && typeof raw === 'object' && !isArr(raw)) ? raw : {};

    for (const key of Object.keys(source)) {
        if (!INSTRUCTION_DATA_OPTION_KEYS.includes(key)) {
            warn(`[useInstructionData] 未知选项 "${key}" 已忽略（已知键：${INSTRUCTION_DATA_OPTION_KEYS.join(', ')}）`);
        }
    }

    const options = {
        instructions: null,
        setInstructions: null,
        onWebUpdate: null,
        fetchInstructions: null,
        disableInitialLoad: false
    };

    if (source.instructions !== undefined && source.instructions !== null) {
        if (isArr(source.instructions)) {
            options.instructions = source.instructions;
        } else {
            warn('[useInstructionData] instructions 必须是数组，已忽略（回退内部状态）');
        }
    }

    if (source.setInstructions !== undefined && source.setInstructions !== null) {
        if (isFn(source.setInstructions)) {
            options.setInstructions = source.setInstructions;
        } else {
            warn('[useInstructionData] setInstructions 必须是函数，已忽略（回退自管模式）');
        }
    }

    if (source.onWebUpdate !== undefined && source.onWebUpdate !== null) {
        if (isFn(source.onWebUpdate)) {
            options.onWebUpdate = source.onWebUpdate;
        } else {
            warn('[useInstructionData] onWebUpdate 必须是函数，已忽略');
        }
    }

    if (source.fetchInstructions !== undefined && source.fetchInstructions !== null) {
        if (isFn(source.fetchInstructions)) {
            options.fetchInstructions = source.fetchInstructions;
        } else {
            warn('[useInstructionData] fetchInstructions 必须是函数，已忽略（回退 api.getInstructions）');
        }
    }

    if (source.disableInitialLoad !== undefined && source.disableInitialLoad !== null) {
        options.disableInitialLoad = Boolean(source.disableInitialLoad);
    }

    return options;
}
