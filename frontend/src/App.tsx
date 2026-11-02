import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Link, useNavigate } from 'react-router'
import { Settings2 } from 'lucide-react'
import { useWorkspaceStore } from './stores/workspaceStore'
import { useSettingsStore } from './stores/settingsStore'
import { ToastHost } from './components/ToastHost'
import { ThemeToggle } from './components/ThemeToggle'
import { YuanshengzhePanel } from './components/YuanshengzhePanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useQuotaStore } from './stores/quotaStore'
import { QuotaExceededDialog } from './components/QuotaPanel'
import { TaskWorkbench } from './pages/TaskWorkbench'
import { FirstUseSetup } from './components/FirstUseSetup'
import { browserLocal } from './browser/mode'
import { UnifiedSetupDialog } from './browser/ModelPreparation'
const WorkspacePage = lazy(() => import('./pages/workspace/index').then(m => ({ default: m.WorkspacePage })))
const SettingsPage = lazy(() => import('./pages/settings/index').then(m => ({ default: m.SettingsPage })))
function SourceOwnershipSync({onChange}:{onChange:()=>void}) {
  const navigate=useNavigate()
  useEffect(()=>{
    const changed=()=>{
      window.dispatchEvent(new Event('ynote:preserve-unsubmitted-input'))
      navigate({pathname:window.location.pathname,search:'',hash:''},{replace:true})
      onChange()
    }
    window.addEventListener('ynote:task-source-changed',changed)
    return()=>window.removeEventListener('ynote:task-source-changed',changed)
  },[navigate,onChange])
  return null
}
export function App() {
  const [sourceVersion,setSourceVersion] = useState(0)
  const [resetTaskSelection,setResetTaskSelection] = useState(false)
  const sourceChanged=useCallback(()=>{setResetTaskSelection(true);setSourceVersion(n=>n+1)},[])
  const sourceResetHandled=useCallback(()=>setResetTaskSelection(false),[])
  useEffect(() => { if (!browserLocal()) { void useWorkspaceStore.getState().hydrate(); void useSettingsStore.getState().hydrate(); void useQuotaStore.getState().refresh(); } }, [])
  return <BrowserRouter><SourceOwnershipSync onChange={sourceChanged} /><ErrorBoundary><div className="flex h-full flex-col">
    <header className="app-header"><div className="app-brand-group"><Link to="/" className="brand" aria-label="Ynote 首页">Ynote</Link><nav className="header-nav" aria-label="主导航"><NavLink to="/settings"><Settings2 size={15} /> 设置</NavLink></nav><ThemeToggle /></div><YuanshengzhePanel /></header>
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-ink-3">正在打开工作空间…</div>}><Routes><Route path="/" element={<TaskWorkbench key={sourceVersion} resetSourceSelection={resetTaskSelection} onSourceResetHandled={sourceResetHandled} />} /><Route path="/workspace" element={<TaskWorkbench key={sourceVersion} resetSourceSelection={resetTaskSelection} onSourceResetHandled={sourceResetHandled} />} /><Route path="/notes" element={<div className="min-h-0 flex-1"><WorkspacePage /></div>} /><Route path="/settings" element={<div className="min-h-0 flex-1 overflow-y-auto"><SettingsPage /></div>} /><Route path="*" element={<div className="p-12 text-center">页面不存在。<Link to="/" className="text-accent">返回首页</Link></div>} /></Routes></Suspense><ToastHost /><QuotaExceededDialog />
    {browserLocal() ? <UnifiedSetupDialog /> : <FirstUseSetup />}
  </div></ErrorBoundary></BrowserRouter>
}
