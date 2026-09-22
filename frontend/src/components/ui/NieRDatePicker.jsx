import React, { useState, useEffect } from 'react';

// InputBox defined outside to prevent re-mounting and focus loss
const InputBox = ({ label, value, min, max, onChange, width = "w-16" }) => (
    <div className="flex flex-col gap-1 items-center">
        <label className="text-[10px] opacity-70 font-bold text-nier-light">{label}</label>
        <input
            type="number"
            min={min}
            max={max}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`${width} bg-transparent border-b-2 border-nier-light/30 text-center font-mono text-xl text-nier-light focus:border-nier-light focus:bg-nier-light/5 focus:outline-none transition-all py-1`}
        />
    </div>
);

export default function NieRDatePicker({ isOpen, initialValue, onConfirm, onCancel }) {
    if (!isOpen) return null;

    const [dateParts, setDateParts] = useState({
        year: 2024, month: 1, day: 1,
        hour: 0, minute: 0, second: 0
    });

    useEffect(() => {
        if (isOpen) {
            initDate(initialValue);
        }
    }, [isOpen, initialValue]);

    const initDate = (val) => {
        let d = new Date();
        if (val) {
            const parsed = new Date(val);
            if (!isNaN(parsed.getTime())) d = parsed;
        }
        syncState(d);
    };

    const syncState = (d) => {
        setDateParts({
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            day: d.getDate(),
            hour: d.getHours(),
            minute: d.getMinutes(),
            second: d.getSeconds()
        });
    }

    const handleChange = (field, val) => {
        setDateParts(prev => ({ ...prev, [field]: parseInt(val) || 0 }));
    };

    const handleNow = () => {
        syncState(new Date());
    };

    const handleConfirm = () => {
        // Construct ISO string manually to preserve local time intent
        // Format: YYYY-MM-DDTHH:mm:ss
        const pad = (n) => n.toString().padStart(2, '0');
        const iso = `${dateParts.year}-${pad(dateParts.month)}-${pad(dateParts.day)}T${pad(dateParts.hour)}:${pad(dateParts.minute)}:${pad(dateParts.second)}`;
        onConfirm(iso);
    };

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-nier-dark/40 backdrop-blur-[2px] animate-in fade-in duration-200">
            <div className="w-[520px] bg-nier-dark border border-nier-light relative shadow-[0_0_30px_rgba(0,0,0,0.3)] text-nier-fg p-1">
                {/* Inner Border Frame */}
                <div className="border border-nier-light/30 p-6 h-full flex flex-col gap-6 relative">

                    {/* Decorative Corners */}
                    <div className="absolute top-0 left-0 w-1 h-1 bg-nier-light"></div>
                    <div className="absolute top-0 right-0 w-1 h-1 bg-nier-light"></div>
                    <div className="absolute bottom-0 left-0 w-1 h-1 bg-nier-light"></div>
                    <div className="absolute bottom-0 right-0 w-1 h-1 bg-nier-light"></div>

                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-nier-light/20 pb-2">
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 bg-nier-light"></div>
                            <span className="font-bold text-sm tracking-widest text-nier-highlight">时间配置 (TEMPORAL)</span>
                        </div>
                        <div className="flex gap-1 opacity-50">
                            <div className="w-8 h-[2px] bg-nier-light"></div>
                            <div className="w-2 h-[2px] bg-nier-light"></div>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="flex flex-col items-center gap-8 py-4">
                        <div className="flex gap-4 items-end">
                            <InputBox label="年 (YEAR)" value={dateParts.year} min={1970} max={2100} onChange={v => handleChange('year', v)} width="w-24" />
                            <span className="text-2xl opacity-20 pb-2 text-nier-light font-bold">/</span>
                            <InputBox label="月 (MON)" value={dateParts.month} min={1} max={12} onChange={v => handleChange('month', v)} />
                            <span className="text-2xl opacity-20 pb-2 text-nier-light font-bold">/</span>
                            <InputBox label="日 (DAY)" value={dateParts.day} min={1} max={31} onChange={v => handleChange('day', v)} />
                        </div>

                        <div className="w-full h-px bg-nier-light/10 flex items-center justify-center">
                            <div className="w-2 h-2 rotate-45 border border-nier-light bg-nier-dark"></div>
                        </div>

                        <div className="flex gap-4 items-end relative">
                            <InputBox label="时 (HOUR)" value={dateParts.hour} min={0} max={23} onChange={v => handleChange('hour', v)} />
                            <span className="text-2xl opacity-20 pb-2 text-nier-light font-bold">:</span>
                            <InputBox label="分 (MIN)" value={dateParts.minute} min={0} max={59} onChange={v => handleChange('minute', v)} />
                            <span className="text-2xl opacity-20 pb-2 text-nier-light font-bold">:</span>
                            <InputBox label="秒 (SEC)" value={dateParts.second} min={0} max={59} onChange={v => handleChange('second', v)} />

                            {/* Current Time Button */}
                            <button
                                onClick={handleNow}
                                className="absolute -right-24 bottom-2 text-[10px] border border-nier-light/50 px-2 py-1 hover:bg-nier-light hover:text-nier-dark transition-colors opacity-70 hover:opacity-100"
                                title="设置为当前时间"
                            >
                                当前时间
                            </button>
                        </div>
                    </div>

                    {/* Footer / Actions */}
                    <div className="flex gap-4 justify-center pt-4 border-t border-nier-light/20">
                        <button
                            onClick={onCancel}
                            className="px-8 py-2 border border-nier-light/50 text-nier-highlight hover:bg-nier-light/10 text-xs font-bold tracking-widest transition-all"
                        >
                            取消 (CANCEL)
                        </button>
                        <button
                            onClick={handleConfirm}
                            className="px-8 py-2 bg-nier-light text-nier-dark font-bold hover:bg-nier-highlight hover:text-white hover:scale-105 text-xs tracking-widest transition-all shadow-md"
                        >
                            确认 (CONFIRM)
                        </button>
                    </div>
                </div>

                {/* Scanline Overlay */}
                <div className="pointer-events-none absolute inset-0 bg-[url('/scanline.png')] opacity-[0.03]"></div>
            </div>
        </div>
    );
}
