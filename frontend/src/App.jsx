import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
// R35：页面改为按路由动态载入，页面模块不再打进首屏 chunk。
import { routeComponent, prefetchRoute } from './utils/routeChunks';
import RouteLoading from './components/RouteLoading';
import GlitchEffect from './components/visuals/GlitchEffect';
import { api } from './api';
import { PAGE_REGISTRY, PAGE_STATUS_BY_PATH } from './config/pageRegistry';

function Layout() {
    const location = useLocation();
    const currentRouteTitle = PAGE_STATUS_BY_PATH[location.pathname]?.titleEn || 'YoRHa-HexFlow';

    // Global Data State (Lifted)
    const [protocols, setProtocols] = useState([]);
    const [instructions, setInstructions] = useState([]);

    const loadProtocols = useCallback(async () => {
        const protocolData = await api.getProtocols();
        setProtocols(protocolData);
        return protocolData;
    }, []);

    const loadInstructions = useCallback(async (search = '') => {
        const instructionData = await api.getInstructions(search);
        setInstructions(instructionData);
        return instructionData;
    }, []);

    useEffect(() => {
        let alive = true;

        const loadAppData = async () => {
            try {
                await Promise.all([
                    loadProtocols(),
                    loadInstructions()
                ]);
                if (!alive) return;
            } catch (error) {
                console.error('Failed to load app-level data', error);
            }
        };

        loadAppData();

        return () => {
            alive = false;
        };
    }, [loadInstructions, loadProtocols]);

    // Nav Item Helper
    // R35：hover / focus 时预取目标页 chunk，切页时模块已在缓存里。
    const NavItem = ({ to, label, shortcut, pageKey }) => (
        <NavLink
            to={to}
            onMouseEnter={() => prefetchRoute(pageKey)}
            onFocus={() => prefetchRoute(pageKey)}
            className={({ isActive }) => `
            group relative flex items-center justify-between px-4 py-3 text-xs tracking-widest transition-all duration-200
            ${isActive ? 'bg-nier-light text-nier-dark font-bold' : 'text-nier-light opacity-60 hover:opacity-100 hover:bg-nier-light/10'}
        `}>
            {({ isActive }) => (
                <>
                    <span>{label}</span>
                    <span className="opacity-30 group-hover:opacity-100 transition-opacity font-mono">[{shortcut}]</span>

                    {/* Active Indicator */}
                    <span className={`absolute left-0 top-0 bottom-0 w-1 bg-current transition-opacity ${isActive ? 'opacity-100' : 'opacity-0'}`}></span>
                </>
            )}
        </NavLink>
    );

    const renderRouteElement = (pageKey) => {
        const Page = routeComponent(pageKey);
        if (!Page) return <Navigate to="/protocol" replace />;
        switch (pageKey) {
            case 'protocol':
                return <Page protocols={protocols} setProtocols={setProtocols} />;
            case 'instruction':
                return <Page instructions={instructions} setInstructions={setInstructions} onWebUpdate={setInstructions} reloadInstructions={loadInstructions} />;
            case 'processing':
                return <Page instructions={instructions} setInstructions={setInstructions} reloadInstructions={loadInstructions} protocols={protocols} />;
            case 'orchestration':
                return <Page protocols={protocols} instructions={instructions} />;
            case 'terminal':
                return <Page />;
            case 'datahub':
                return <Page />;
            case 'sequences':
                return <Page />;
            case 'trash':
                return <Page />;
            default:
                return <Navigate to="/protocol" replace />;
        }
    };

    return (
        <div className="flex h-screen w-screen bg-nier-dark text-nier-light overflow-hidden relative selection:bg-nier-light selection:text-nier-dark font-sans">
            <GlitchEffect />

            {/* Sidebar Navigation */}
            {/* yorha-ui：去 backdrop-blur 改实底、p-6/py-6 收紧（第 4 批先例同口径） */}
            <nav className="w-64 border-r border-nier-light flex flex-col justify-between bg-nier-dark z-50">
                {/* Brand */}
                <div className="p-4 border-b border-nier-light/30">
                    <h1 className="text-2xl font-black tracking-tighter leading-none">HEX<br /><span className="text-lg font-light tracking-widest opacity-80">Orchestrator</span></h1>
                    <div className="mt-2 text-[10px] font-mono opacity-40 uppercase">YoRHa-HexFlow Unit</div>
                </div>

                {/* Links */}
                <div className="flex-1 flex flex-col py-4 gap-2">
                    {PAGE_REGISTRY.map((page) => (
                        <NavItem key={page.key} to={page.path} label={page.titleZh} shortcut={page.shortcut} pageKey={page.key} />
                    ))}
                </div>

                {/* Footer Info */}
                <div className="p-4 border-t border-nier-light/30 text-[10px] font-mono opacity-50 flex flex-col gap-1">
                    <div className="flex justify-between">
                        <span>系统状态</span>
                        <span>ONLINE</span>
                    </div>
                    <div className="flex justify-between">
                        <span>当前位置</span>
                        <span>{location.pathname.replace('/', '').toUpperCase()}</span>
                    </div>
                    <div className="mt-2 pt-2 border-t border-dashed border-current opacity-50 text-center">
                        人类の栄光のために
                    </div>
                </div>
            </nav>

            {/* Main Content Area */}
            <main className="flex-1 flex flex-col overflow-hidden relative">
                {/* Top Bar (Context) */}
                <header className="h-12 border-b border-nier-light flex items-center justify-between px-4 bg-nier-dark z-40">
                    <div className="flex items-center gap-2 text-xs font-mono opacity-60">
                        <span className="w-2 h-2 bg-nier-light animate-pulse"></span>
                        <span>OPERATIONAL // {new Date().toISOString().split('T')[0]}</span>
                    </div>
                    <div className="text-xs tracking-widest uppercase opacity-80">
                        Page: {currentRouteTitle}
                    </div>
                </header>

                {/* Page Content */}
                {/* Suspense 边界放在 key 之外：换路由时边界自身不重建，
                    已预取/已访问过的页面切回来不闪 fallback。 */}
                <Suspense fallback={<RouteLoading />}>
                    <div key={location.pathname} className="flex-1 overflow-hidden relative flex flex-col">
                        <Routes>
                            <Route path="/" element={<Navigate to="/protocol" replace />} />
                            {PAGE_REGISTRY.map((page) => (
                                <Route key={page.key} path={page.path} element={renderRouteElement(page.key)} />
                            ))}
                        </Routes>
                    </div>
                </Suspense>
            </main>
        </div>
    );
}

function App() {
    return (
        <BrowserRouter>
            <Layout />
        </BrowserRouter>
    );
}

export default App;
