// Phase 2 (P2-1): instruction duplication — pure functions.
//
// Backend contract (backend/routers/instruction.py):
//   - POST /instructions/ ALWAYS mints the instruction id (uuid4); the payload
//     carries no id;
//   - name AND code must each be unique against existing rows (400 otherwise)
//     → the copy derives both with an escalating suffix over the loaded list;
//   - field ids are taken from the payload as-is → a duplicate MUST mint fresh
//     field/bit ids or it would collide with the source's primary keys.
import { v4 as uuidv4 } from 'uuid';
import { normalizeInstructionPayload } from './normalizeInstruction';

/**
 * Build a POST payload that duplicates `source` as a brand-new instruction.
 * Self-contained by construction: parent_id / repeat_ref_id / refs are remapped
 * onto the copy's fresh ids (a ref left pointing into the source instruction
 * would trip E2 REF_DANGLING on save); refs that cannot resolve are dropped.
 *
 * @param {object} source instruction (as returned by GET /instructions)
 * @param {Array<{name?:string, code?:string}>} existingInstructions for suffix uniqueness
 * @param {() => string} genId id mint (injectable for tests)
 */
/**
 * Fresh ids for every field/bit + remap of all intra-instruction links
 * (parent_id / repeat_ref_id / refs). Unresolvable refs are dropped so the
 * clone is self-contained and E2-safe; id-less fields still get fresh ids.
 * Shared by instruction duplication (P2-1) and JSON import (P3-2).
 */
export function cloneFieldsForNewInstruction(fields, genId = uuidv4) {
    const idMap = new Map();
    fields.forEach(f => { if (f.id && !idMap.has(f.id)) idMap.set(f.id, genId()); });
    return fields.map(f => {
        const parameter_config = { ...f.parameter_config };
        if (Array.isArray(parameter_config.refs)) {
            parameter_config.refs = parameter_config.refs
                .filter(r => idMap.has(r))
                .map(r => idMap.get(r));
        }
        return {
            ...f,
            id: (f.id && idMap.get(f.id)) || genId(),
            parent_id: f.parent_id && idMap.has(f.parent_id) ? idMap.get(f.parent_id) : null,
            repeat_ref_id: f.repeat_ref_id && idMap.has(f.repeat_ref_id) ? idMap.get(f.repeat_ref_id) : null,
            parameter_config,
            bits: (f.bits || []).map(b => ({ ...b, id: genId() })),
        };
    });
}

export function buildDuplicateInstructionPayload(source, existingInstructions = [], genId = uuidv4) {
    const payload = normalizeInstructionPayload(source);
    const fields = cloneFieldsForNewInstruction(payload.fields, genId);

    // Unique name/code against the loaded list (backend rejects duplicates).
    const names = new Set(existingInstructions.map(i => String(i.name || '').trim()));
    const codes = new Set(existingInstructions.map(i => String(i.code || '').trim()));

    let name = `${payload.name} (副本)`;
    if (names.has(name)) {
        let n = 2;
        while (names.has(`${payload.name} (副本${n})`)) n += 1;
        name = `${payload.name} (副本${n})`;
    }
    let code = `${payload.code}-COPY`;
    if (codes.has(code)) {
        let n = 2;
        while (codes.has(`${payload.code}-COPY${n}`)) n += 1;
        code = `${payload.code}-COPY${n}`;
    }

    return { ...payload, name, code, fields };
}

