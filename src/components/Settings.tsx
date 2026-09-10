import { useState } from 'react';
import { Settings2, Bell, Trash2, Download, Info, ExternalLink } from 'lucide-react';
import { useStore } from '../store/useStore';
import toast from 'react-hot-toast';

export function Settings() {
  const { batches, gallery, notifications, schedulerActive, setSchedulerActive } = useStore();
  const [notifPermission, setNotifPermission] = useState(Notification.permission);

  const requestNotifPermission = async () => {
    const result = await Notification.requestPermission();
    setNotifPermission(result);
    if (result === 'granted') {
      toast.success('Push notifications enabled!');
      new Notification('Misfit Ministries', {
        body: 'Push notifications are now active. You\'ll get alerts every hour when posts are ready!',
      });
    } else {
      toast.error('Notification permission denied. Enable in browser settings.');
    }
  };

  const exportData = () => {
    const data = {
      batches,
      gallery: gallery.map(g => ({ id: g.id, name: g.name, uploadedAt: g.uploadedAt })),
      notifications,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `misfit-ministries-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Data exported!');
  };

  const clearAllData = () => {
    if (confirm('Are you sure you want to clear ALL data? This cannot be undone.')) {
      localStorage.removeItem('misfit-ministries-store');
      window.location.reload();
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black text-slate-800 mb-1">Settings</h2>
        <p className="text-slate-500 text-sm">Configure your Media Command Center</p>
      </div>

      {/* Scheduler Settings */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Settings2 size={18} className="text-purple-600" />
          <h3 className="font-bold text-slate-800">Scheduler</h3>
        </div>
        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
          <div>
            <p className="font-medium text-slate-700 text-sm">Auto-generation</p>
            <p className="text-xs text-slate-400">Generates 4 posts + 4 merch ideas every hour, 8AM–8PM</p>
          </div>
          <button
            onClick={() => {
              setSchedulerActive(!schedulerActive);
              toast.success(schedulerActive ? 'Scheduler paused' : 'Scheduler started!');
            }}
            className={`relative w-12 h-6 rounded-full transition-all ${
              schedulerActive ? 'bg-purple-600' : 'bg-slate-300'
            }`}
          >
            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${
              schedulerActive ? 'left-7' : 'left-1'
            }`} />
          </button>
        </div>
        <div className="text-xs text-slate-500 bg-amber-50 rounded-lg p-3 border border-amber-100">
          ⏰ <strong>Schedule:</strong> 8:00 AM, 9:00 AM, 10:00 AM, 11:00 AM, 12:00 PM,
          1:00 PM, 2:00 PM, 3:00 PM, 4:00 PM, 5:00 PM, 6:00 PM, 7:00 PM (12 batches/day)
        </div>
      </div>

      {/* Notifications */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Bell size={18} className="text-purple-600" />
          <h3 className="font-bold text-slate-800">Push Notifications</h3>
        </div>
        <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
          <div>
            <p className="font-medium text-slate-700 text-sm">Browser Push Notifications</p>
            <p className="text-xs text-slate-400">
              Status: <span className={
                notifPermission === 'granted' ? 'text-emerald-600 font-bold' :
                notifPermission === 'denied' ? 'text-red-500 font-bold' :
                'text-amber-600 font-bold'
              }>
                {notifPermission === 'granted' ? '✅ Enabled' :
                 notifPermission === 'denied' ? '❌ Blocked' :
                 '⚠️ Not yet enabled'}
              </span>
            </p>
          </div>
          {notifPermission !== 'granted' && (
            <button
              onClick={requestNotifPermission}
              className="px-3 py-1.5 bg-purple-600 text-white text-xs font-bold rounded-lg hover:bg-purple-700"
            >
              Enable
            </button>
          )}
        </div>
        {notifPermission === 'denied' && (
          <p className="text-xs text-red-500">
            Notifications are blocked by your browser. Go to browser settings → Site Settings → Notifications to allow.
          </p>
        )}
      </div>

      {/* AI Engine Info */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Info size={18} className="text-purple-600" />
          <h3 className="font-bold text-slate-800">AI Engine</h3>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
            <div>
              <p className="font-medium text-slate-700 text-sm">🖼 Image Generation</p>
              <p className="text-xs text-slate-400">Pollinations.AI — Flux model (free, no key required)</p>
            </div>
            <a href="https://pollinations.ai" target="_blank" rel="noopener noreferrer"
               className="text-xs text-blue-500 flex items-center gap-1 hover:underline">
              Visit <ExternalLink size={12} />
            </a>
          </div>
          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
            <div>
              <p className="font-medium text-slate-700 text-sm">💬 Text / Copy Generation</p>
              <p className="text-xs text-slate-400">Pollinations.AI — OpenAI model (free, no key required)</p>
            </div>
            <a href="https://pollinations.ai" target="_blank" rel="noopener noreferrer"
               className="text-xs text-blue-500 flex items-center gap-1 hover:underline">
              Visit <ExternalLink size={12} />
            </a>
          </div>
          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
            <div>
              <p className="font-medium text-slate-700 text-sm">🛍 Print-on-Demand Partners</p>
              <p className="text-xs text-slate-400">Printful, Printify, Sticker Mule (all free to list)</p>
            </div>
          </div>
        </div>
      </div>

      {/* Data Stats */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
        <h3 className="font-bold text-slate-800 mb-4">Data Summary</h3>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="text-center bg-slate-50 rounded-xl p-3">
            <div className="text-xl font-black text-slate-800">{gallery.length}</div>
            <div className="text-xs text-slate-500">Gallery Images</div>
          </div>
          <div className="text-center bg-slate-50 rounded-xl p-3">
            <div className="text-xl font-black text-slate-800">{batches.length}</div>
            <div className="text-xs text-slate-500">Batches</div>
          </div>
          <div className="text-center bg-slate-50 rounded-xl p-3">
            <div className="text-xl font-black text-slate-800">{notifications.length}</div>
            <div className="text-xs text-slate-500">Notifications</div>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={exportData}
            className="flex-1 flex items-center justify-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 py-2.5 rounded-xl font-bold text-sm transition-all"
          >
            <Download size={16} /> Export Data
          </button>
          <button
            onClick={clearAllData}
            className="flex-1 flex items-center justify-center gap-2 bg-red-50 hover:bg-red-100 text-red-600 py-2.5 rounded-xl font-bold text-sm transition-all"
          >
            <Trash2 size={16} /> Clear All Data
          </button>
        </div>
      </div>

      {/* About */}
      <div className="bg-gradient-to-r from-slate-900 to-purple-950 rounded-2xl p-6 text-white">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">✝️</span>
          <h3 className="font-black text-lg">Misfit Ministries</h3>
        </div>
        <p className="text-slate-300 text-sm">
          Media Command Center — Built to amplify the message that everyone belongs.
          Powered by free AI to reach the broken, the lost, and the forgotten.
        </p>
        <p className="text-purple-400 text-xs mt-3">
          "He who was seated on the throne said, 'I am making everything new!'" — Revelation 21:5
        </p>
      </div>
    </div>
  );
}
