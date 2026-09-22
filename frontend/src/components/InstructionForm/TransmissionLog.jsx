import React from 'react';

// Transmission log panel (send status history) for InstructionRunner.
// Extracted verbatim from InstructionRunner.jsx (logic unchanged).
// Status text reflects the backend /dispatch loopback channel (no real transport).
export default function TransmissionLog({ logs }) {
    return (
        <div className="flex-1 overflow-hidden flex flex-col mt-4">
            <div className="text-xs font-black text-nier-light/40 mb-3 uppercase tracking-[0.2em] border-b-2 border-nier-light/10 pb-2">
                :: Transmission_Log ::
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-xs space-y-3">
                {logs.map(log => (
                    <div key={log.id} className="flex flex-col gap-1 border-b border-nier-light/5 pb-2">
                        <div className="flex justify-between opacity-40 font-bold text-[9px]">
                            <span>[{log.time}]</span>
                            <span className={
                                log.status === 'FAILED' ? 'text-red-400' :
                                    log.status === 'SENDING' ? 'text-yellow-400' :
                                        'text-green-400'
                            }>
                                {log.status === 'FAILED' ? `TX_FAILED: ${log.error || ''}` :
                                    log.status === 'SENDING' ? 'TX_PENDING...' : 'TX_SUCCESS (LOOPBACK)'}
                            </span>
                        </div>
                        <div className="text-nier-light break-all font-bold">
                            {log.payload}
                        </div>
                    </div>
                ))}
                {logs.length === 0 && (
                    <div className="italic text-nier-light/30 text-[10px]">// BUFFER_EMPTY</div>
                )}
            </div>
        </div>
    );
}
