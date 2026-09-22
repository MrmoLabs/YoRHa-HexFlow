import React, { useMemo } from 'react';
import { OP_CODES, OP_PRIORITY, CATEGORY_ORDER } from '../../constants';

export default function ComponentPalette({
    operatorTemplates,
    onAddBlock,
    isLoading = false,
    error = '',
    hasInstruction = true,
    onRetry
}) {
    // Grouping Logic
    const groupedOperators = useMemo(() => {
        const groups = {};
        Object.values(operatorTemplates).forEach(op => {
            const category = op.category || 'UNCATEGORIZED';
            if (!groups[category]) groups[category] = [];
            groups[category].push(op);
        });

        // Sort Config
        const catOrder = CATEGORY_ORDER;
        const opPriority = OP_PRIORITY;

        // Sort items per category
        Object.keys(groups).forEach(cat => {
            groups[cat].sort((a, b) => {
                if (a.op_code === OP_CODES.HEX_RAW) return -1;
                if (b.op_code === OP_CODES.HEX_RAW) return 1;

                const idxA = opPriority.indexOf(a.op_code);
                const idxB = opPriority.indexOf(b.op_code);

                if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                if (idxA !== -1) return -1;
                if (idxB !== -1) return 1;

                return a.name.localeCompare(b.name);
            });
        });

        // Re-order keys for rendering
        const sortedGroups = {};
        const sortedKeys = Object.keys(groups).sort((a, b) => {
            const ia = catOrder.indexOf(a.toUpperCase());
            const ib = catOrder.indexOf(b.toUpperCase());
            if (ia !== -1 && ib !== -1) return ia - ib;
            if (ia !== -1) return -1;
            if (ib !== -1) return 1;
            return a.localeCompare(b);
        });

        sortedKeys.forEach(k => sortedGroups[k] = groups[k]);
        return sortedGroups;
    }, [operatorTemplates]);

    const operatorCount = Object.values(operatorTemplates).length;

    if (isLoading) {
        return (
            <aside className="w-24 border-r border-nier-light flex flex-col items-center justify-center py-4 px-2 gap-2 z-10 bg-nier-dark select-none">
                <div className="text-[9px] text-center text-nier-light/60 leading-4">
                    模块模板
                    <br />
                    LOADING...
                </div>
            </aside>
        );
    }

    if (error) {
        return (
            <aside className="w-24 border-r border-nier-light flex flex-col items-center justify-center py-4 px-2 gap-3 z-10 bg-nier-dark select-none">
                <div className="text-[9px] text-center text-red-400 leading-4">{error}</div>
                <button
                    onClick={onRetry}
                    className="border border-nier-light/30 px-2 py-1 text-[9px] text-nier-light hover:bg-nier-light hover:text-nier-dark transition-colors"
                >
                    RETRY
                </button>
            </aside>
        );
    }

    if (!hasInstruction) {
        return (
            <aside className="w-24 border-r border-nier-light flex flex-col items-center justify-center py-4 px-2 gap-2 z-10 bg-nier-dark select-none">
                <div className="text-[9px] text-center text-nier-light/50 leading-4">
                    先选择
                    <br />
                    指令
                </div>
            </aside>
        );
    }

    if (operatorCount === 0) {
        return (
            <aside className="w-24 border-r border-nier-light flex flex-col items-center justify-center py-4 px-2 gap-2 z-10 bg-nier-dark select-none">
                <div className="text-[9px] text-center text-nier-light/50 leading-4">
                    暂无模块
                    <br />
                    模板数据
                </div>
            </aside>
        );
    }

    return (
        <aside className="w-24 border-r border-nier-light flex flex-col items-center py-2 gap-2 z-10 bg-nier-dark select-none overflow-y-auto hide-scrollbar">
            {Object.entries(groupedOperators).map(([category, ops]) => (
                <div key={category} className="w-full flex flex-col items-center mb-2">
                    <div className="text-[8px] opacity-40 uppercase tracking-widest mb-1 w-full text-center border-b border-nier-light/10">{category}</div>
                    <div className="grid grid-cols-1 gap-2 w-full px-2">
                        {ops.map(op => (
                            <button
                                key={op.op_code}
                                onClick={() => onAddBlock(op.op_code)}
                                className="w-full border border-nier-light/30 hover:border-nier-light bg-nier-dark hover:bg-nier-light hover:text-nier-dark py-2 px-1 text-[9px] leading-tight transition-all text-center flex flex-col items-center gap-1 text-nier-light/80"
                                title={op.description}
                            >
                                <span className="font-bold">{op.name}</span>
                                <span className="text-[7px] opacity-60 scale-90">{op.op_code.split('_')[0]}</span>
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </aside>
    );
}
