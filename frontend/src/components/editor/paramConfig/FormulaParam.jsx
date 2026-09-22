import React from 'react';

// formula parameter editor (linked-field quick actions + auto ref resolve).
// Extracted verbatim from ParamConfigForm.jsx (logic unchanged).
export default function FormulaParam({
    paramKey,
    val,
    blockState,
    instructionFields,
    onUpdateParam // (key, val) => void
}) {
    const refs = blockState.parameter_config?.refs || [];
    // Map refs to names
    const linkedFields = refs.map(id => {
        const f = instructionFields?.find(b => b.id === id);
        return f ? (f.name || f.label) : null;
    }).filter(Boolean);

    return (
        <div className="flex flex-col gap-2">
            <label className="text-[10px] opacity-70 uppercase tracking-widest">{paramKey}</label>

            {/* QUICK ACTIONS */}
            <div className="flex flex-wrap gap-1 mb-1">
                {linkedFields.map(name => (
                    <button
                        key={name}
                        title={`Click to insert ${name}`}
                        onClick={() => {
                            const current = val || '';
                            const spacer = (current && !current.endsWith(' ')) ? ' ' : '';
                            onUpdateParam(paramKey, `${current}${spacer}[${name}] `);
                        }}
                        className="text-[9px] bg-nier-light/10 border border-nier-light/30 px-1.5 py-0.5 hover:bg-nier-light hover:text-nier-dark transition-colors uppercase"
                    >
                        + {name}
                    </button>
                ))}
                {linkedFields.length > 1 && (
                    <button
                        onClick={() => {
                            const formula = linkedFields.map(n => `[${n}]`).join(' + ');
                            onUpdateParam(paramKey, formula);
                        }}
                        className="text-[9px] bg-orange-400 text-black font-bold px-1.5 py-0.5 hover:opacity-80 transition-opacity uppercase"
                    >
                        ∑ SUM ALL
                    </button>
                )}
                {linkedFields.length === 0 && (
                    <div className="text-[9px] opacity-40 italic border border-dashed border-nier-light/20 px-2 py-1 w-full text-center">
                        No linked fields. Click "SELECT FIELDS" above first.
                    </div>
                )}
            </div>

            <textarea
                ref={(el) => {
                    if (el) {
                        el.style.height = 'auto';
                        el.style.height = el.scrollHeight + 'px';
                    }
                }}
                value={val || ''}
                placeholder="e.g. ([FieldA] + [FieldB]) / 2"
                rows={1}
                onChange={(e) => {
                    const newFormula = e.target.value;
                    onUpdateParam(paramKey, newFormula);

                    // AUTO-RESOLVE REFS: Extract [Name] tokens
                    const matches = newFormula.match(/\[([^\]]+)\]/g) || [];
                    const names = matches.map(m => m.slice(1, -1));
                    const foundRefs = names.map(name => {
                        const f = instructionFields?.find(fi => (fi.name || fi.label) === name);
                        return f?.id;
                    }).filter(Boolean);

                    // MERGE logic: Keep existing refs (from picker) + Add new ones found in text
                    const currentRefs = blockState.parameter_config?.refs || [];
                    const uniqueMerged = [...new Set([...currentRefs, ...foundRefs])];

                    if (uniqueMerged.length !== currentRefs.length) {
                        onUpdateParam('refs', uniqueMerged);
                    }
                }}
                className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono text-sm w-full resize-none overflow-hidden min-h-[1.5rem]"
            />
            <div className="text-[8px] opacity-30 italic">Click field tags above to quickly build formula.</div>
        </div>
    );
}
