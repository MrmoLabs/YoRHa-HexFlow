import React from 'react';

export default function GlitchEffect() {
    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden z-[9999] opacity-30 mix-blend-overlay">
            {/* Simple CSS-based Scanlines or random blocks */}
            <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0.1)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_4px,3px_1px]"></div>
        </div>
    );
}
