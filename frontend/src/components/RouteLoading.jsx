import { useLocation } from 'react-router-dom';
import { PAGE_STATUS_BY_PATH } from '../config/pageRegistry';

/**
 * R35：路由级拆包的 Suspense fallback。
 *
 * 只陈述「正在载入哪个模块」这一事实，不显示百分比进度——拆包加载没有可度量的
 * 进度，画假进度条等于编造数字。8 段待机格只表达「等待中」。
 * 调色板沿用本仓既有 nier-* 层（与 App.jsx 侧栏同源），非 .yorha-* 便携层：
 * 全站组件已统一在 nier-* 上，新组件另起一层会造成双份调色板。
 */
export default function RouteLoading() {
    const location = useLocation();
    const page = PAGE_STATUS_BY_PATH[location.pathname];
    const label = page?.titleZh || 'YoRHa-HexFlow';
    const code = page?.key ? page.key.toUpperCase() : 'UNKNOWN';

    return (
        <div className="flex-1 flex items-center justify-center" role="status" aria-live="polite">
            <div className="flex w-72 flex-col gap-3 border border-nier-light/40 bg-nier-dark p-4">
                <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest opacity-60">
                    <span>[ MODULE LOAD ]</span>
                    <span>{code}</span>
                </div>
                <div className="font-mono text-xs uppercase tracking-widest">{label}</div>
                <div className="flex h-2 gap-px border border-nier-light/40 p-px">
                    {Array.from({ length: 8 }, (_, index) => (
                        <span key={index} className="flex-1 animate-pulse bg-nier-light/20" />
                    ))}
                </div>
                <div className="font-mono text-[10px] uppercase tracking-widest opacity-40">
                    AWAITING MODULE...
                </div>
            </div>
        </div>
    );
}
