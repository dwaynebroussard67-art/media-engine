import { Toaster } from 'react-hot-toast';
import { useStore } from './store/useStore';
import { useScheduler } from './hooks/useScheduler';
import { Dashboard } from './components/Dashboard';
import { Gallery } from './components/Gallery';
import { ApprovalQueue } from './components/ApprovalQueue';
import { Analytics } from './components/Analytics';
import { Notifications } from './components/Notifications';
import { Settings } from './components/Settings';
import { MemoryPanel } from './components/MemoryPanel';
import {
  LayoutDashboard, Images, CheckSquare, BarChart2,
  Bell, Settings2, Menu, X, Zap, Brain
} from 'lucide-react';
import { useState, useEffect } from 'react';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'gallery', label: 'Gallery', icon: Images },
  { id: 'approvals', label: 'Approvals', icon: CheckSquare },
  { id: 'memory', label: 'Taste Memory', icon: Brain },
  { id: 'analytics', label: 'Analytics', icon: BarChart2 },
  { id: 'notifications', label: 'Alerts', icon: Bell },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

function NavItem({ id, label, icon: Icon, badge }: { id: string; label: string; icon: React.ElementType; badge?: number }) {
  const { currentView, setCurrentView } = useStore();
  const isActive = currentView === id;

  return (
    <button
      onClick={() => setCurrentView(id)}
      className={`flex items-center gap-3 px-4 py-3 rounded-xl w-full text-left transition-all relative ${
        isActive
          ? 'bg-purple-600 text-white shadow-lg shadow-purple-200'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      <Icon size={18} />
      <span className="font-semibold text-sm">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

export default function App() {
  const { currentView, batches, notifications, isGenerating } = useStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Keep scheduler running via hook
  useScheduler();

  const seedPermanentGallery = useStore((s) => s.seedPermanentGallery);
  const hydrateFromCloud = useStore((s) => s.hydrateFromCloud);

  // On boot: bake permanent images into the gallery, then pull any autonomous
  // (cron-generated) batches + taste history down from Supabase.
  useEffect(() => {
    seedPermanentGallery();
    void hydrateFromCloud();
  }, [seedPermanentGallery, hydrateFromCloud]);

  const pendingItems = batches.flatMap(b => [
    ...b.posts.filter(p => p.status === 'pending'),
    ...b.merchandise.filter(m => m.status === 'pending'),
  ]).length;

  const unreadNotifs = notifications.filter(n => !n.read).length;

  const renderView = () => {
    switch (currentView) {
      case 'dashboard': return <Dashboard />;
      case 'gallery': return <Gallery />;
      case 'approvals': return <ApprovalQueue />;
      case 'memory': return <MemoryPanel />;
      case 'analytics': return <Analytics />;
      case 'notifications': return <Notifications />;
      case 'settings': return <Settings />;
      default: return <Dashboard />;
    }
  };

  const Sidebar = () => (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-purple-600 to-pink-600 rounded-xl flex items-center justify-center shadow-lg">
            <span className="text-white font-black text-lg">✝</span>
          </div>
          <div>
            <div className="font-black text-slate-800 text-sm leading-tight">MISFIT</div>
            <div className="font-black text-slate-800 text-sm leading-tight">MINISTRIES</div>
          </div>
        </div>
        <div className="mt-2 text-xs text-slate-400 font-medium">Media Command Center</div>
      </div>

      {/* Status Pill */}
      <div className="mx-4 mb-4">
        <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold ${
          isGenerating
            ? 'bg-blue-50 text-blue-700 border border-blue-200'
            : 'bg-slate-50 text-slate-500 border border-slate-200'
        }`}>
          <Zap size={12} className={isGenerating ? 'animate-pulse text-blue-500' : 'text-slate-400'} />
          {isGenerating ? 'AI Generating...' : 'Ready'}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <NavItem
            key={item.id}
            id={item.id}
            label={item.label}
            icon={item.icon}
            badge={
              item.id === 'approvals' ? pendingItems :
              item.id === 'notifications' ? unreadNotifs :
              undefined
            }
          />
        ))}
      </nav>

      {/* Bottom Brand */}
      <div className="p-4 border-t border-slate-100">
        <p className="text-xs text-slate-400 text-center italic">
          "You belong here."
        </p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      <Toaster
        position="top-right"
        toastOptions={{
          style: { borderRadius: '12px', fontWeight: 600, fontSize: '14px' },
          duration: 4000,
        }}
      />

      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col w-60 bg-white border-r border-slate-100 shadow-sm fixed inset-y-0 left-0 z-30">
        <Sidebar />
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <div className="relative w-64 bg-white shadow-2xl flex flex-col">
            <button
              onClick={() => setSidebarOpen(false)}
              className="absolute top-4 right-4 p-1 rounded-lg hover:bg-slate-100"
            >
              <X size={20} className="text-slate-600" />
            </button>
            <Sidebar />
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 lg:ml-60 flex flex-col min-h-screen">
        {/* Mobile Header */}
        <div className="lg:hidden sticky top-0 z-20 bg-white border-b border-slate-100 px-4 py-3 flex items-center gap-3 shadow-sm">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-xl hover:bg-slate-100"
          >
            <Menu size={20} className="text-slate-700" />
          </button>
          <div className="flex items-center gap-2">
            <span className="font-black text-slate-800 text-sm">✝ MISFIT MINISTRIES</span>
          </div>
          {(pendingItems + unreadNotifs) > 0 && (
            <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full px-2 py-0.5">
              {pendingItems + unreadNotifs}
            </span>
          )}
        </div>

        {/* Page Content */}
        <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-5xl w-full mx-auto">
          {renderView()}
        </div>
      </main>
    </div>
  );
}
