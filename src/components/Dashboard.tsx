import { useStore } from '../store/useStore';
import { useScheduler } from '../hooks/useScheduler';
import { format } from 'date-fns';
import {
  Images, Clock, CheckCircle2, XCircle, RefreshCw, ShoppingBag,
  Play, Pause, Zap, Bell, TrendingUp, Calendar
} from 'lucide-react';
import toast from 'react-hot-toast';

export function Dashboard() {
  const {
    gallery, batches, notifications, schedulerActive, isGenerating,
    setSchedulerActive, setCurrentView,
  } = useStore();
  const { triggerNow } = useScheduler();

  const totalPosts = batches.flatMap((b) => b.posts);
  const totalMerch = batches.flatMap((b) => b.merchandise);
  const pendingPosts = totalPosts.filter((p) => p.status === 'pending').length;
  const approvedPosts = totalPosts.filter((p) => p.status === 'approved' || p.status === 'posted').length;
  const pendingMerch = totalMerch.filter((m) => m.status === 'pending').length;
  const unreadNotifs = notifications.filter((n) => !n.read).length;

  const now = new Date();
  const hour = now.getHours();
  const isInScheduleWindow = hour >= 8 && hour < 20;

  const nextHour = new Date();
  nextHour.setHours(hour < 8 ? 8 : hour >= 20 ? 8 : hour + 1, 0, 0, 0);
  if (hour >= 20) nextHour.setDate(nextHour.getDate() + 1);

  const stats = [
    { label: 'Gallery Images', value: gallery.length, icon: Images, color: 'from-violet-500 to-purple-600', view: 'gallery' },
    { label: 'Pending Approvals', value: pendingPosts + pendingMerch, icon: Bell, color: 'from-amber-500 to-orange-600', view: 'approvals' },
    { label: 'Posts Approved', value: approvedPosts, icon: CheckCircle2, color: 'from-emerald-500 to-green-600', view: 'posts' },
    { label: 'Merch Ideas', value: totalMerch.length, icon: ShoppingBag, color: 'from-pink-500 to-rose-600', view: 'merch' },
  ];

  const hourlySchedule = Array.from({ length: 12 }, (_, i) => {
    const h = i + 8;
    const batch = batches.find((b) => b.hourSlot === h);
    return { hour: h, label: `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`, batch };
  });

  return (
    <div className="space-y-6">
      {/* Hero Banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-purple-950 to-slate-900 p-8 text-white">
        <div className="absolute inset-0 opacity-20 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-purple-400 via-transparent to-transparent" />
        <div className="relative">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">✝️</span>
            <h1 className="text-2xl font-black tracking-tight">MISFIT MINISTRIES</h1>
          </div>
          <p className="text-purple-300 font-medium text-lg">Media Command Center</p>
          <p className="text-slate-400 text-sm mt-1">
            {format(now, 'EEEE, MMMM d, yyyy — h:mm a')}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              onClick={() => {
                setSchedulerActive(!schedulerActive);
                toast.success(schedulerActive ? '⏸ Scheduler paused' : '▶ Scheduler started — runs every hour 8AM–8PM');
              }}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all ${
                schedulerActive
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-emerald-500 hover:bg-emerald-600 text-white'
              }`}
            >
              {schedulerActive ? <><Pause size={16} /> Pause Scheduler</> : <><Play size={16} /> Start Scheduler</>}
            </button>
            <button
              onClick={() => {
                if (gallery.length === 0) {
                  toast.error('Add at least one image to your gallery first!');
                  return;
                }
                triggerNow();
              }}
              disabled={isGenerating}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm bg-white/10 hover:bg-white/20 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed border border-white/20"
            >
              <Zap size={16} className={isGenerating ? 'animate-pulse' : ''} />
              {isGenerating ? 'Generating...' : 'Generate Now'}
            </button>
            <button
              onClick={() => setCurrentView('approvals')}
              className="relative flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm bg-amber-500 hover:bg-amber-600 text-white transition-all"
            >
              <Bell size={16} />
              Approval Queue
              {(pendingPosts + pendingMerch) > 0 && (
                <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {pendingPosts + pendingMerch}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Scheduler Status */}
      <div className={`rounded-xl p-4 border flex items-center gap-4 ${
        schedulerActive ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'
      }`}>
        <div className={`w-3 h-3 rounded-full ${schedulerActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
        <div className="flex-1">
          <p className={`font-bold text-sm ${schedulerActive ? 'text-emerald-800' : 'text-slate-600'}`}>
            {schedulerActive ? 'SCHEDULER ACTIVE — Running hourly 8:00 AM to 8:00 PM' : 'SCHEDULER PAUSED'}
          </p>
          {schedulerActive && (
            <p className="text-emerald-600 text-xs">
              {isInScheduleWindow
                ? `Next batch: ${format(nextHour, 'h:mm a')} · Today's window active`
                : 'Outside schedule window — will resume at 8:00 AM'}
            </p>
          )}
        </div>
        <Clock size={18} className={schedulerActive ? 'text-emerald-500' : 'text-slate-400'} />
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <button
            key={s.label}
            onClick={() => setCurrentView(s.view)}
            className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm hover:shadow-md transition-all text-left group"
          >
            <div className={`inline-flex p-2.5 rounded-xl bg-gradient-to-br ${s.color} mb-3`}>
              <s.icon size={18} className="text-white" />
            </div>
            <div className="text-3xl font-black text-slate-800">{s.value}</div>
            <div className="text-sm text-slate-500 font-medium mt-0.5">{s.label}</div>
          </button>
        ))}
      </div>

      {/* Hourly Schedule Grid */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Calendar size={18} className="text-purple-600" />
          <h2 className="font-bold text-slate-800">Today's Content Schedule</h2>
          <span className="text-xs text-slate-400 ml-auto">8 AM – 8 PM</span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {hourlySchedule.map(({ hour: h, label, batch }) => {
            const isPast = hour > h;
            const isCurrent = hour === h;
            const hasBatch = !!batch;
            const pendingInBatch = batch ? batch.posts.filter(p => p.status === 'pending').length + batch.merchandise.filter(m => m.status === 'pending').length : 0;

            return (
              <button
                key={h}
                onClick={() => batch && setCurrentView('approvals')}
                className={`relative p-2 rounded-xl text-center text-xs font-bold transition-all border ${
                  isCurrent
                    ? 'bg-purple-600 text-white border-purple-700 ring-2 ring-purple-300'
                    : hasBatch
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                    : isPast
                    ? 'bg-slate-50 text-slate-400 border-slate-100'
                    : 'bg-slate-50 text-slate-500 border-slate-100 hover:bg-slate-100'
                }`}
              >
                {label}
                {hasBatch && (
                  <div className="mt-1 text-[10px] opacity-80">✓ Done</div>
                )}
                {!hasBatch && !isPast && (
                  <div className="mt-1 text-[10px] opacity-60">Pending</div>
                )}
                {pendingInBatch > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-amber-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center">
                    {pendingInBatch}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Recent Batches */}
      {batches.length > 0 && (
        <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={18} className="text-purple-600" />
            <h2 className="font-bold text-slate-800">Recent Batches</h2>
          </div>
          <div className="space-y-3">
            {batches.slice(0, 5).map((batch) => {
              const pending = batch.posts.filter(p => p.status === 'pending').length + batch.merchandise.filter(m => m.status === 'pending').length;
              const approved = batch.posts.filter(p => p.status === 'approved' || p.status === 'posted').length;
              const rejected = batch.posts.filter(p => p.status === 'rejected').length;

              return (
                <div key={batch.id} className="flex items-center gap-4 p-3 rounded-xl bg-slate-50 border border-slate-100">
                  <div className="text-sm font-bold text-slate-600 w-20 shrink-0">
                    {format(batch.generatedAt, 'h:mm a')}
                  </div>
                  <div className="flex-1 flex gap-2 flex-wrap">
                    {batch.posts.map((post) => (
                      <span
                        key={post.id}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          post.status === 'approved' || post.status === 'posted'
                            ? 'bg-emerald-100 text-emerald-700'
                            : post.status === 'rejected'
                            ? 'bg-red-100 text-red-600'
                            : post.status === 'remix'
                            ? 'bg-blue-100 text-blue-600'
                            : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {post.platform}
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2 text-xs shrink-0">
                    {approved > 0 && <span className="text-emerald-600 flex items-center gap-1"><CheckCircle2 size={12} /> {approved}</span>}
                    {rejected > 0 && <span className="text-red-500 flex items-center gap-1"><XCircle size={12} /> {rejected}</span>}
                    {pending > 0 && <span className="text-amber-600 flex items-center gap-1"><RefreshCw size={12} /> {pending}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty State */}
      {batches.length === 0 && (
        <div className="bg-white rounded-2xl p-10 border border-dashed border-slate-200 text-center">
          <div className="text-5xl mb-4">✝️</div>
          <h3 className="text-xl font-bold text-slate-700 mb-2">No Posts Yet</h3>
          <p className="text-slate-500 mb-4 text-sm max-w-sm mx-auto">
            Upload images to your gallery, then start the scheduler or hit "Generate Now" to create your first batch.
          </p>
          <div className="flex justify-center gap-3">
            <button
              onClick={() => setCurrentView('gallery')}
              className="px-4 py-2 bg-purple-600 text-white rounded-xl font-semibold text-sm"
            >
              Upload Images
            </button>
            <button
              onClick={() => {
                triggerNow();
              }}
              className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold text-sm"
            >
              Generate Sample
            </button>
          </div>
        </div>
      )}

      {/* Notifications Panel */}
      {unreadNotifs > 0 && (
        <div className="bg-amber-50 rounded-2xl p-4 border border-amber-200">
          <div className="flex items-center gap-2 mb-3">
            <Bell size={16} className="text-amber-600" />
            <span className="font-bold text-amber-800 text-sm">{unreadNotifs} New Alert{unreadNotifs > 1 ? 's' : ''}</span>
          </div>
          <div className="space-y-2">
            {notifications.filter(n => !n.read).slice(0, 3).map((n) => (
              <div key={n.id} className="text-sm text-amber-700 bg-white rounded-lg p-2 border border-amber-100">
                {n.message}
              </div>
            ))}
          </div>
          <button
            onClick={() => setCurrentView('approvals')}
            className="mt-3 text-sm font-bold text-amber-700 underline"
          >
            Review Now →
          </button>
        </div>
      )}
    </div>
  );
}
