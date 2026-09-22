import React from 'react';

export default function NieRModal({ isOpen, message, onConfirm, onCancel, type = 'CONFIRM' }) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-nier-dark/40 backdrop-blur-[2px] animate-in fade-in duration-200">
            <div className="w-[400px] border-2 border-nier-light bg-nier-dark relative shadow-[0_0_20px_rgba(218,212,187,0.2)]">
                {/* Decorative Corners */}
                <div className="absolute -top-1 -left-1 w-2 h-2 bg-nier-light"></div>
                <div className="absolute -top-1 -right-1 w-2 h-2 bg-nier-light"></div>
                <div className="absolute -bottom-1 -left-1 w-2 h-2 bg-nier-light"></div>
                <div className="absolute -bottom-1 -right-1 w-2 h-2 bg-nier-light"></div>

                {/* Header */}
                <div className="h-8 bg-nier-light/10 border-b border-nier-light flex items-center px-4 justify-between">
                    <span className="font-bold text-xs tracking-widest text-nier-light">系统警告 (SYSTEM ALERT)</span>
                    <div className="flex gap-1">
                        <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                    </div>
                </div>

                {/* Content */}
                <div className="p-8 text-center text-nier-light">
                    <div className="text-sm font-mono tracking-wide leading-relaxed whitespace-pre-wrap">
                        {message}
                    </div>
                </div>

                {/* Footer / Actions */}
                <div className="p-4 border-t border-nier-light/30 bg-nier-light/5 flex gap-4 justify-center">
                    {onCancel && (
                        <button
                            onClick={onCancel}
                            className="px-6 py-2 border border-nier-light/50 text-nier-light/70 hover:bg-nier-light/10 hover:text-nier-light text-xs tracking-widest transition-all"
                        >
                            取消 (CANCEL)
                        </button>
                    )}
                    <button
                        onClick={onConfirm}
                        className="px-6 py-2 bg-nier-light text-nier-dark font-bold hover:bg-nier-highlight hover:text-white hover:scale-105 text-xs tracking-widest transition-all shadow-[0_0_10px_rgba(218,212,187,0.5)]"
                    >
                        确认 (CONFIRM)
                    </button>
                </div>

                {/* Scanline Overlay */}
                <div className="pointer-events-none absolute inset-0 bg-[url('/scanline.png')] opacity-10"></div>
            </div>
        </div>
    );
}
