import React from 'react';
import { v4 as uuidv4 } from 'uuid';

// kv_pair_list parameter editor (enum mapping with HEX/DEC/BIN input modes).
// Extracted verbatim from ParamConfigForm.jsx (logic unchanged).
export default function KvPairListParam({
    paramKey,
    kvArray, // prepared by BlockPropertiesPanel: [{ id, label, val(hex) }]
    onUpdateParam, // (key, val) => void
    hexInputMode,
    setHexInputMode
}) {
    return (
        <div className="flex flex-col gap-2 border border-nier-light/20 p-2 bg-nier-light/5">
            <div className="flex justify-between items-center">
                <label className="text-[10px] opacity-70 uppercase tracking-widest">{paramKey}</label>
                <button
                    onClick={() => {
                        const newArray = [...kvArray, { id: uuidv4(), val: '', label: '' }];
                        onUpdateParam('_kvArray', newArray);
                    }}
                    className="text-[9px] bg-nier-light/10 hover:bg-nier-light hover:text-nier-dark px-2 py-0.5 transition-colors"
                >
                    + ADD
                </button>
            </div>
            {/* Multi-Format Toggle */}
            <div className="flex justify-end mb-2">
                <div className="flex text-[9px] gap-1 border border-nier-light/30 p-0.5 bg-nier-highlight/10">
                    {['HEX', 'DEC', 'BIN'].map(m => (
                        <button
                            key={m}
                            onClick={() => setHexInputMode(m)}
                            className={`px-2 py-0.5 transition-all ${hexInputMode === m ? 'bg-nier-light text-nier-dark font-bold' : 'text-nier-light hover:bg-nier-light/20'}`}
                        >
                            {m}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-1">
                {kvArray.map((item, idx) => (
                    <div key={item.id} className="flex gap-1 items-center">
                        {/* LABEL (Left) */}
                        <input
                            type="text"
                            placeholder="LABEL"
                            value={item.label}
                            onChange={(e) => {
                                const newArray = [...kvArray];
                                newArray[idx].label = e.target.value;
                                onUpdateParam('_kvArray', newArray);
                            }}
                            className="flex-1 bg-transparent border-b border-nier-light/30 text-xs font-mono text-nier-light focus:border-nier-light focus:outline-none text-center"
                        />
                        <span className="text-nier-light/50">:</span>
                        {/* VALUE (Right) */}
                        <input
                            type="text"
                            placeholder="VAL"
                            value={(() => {
                                // Multi-Format Display
                                const rawHex = item.val;
                                if (!rawHex) return "";
                                const val = parseInt(rawHex, 16);
                                if (isNaN(val)) return rawHex;

                                if (hexInputMode === 'DEC') return val.toString(10);
                                if (hexInputMode === 'BIN') return val.toString(2).padStart(rawHex.length * 4, '0');
                                return rawHex.toUpperCase(); // HEX
                            })()}
                            onChange={(e) => {
                                const input = e.target.value;
                                let newHex = "";
                                try {
                                    if (input === "") {
                                        newHex = "";
                                    } else if (hexInputMode === 'DEC') {
                                        const d = parseInt(input, 10);
                                        if (!isNaN(d)) newHex = d.toString(16).toUpperCase();
                                    } else if (hexInputMode === 'BIN') {
                                        const b = parseInt(input, 2);
                                        if (!isNaN(b)) newHex = b.toString(16).toUpperCase();
                                    } else {
                                        // HEX
                                        newHex = input.toUpperCase().replace(/[^0-9A-F]/g, '');
                                    }
                                    // Update Item Value (Internal Hex)
                                    const newArray = [...kvArray];
                                    newArray[idx].val = newHex;
                                    onUpdateParam('_kvArray', newArray);
                                } catch { /* 非法 hex → 忽略，输入框保持原值 */ }
                            }}
                            className="w-1/3 bg-transparent border-b border-nier-light/30 text-xs font-mono text-nier-light focus:border-nier-light focus:outline-none text-center"
                        />

                        <button
                            onClick={() => {
                                const newArray = kvArray.filter(x => x.id !== item.id);
                                onUpdateParam('_kvArray', newArray);
                            }}
                            className="text-red-500/50 hover:text-red-500 text-[10px] px-1"
                        >
                            ×
                        </button>
                    </div>
                ))}
                {kvArray.length === 0 && (
                    <div className="text-[9px] opacity-30 text-center py-2">NO MAPPINGS</div>
                )}
            </div>
        </div>
    );
}
