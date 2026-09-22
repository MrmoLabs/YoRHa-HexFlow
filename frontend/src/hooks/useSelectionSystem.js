import { useState, useEffect } from 'react';

export function useSelectionSystem() {
    const [selectedId, setSelectedId] = useState(null);

    // Picking Mode State (Logic Fields)
    const [pickingMode, setPickingMode] = useState({
        isActive: false,
        fieldKey: null,     // which param is being picked (e.g., 'refs')
        currentRefs: [],    // list of currently selected IDs
        onUpdateRefs: null  // callback to save selection
    });

    const handlePickBlock = (targetId) => {
        if (!pickingMode.isActive) return;
        const currentRefs = pickingMode.currentRefs || [];
        const isSelected = currentRefs.includes(targetId);
        let newRefs = isSelected ? currentRefs.filter(id => id !== targetId) : [...currentRefs, targetId];

        setPickingMode(prev => ({ ...prev, currentRefs: newRefs }));

        if (pickingMode.onUpdateRefs) {
            pickingMode.onUpdateRefs(newRefs);
        }
    };

    const cancelPicking = () => {
        setPickingMode({ isActive: false, fieldKey: null, currentRefs: [], onUpdateRefs: null });
    };

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

            // ESC to cancel picking OR deselect
            if (e.key === 'Escape') {
                if (pickingMode.isActive) {
                    cancelPicking();
                } else if (selectedId) {
                    setSelectedId(null);
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedId, pickingMode.isActive]);

    return {
        selectedId,
        setSelectedId,
        pickingMode,
        setPickingMode,
        handlePickBlock,
        cancelPicking
    };
}
