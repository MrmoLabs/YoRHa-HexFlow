// Phase 2 (P2-1): instruction & block duplication — pure functions.
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

/**
 * Duplicate a block (plus its subtree) INSIDE the same instruction.
 * - fresh ids for the whole subtree (and its bits);
 * - every copied field renamed with the local `_N` convention (E3 labels are
 *   unique instruction-wide);
 * - the copy is inserted directly after the source; that lane is renumbered;
 * - refs / formula inside the copy KEEP pointing at the ORIGINAL blocks
 *   (documented: an un-wired copy — re-target explicitly), while parent_id is
 *   remapped so the copied subtree stays attached to the copied group.
 *
 * @returns {{fields: Array, newBlockId: string, newIds: Array<string>} | null}
 */
export function duplicateBlockInInstruction(instruction, blockId, genId = uuidv4) {
    const fields = Array.isArray(instruction?.fields) ? instruction.fields : [];
    const source = fields.find(f => f.id === blockId);
    if (!source) return null;

    // Subtree in lane order: source first, then descendants by sequence.
    const childrenOf = (pid) => fields
        .filter(f => (f.parent_id ?? null) === pid)
        .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
    const subtree = [];
    const gather = (f) => {
        subtree.push(f);
        childrenOf(f.id).forEach(gather);
    };
    gather(source);

    const idMap = new Map();
    subtree.forEach(f => idMap.set(f.id, genId()));

    // Unique names: existing instruction names are taken; each assigned copy
    // name joins the pool immediately (mirrors Instruction.jsx getUniqueName).
    const taken = new Set(fields.map(f => f.name || f.label).filter(Boolean));
    const uniqueName = (base) => {
        let name = base;
        let counter = 1;
        while (taken.has(name)) {
            name = `${base}_${counter}`;
            counter += 1;
        }
        taken.add(name);
        return name;
    };

    const copied = subtree.map(f => ({
        ...f,
        id: idMap.get(f.id),
        name: uniqueName(f.name || f.label || f.op_code),
        // copy sits in the source's lane; descendants follow their copied parent
        parent_id: f.id === blockId
            ? (source.parent_id ?? null)
            : (idMap.get(f.parent_id) ?? null),
        // refs / formula intentionally unchanged → still point at originals
        parameter_config: { ...f.parameter_config },
        bits: (f.bits || []).map(b => ({ ...b, id: genId() })),
    }));

    // Insert right after the source; renumber that lane 0..n in place.
    // ONLY the copied root joins the lane — copied descendants belong to their
    // own (copied) sub-lanes and keep the source-derived lane-local sequences.
    const laneParent = source.parent_id ?? null;
    const lane = fields
        .filter(f => (f.parent_id ?? null) === laneParent)
        .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
    const srcIdx = lane.findIndex(f => f.id === blockId);
    const copyRootId = idMap.get(blockId);
    const orderedIds = [
        ...lane.slice(0, srcIdx + 1).map(f => f.id),
        copyRootId,
        ...lane.slice(srcIdx + 1).map(f => f.id),
    ];
    const seqById = new Map(orderedIds.map((id, idx) => [id, idx]));

    const nextFields = [
        ...fields.map(f => (seqById.has(f.id) ? { ...f, sequence: seqById.get(f.id) } : f)),
        ...copied.map(f => ({
            ...f,
            sequence: seqById.has(f.id) ? seqById.get(f.id) : f.sequence,
        })),
    ];

    return {
        fields: nextFields,
        newBlockId: idMap.get(blockId),
        newIds: copied.map(f => f.id),
    };
}
