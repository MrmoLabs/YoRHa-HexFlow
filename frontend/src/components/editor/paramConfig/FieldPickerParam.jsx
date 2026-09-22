import React from 'react';

// field_picker parameter editor (canvas block picking for logic field refs).
// Extracted verbatim from ParamConfigForm.jsx (logic unchanged).
export default function FieldPickerParam({
    paramKey,
    val,
    pickingMode,
    onStartPicking, // (key, currentRefs) => void
    onStopPicking // () => void
}) {
    const currentRefs = Array.isArray(val) ? val : [];
    const isPickingThis = pickingMode?.isActive && pickingMode?.fieldKey === paramKey;

    return (
        <div className="flex flex-col gap-1 border border-dashed border-nier-light/30 p-2 bg-nier-light/5">
            <div className="flex justify-between items-center">
                <label className="text-[10px] opacity-70 uppercase tracking-widest">{paramKey}</label>
                <div className="text-[9px] font-bold text-yellow-500">{currentRefs.length} REF(S)</div>
            </div>

            <button
                onClick={() => {
                    if (isPickingThis) {
                        // Toggle Off
                        onStopPicking && onStopPicking();
                    } else {
                        onStartPicking(paramKey, currentRefs);
                    }
                }}
                className={`w-full py-1 text-[10px] uppercase tracking-widest transition-all border ${isPickingThis ? 'bg-yellow-500 text-black border-yellow-500 animate-pulse font-bold' : 'bg-transparent border-nier-light/50 text-nier-light hover:bg-nier-light hover:text-black'}`}
            >
                {isPickingThis ? 'STOP PICKING (DONE)' : 'SELECT FIELDS'}
            </button>
            {isPickingThis && (
                <div className="text-[8px] opacity-70 text-center mt-1">
                    Click blocks on canvas to link/unlink.
                </div>
            )}
        </div>
    );
}
