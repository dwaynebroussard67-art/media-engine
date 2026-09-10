import { useStore } from '../store/useStore';
import { format } from 'date-fns';
import { Bell, BellOff, CheckCheck, Trash2 } from 'lucide-react';

const TYPE_STYLES = {
  alert: 'bg-amber-50 border-amber-200 text-amber-800',
  success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  info: 'bg-blue-50 border-blue-200 text-blue-800',
  warning: 'bg-red-50 border-red-200 text-red-800',
};

const TYPE_ICONS = {
  alert: '🔔',
  success: '✅',
  info: 'ℹ️',
  warning: '⚠️',
};

export function Notifications() {
  const { notifications, markNotificationRead, clearAllNotifications } = useStore();

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-black text-slate-800 mb-1">Notifications</h2>
          <p className="text-slate-500 text-sm">
            Phone-style alerts for every batch, approval, and remix event.
          </p>
        </div>
        {notifications.length > 0 && (
          <button
            onClick={clearAllNotifications}
            className="flex items-center gap-2 text-sm text-red-500 hover:text-red-700 font-medium"
          >
            <Trash2 size={16} /> Clear All
          </button>
        )}
      </div>

      {unread > 0 && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <Bell size={16} className="text-amber-600 animate-bounce" />
          <span className="text-amber-800 font-bold text-sm">{unread} unread notification{unread > 1 ? 's' : ''}</span>
          <button
            onClick={() => notifications.forEach((n) => !n.read && markNotificationRead(n.id))}
            className="ml-auto flex items-center gap-1 text-xs text-amber-600 hover:text-amber-800 font-medium"
          >
            <CheckCheck size={14} /> Mark all read
          </button>
        </div>
      )}

      {notifications.length === 0 && (
        <div className="text-center py-16">
          <BellOff size={40} className="mx-auto text-slate-300 mb-3" />
          <p className="font-bold text-slate-500">No notifications yet</p>
          <p className="text-sm text-slate-400">Start the scheduler to receive hourly alerts</p>
        </div>
      )}

      <div className="space-y-3">
        {notifications.map((n) => (
          <div
            key={n.id}
            onClick={() => markNotificationRead(n.id)}
            className={`relative border rounded-xl p-4 cursor-pointer transition-all ${
              TYPE_STYLES[n.type]
            } ${!n.read ? 'shadow-sm' : 'opacity-60'}`}
          >
            {!n.read && (
              <div className="absolute top-4 right-4 w-2.5 h-2.5 bg-red-500 rounded-full" />
            )}
            <div className="flex items-start gap-3">
              <span className="text-lg">{TYPE_ICONS[n.type]}</span>
              <div className="flex-1">
                <p className="font-medium text-sm">{n.message}</p>
                <p className="text-xs opacity-60 mt-1">{format(n.timestamp, 'MMMM d, yyyy · h:mm:ss a')}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
