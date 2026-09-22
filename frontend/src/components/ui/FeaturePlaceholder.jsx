import React from 'react';

export default function FeaturePlaceholder({
    code,
    title,
    subtitle,
    status,
    description,
    availableNow = [],
    nextSteps = []
}) {
    return (
        <div className="flex-1 overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(218,212,187,0.12),_transparent_45%),linear-gradient(180deg,_rgba(212,206,178,0.04),_rgba(10,10,10,0))] text-nier-light">
            <div className="h-full px-8 py-10 flex flex-col gap-8">
                <section className="border border-nier-light/30 bg-nier-dark/70 backdrop-blur-sm p-8 shadow-[0_0_0_1px_rgba(218,212,187,0.08)]">
                    <div className="text-[11px] font-mono tracking-[0.35em] opacity-50">{code}</div>
                    <h1 className="mt-3 text-5xl font-black tracking-tight leading-none">{title}</h1>
                    <p className="mt-3 text-sm uppercase tracking-[0.25em] opacity-60">{subtitle}</p>
                    <div className="mt-6 inline-flex items-center gap-2 border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[11px] font-mono tracking-[0.2em] text-yellow-300">
                        <span className="h-2 w-2 rounded-full bg-yellow-300 animate-pulse"></span>
                        {status}
                    </div>
                    <p className="mt-6 max-w-3xl text-sm leading-7 opacity-80">{description}</p>
                </section>

                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                    <section className="border border-nier-light/20 bg-nier-dark/50 p-6">
                        <div className="text-xs font-bold tracking-[0.25em] opacity-70">CURRENTLY AVAILABLE</div>
                        <div className="mt-4 space-y-3">
                            {availableNow.map((item) => (
                                <div key={item} className="border-l-2 border-nier-light/40 pl-3 text-sm leading-6 opacity-80">
                                    {item}
                                </div>
                            ))}
                        </div>
                    </section>

                    <section className="border border-nier-light/20 bg-nier-dark/50 p-6">
                        <div className="text-xs font-bold tracking-[0.25em] opacity-70">NEXT STEPS</div>
                        <div className="mt-4 space-y-3">
                            {nextSteps.map((item) => (
                                <div key={item} className="border-l-2 border-yellow-400/40 pl-3 text-sm leading-6 opacity-80">
                                    {item}
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
