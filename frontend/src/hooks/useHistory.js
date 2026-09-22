// P4-1: minimal undo/redo history for the instruction working copy —
// hand-written (no dependency), capped per direction (plan: 栈上限 50).
// Entries are opaque snapshots ({ id, inst }); this hook only manages the
// two stacks + availability, the OWNER (useInstructionData) applies restores
// through setInstructionsState. undo pushes the current entry onto redo and
// vice versa. clear() resets both (instruction switch / save / reload).
import { useCallback, useMemo, useRef, useState } from 'react';

export function useHistory(limit = 50) {
    const undoStackRef = useRef([]);
    const redoStackRef = useRef([]);
    const [, setVersion] = useState(0);
    const bump = () => setVersion(v => v + 1);
    const cap = (stack) => {
        if (stack.length > limit) stack.splice(0, stack.length - limit);
    };

    // A new edit invalidates the redo branch (standard linear history).
    const push = useCallback((entry) => {
        if (!entry) return;
        undoStackRef.current.push(entry);
        cap(undoStackRef.current);
        redoStackRef.current = [];
        bump();
    }, [limit]);

    // currentEntry = the live snapshot at undo time, parked on redo.
    const undo = useCallback((currentEntry) => {
        const prev = undoStackRef.current.pop();
        if (!prev) return null;
        if (currentEntry) {
            redoStackRef.current.push(currentEntry);
            cap(redoStackRef.current);
        }
        bump();
        return prev;
    }, [limit]);

    const redo = useCallback((currentEntry) => {
        const next = redoStackRef.current.pop();
        if (!next) return null;
        if (currentEntry) {
            undoStackRef.current.push(currentEntry);
            cap(undoStackRef.current);
        }
        bump();
        return next;
    }, [limit]);

    const clear = useCallback(() => {
        undoStackRef.current = [];
        redoStackRef.current = [];
        bump();
    }, []);

    const canUndo = undoStackRef.current.length > 0;
    const canRedo = redoStackRef.current.length > 0;

    return useMemo(
        () => ({ push, undo, redo, clear, canUndo, canRedo }),
        [push, undo, redo, clear, canUndo, canRedo]
    );
}
