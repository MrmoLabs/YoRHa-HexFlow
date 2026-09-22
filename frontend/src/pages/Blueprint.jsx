
import React, { useState } from 'react';
import Canvas from '../components/editor/Canvas';
import { v4 as uuidv4 } from 'uuid';

// Mock Initial Data (Recursive)
const INITIAL_BLUEPRINT = {
    id: 'root',
    label: 'ROOT PROTOCOL',
    type: 'container',
    children: [
        { id: '1', label: '帧头 (HEADER)', byte_length: 2, type: 'fixed', hex_value: 'FA FA' },
        {
            id: '2',
            label: '包装层 (PACKAGING)',
            type: 'container',
            byte_length: 0,
            children: [
                { id: '2-1', label: '长度 (LEN)', byte_length: 1, type: 'length', config: {} }
            ]
        },
        { id: '3', label: '帧尾 (TAIL)', byte_length: 1, type: 'fixed', hex_value: 'ED' }
    ]
};

export default function Blueprint() {
    // State to track the full tree
    const [rootBlock, setRootBlock] = useState(INITIAL_BLUEPRINT);

    // Navigation Path (Stack of Block IDs)
    // [root, container1, container2]
    const [path, setPath] = useState([rootBlock]);

    const currentContainer = path[path.length - 1];
    const currentBlocks = currentContainer.children || [];
    const [selectedId, setSelectedId] = useState(null);

    // Helper: Update the tree immutably
    const updateTree = (newChildren) => {
        const newContainer = { ...currentContainer, children: newChildren };

        // If we are at root, straightforward
        if (path.length === 1) {
            setRootBlock(newContainer);
            setPath([newContainer]);
            return;
        }

        // Deep update structure
        // This is complex without a library like Immer, doing a simple approach:
        // Reconstruct path bottom-up
        let child = newContainer;
        const newPath = [...path];
        newPath[newPath.length - 1] = child;

        // Traverse up
        // Note: tracking by reference in 'path' state is tricky if we mutate.
        // Better Strategy:
        // Find the node in 'rootBlock' by ID and update it.
        // Then rebuild 'path' by resolving IDs again.

        const updateRecursive = (node) => {
            if (node.id === currentContainer.id) return newContainer;
            if (!node.children) return node;
            return {
                ...node,
                children: node.children.map(updateRecursive)
            };
        };

        const newRoot = updateRecursive(rootBlock);
        setRootBlock(newRoot);

        // Re-resolve path to get fresh references
        // We assume IDs are unique.
        const resolvePath = (root, ids) => {
            let current = root;
            const resolved = [root];
            for (let i = 1; i < ids.length; i++) {
                const found = current.children?.find(c => c.id === ids[i]);
                if (found) {
                    resolved.push(found);
                    current = found;
                }
            }
            return resolved;
        };
        const currentPathIds = path.map(n => n.id);
        setPath(resolvePath(newRoot, currentPathIds));
    };

    // Handlers
    const handleSetBlocks = (newBlocks) => {
        // 'newBlocks' is the new state of children for currentContainer
        updateTree(newBlocks);
    };

    const handleAddBlock = (type) => {
        const newBlock = {
            id: uuidv4(),
            label: type === 'container' ? '新容器' : (type === 'fixed' ? '固定块' : type.toUpperCase()),
            type: type,
            byte_length: type === 'container' ? 0 : 1,
            hex_value: '00',
            children: type === 'container' ? [] : undefined,
            config: {}
        };
        handleSetBlocks([...currentBlocks, newBlock]);
    };

    const handleDeleteBlock = (id) => {
        const newBlocks = currentBlocks.filter(b => b.id !== id);
        handleSetBlocks(newBlocks);
        if (selectedId === id) setSelectedId(null);
    };

    const handleUpdateBlock = (id, updates) => {
        const newBlocks = currentBlocks.map(b => b.id === id ? { ...b, ...updates } : b);
        handleSetBlocks(newBlocks);
    };

    // Navigation Logic
    const handleEnterContainer = (block) => {
        if (block.type === 'container') {
            setPath([...path, block]);
            setSelectedId(null);
        }
    };

    const handleBreadcrumbClick = (index) => {
        const newPath = path.slice(0, index + 1);
        setPath(newPath);
        setSelectedId(null);
    };

    const selectedBlock = currentBlocks.find(b => b.id === selectedId);

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Sidebar (Palette) */}
            <aside className="w-16 border-r border-nier-light flex flex-col items-center py-4 gap-4 z-10 bg-nier-dark select-none">
                <button onClick={() => handleAddBlock('container')} className="w-10 h-10 border-2 border-nier-light flex flex-col items-center justify-center text-[10px] font-bold hover:bg-nier-light hover:text-nier-dark cursor-pointer" title="新建容器">PKG</button>
                <div className="w-8 h-[1px] bg-nier-light/30 my-2"></div>
                <button onClick={() => handleAddBlock('fixed')} className="w-10 h-10 border border-nier-light flex flex-col items-center justify-center text-[10px] hover:bg-nier-light hover:text-nier-dark cursor-pointer" title="固定值">FIX</button>
                <button onClick={() => handleAddBlock('length')} className="w-10 h-10 border border-nier-light flex flex-col items-center justify-center text-[10px] hover:bg-nier-light hover:text-nier-dark cursor-pointer" title="长度">LEN</button>
                <button onClick={() => handleAddBlock('checksum')} className="w-10 h-10 border border-nier-light flex flex-col items-center justify-center text-[10px] hover:bg-nier-light hover:text-nier-dark cursor-pointer" title="校验">CRC</button>
                <button onClick={() => handleAddBlock('slot')} className="w-10 h-10 border-dashed border border-nier-light flex flex-col items-center justify-center text-[10px] hover:bg-nier-light hover:text-nier-dark cursor-pointer" title="插槽">SLOT</button>
            </aside>

            {/* Canvas Area */}
            <section className="flex-1 relative bg-[url('/grid.png')] bg-repeat opacity-90 overflow-hidden flex flex-col">
                {/* Breadcrumbs */}
                <div className="h-10 border-b border-nier-light bg-nier-dark/90 flex items-center px-4 gap-2 text-xs font-mono">
                    {path.map((node, index) => (
                        <React.Fragment key={node.id}>
                            <button
                                onClick={() => handleBreadcrumbClick(index)}
                                className={`underline ${index === path.length - 1 ? 'font-bold decoration-2' : 'opacity-60'} `}
                            >
                                {node.label}
                            </button>
                            {index < path.length - 1 && <span className="opacity-30">/</span>}
                        </React.Fragment>
                    ))}
                </div>

                <Canvas
                    items={currentBlocks}
                    setItems={handleSetBlocks}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                />
            </section>

            {/* Right Panel (Details) */}
            <aside className="w-80 border-l border-nier-light bg-nier-dark/95 backdrop-blur-sm p-4 flex flex-col z-20 shadow-[-5px_0_15px_rgba(0,0,0,0.1)]">
                <h2 className="text-lg border-b-2 border-nier-light mb-6 pb-1 font-bold tracking-wider">属性配置 (PROPERTIES)</h2>

                {selectedBlock ? (
                    <div className="space-y-6 text-sm animate-in fade-in slide-in-from-right-4 duration-300">
                        {/* Common Properties */}
                        <div className="flex flex-col gap-1">
                            <label className="text-xs opacity-70 uppercase tracking-widest">标签 (Label)</label>
                            <input
                                type="text"
                                value={selectedBlock.label}
                                onChange={(e) => handleUpdateBlock(selectedBlock.id, { label: e.target.value })}
                                className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono tracking-wide"
                            />
                        </div>

                        {selectedBlock.type === 'container' && (
                            <button
                                onClick={() => handleEnterContainer(selectedBlock)}
                                className="mt-4 w-full border border-nier-light bg-nier-light/10 text-nier-light py-2 px-4 hover:bg-nier-light hover:text-nier-dark transition-colors font-bold tracking-widest text-xs"
                            >
                                进入容器 (ENTER) &gt;
                            </button>
                        )}

                        {(selectedBlock.type !== 'container') && (
                            <div className="flex flex-col gap-1">
                                <label className="text-xs opacity-70 uppercase tracking-widest">字节长度 (Length)</label>
                                <input
                                    type="number"
                                    min="1"
                                    value={selectedBlock.byte_length}
                                    onChange={(e) => handleUpdateBlock(selectedBlock.id, { byte_length: parseInt(e.target.value) || 1 })}
                                    className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono"
                                />
                            </div>
                        )}

                        {selectedBlock.type === 'fixed' && (
                            <div className="flex flex-col gap-1">
                                <label className="text-xs opacity-70 uppercase tracking-widest">十六进制值 (Hex)</label>
                                <input
                                    type="text"
                                    value={selectedBlock.hex_value || ''}
                                    onChange={(e) => handleUpdateBlock(selectedBlock.id, { hex_value: e.target.value })}
                                    className="bg-transparent border-b border-nier-light/50 focus:border-nier-light focus:outline-none py-1 font-mono uppercase"
                                />
                            </div>
                        )}

                        <div className="pt-8 border-t border-nier-light/20">
                            <button
                                onClick={() => handleDeleteBlock(selectedBlock.id)}
                                className="w-full border border-red-500/50 text-red-400 hover:bg-red-500 hover:text-white py-2 px-4 uppercase text-xs tracking-widest transition-colors"
                            >
                                删除 (DELETE)
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center opacity-30 gap-2">
                        <p className="italic text-center">选择模块以编辑</p>
                        <p className="text-[10px] font-mono">SELECT MODULE TO CONFIGURE</p>
                    </div>
                )}
            </aside>
        </div>
    );
}

