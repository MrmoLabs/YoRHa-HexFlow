// A1-a: synthesize a LENGTH_CALC formula from parameter_config.refs — the
// PERSISTED counterpart of the instruction-page Σ preview (useInstructionLanes
// refs→formula inference). Mirrors that口径: dedupe refs, resolve each ref id
// to the target field's name (label fallback), join with ' + '.
// Stricter than the preview on purpose: a dangling ref / nameless field /
// empty refs → null — never persist a formula containing a raw UUID token
// (it can't evaluate, would show "??" forever). Fix the refs first.
//
// @param {Array<string>} refs field ids from parameter_config.refs
// @param {Array<{id: string, name?: string, label?: string}>} fields all instruction fields
// @returns {string|null} "[A] + [B]" / "[A]" — or null when synthesis is unsafe
export function synthesizeFormula(refs, fields) {
    if (!Array.isArray(refs) || refs.length === 0) return null;
    if (!Array.isArray(fields) || fields.length === 0) return null;

    const fieldById = new Map(fields.map((f) => [f.id, f]));
    const parts = [];
    for (const rid of [...new Set(refs)]) {
        const target = fieldById.get(rid);
        if (!target) return null; // dangling ref — fix references first
        const name = target.name || target.label;
        if (!name) return null; // nameless field → no evaluable [Name] token
        parts.push(`[${name}]`);
    }
    return parts.length > 0 ? parts.join(' + ') : null;
}
