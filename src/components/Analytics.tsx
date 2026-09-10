import { useStore } from '../store/useStore';
import { format } from 'date-fns';
import { TrendingUp, CheckCircle2, XCircle, RefreshCw, ShoppingBag, Share2 } from 'lucide-react';

const PLATFORM_COLORS: Record<string, string> = {
  TikTok: '#000000',
  Facebook: '#1877F2',
  Instagram: '#E1306C',
  Twitter: '#1DA1F2',
};

export function Analytics() {
  const { batches } = useStore();

  const allPosts = batches.flatMap((b) => b.posts);
  const allMerch = batches.flatMap((b) => b.merchandise);

  const platforms = ['TikTok', 'Facebook', 'Instagram', 'Twitter'];
  const platformStats = platforms.map((p) => {
    const posts = allPosts.filter((post) => post.platform === p);
    return {
      platform: p,
      total: posts.length,
      approved: posts.filter((post) => post.status === 'approved' || post.status === 'posted').length,
      rejected: posts.filter((post) => post.status === 'rejected').length,
      pending: posts.filter((post) => post.status === 'pending').length,
      remix: posts.filter((post) => post.status === 'remix').length,
    };
  });

  const totalApproved = allPosts.filter((p) => p.status === 'approved' || p.status === 'posted').length;
  const totalRejected = allPosts.filter((p) => p.status === 'rejected').length;
  const totalRemix = allPosts.filter((p) => p.status === 'remix').length;
  const totalPending = allPosts.filter((p) => p.status === 'pending').length;
  const approvalRate = allPosts.length > 0
    ? Math.round((totalApproved / allPosts.length) * 100)
    : 0;

  const merchApproved = allMerch.filter((m) => m.status === 'approved').length;
  const merchRejected = allMerch.filter((m) => m.status === 'rejected').length;

  const topMerchCategories = allMerch.reduce<Record<string, number>>((acc, m) => {
    acc[m.category] = (acc[m.category] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black text-slate-800 mb-1">Analytics</h2>
        <p className="text-slate-500 text-sm">Track your content generation and approval activity.</p>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <Share2 size={20} className="text-purple-500 mb-2" />
          <div className="text-3xl font-black text-slate-800">{allPosts.length}</div>
          <div className="text-sm text-slate-500">Total Posts</div>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <CheckCircle2 size={20} className="text-emerald-500 mb-2" />
          <div className="text-3xl font-black text-emerald-600">{totalApproved}</div>
          <div className="text-sm text-slate-500">Posts Posted</div>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <TrendingUp size={20} className="text-blue-500 mb-2" />
          <div className="text-3xl font-black text-blue-600">{approvalRate}%</div>
          <div className="text-sm text-slate-500">Approval Rate</div>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <ShoppingBag size={20} className="text-pink-500 mb-2" />
          <div className="text-3xl font-black text-pink-600">{allMerch.length}</div>
          <div className="text-sm text-slate-500">Merch Ideas</div>
        </div>
      </div>

      {/* Post Status Breakdown */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
        <h3 className="font-bold text-slate-800 mb-4">Post Status Overview</h3>
        <div className="space-y-3">
          {[
            { label: 'Approved / Posted', count: totalApproved, color: 'bg-emerald-500', icon: CheckCircle2 },
            { label: 'Pending Review', count: totalPending, color: 'bg-amber-400', icon: RefreshCw },
            { label: 'Sent to Remix', count: totalRemix, color: 'bg-blue-500', icon: RefreshCw },
            { label: 'Rejected', count: totalRejected, color: 'bg-red-400', icon: XCircle },
          ].map(({ label, count, color, icon: Icon }) => (
            <div key={label} className="flex items-center gap-3">
              <Icon size={16} className="text-slate-400 shrink-0" />
              <span className="text-sm text-slate-600 w-36 shrink-0">{label}</span>
              <div className="flex-1 bg-slate-100 rounded-full h-3 overflow-hidden">
                <div
                  className={`h-full rounded-full ${color} transition-all`}
                  style={{ width: `${allPosts.length > 0 ? (count / allPosts.length) * 100 : 0}%` }}
                />
              </div>
              <span className="text-sm font-bold text-slate-700 w-8 text-right">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Platform Breakdown */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
        <h3 className="font-bold text-slate-800 mb-4">Platform Breakdown</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {platformStats.map((ps) => (
            <div key={ps.platform} className="rounded-xl border border-slate-100 p-4 text-center">
              <div
                className="text-sm font-black mb-2 px-2 py-0.5 rounded-full inline-block text-white"
                style={{ backgroundColor: PLATFORM_COLORS[ps.platform] }}
              >
                {ps.platform}
              </div>
              <div className="text-2xl font-black text-slate-800">{ps.total}</div>
              <div className="text-xs text-slate-500">posts generated</div>
              <div className="mt-2 grid grid-cols-3 gap-1">
                <div className="text-center">
                  <div className="text-xs font-bold text-emerald-600">{ps.approved}</div>
                  <div className="text-[10px] text-slate-400">Posted</div>
                </div>
                <div className="text-center">
                  <div className="text-xs font-bold text-red-500">{ps.rejected}</div>
                  <div className="text-[10px] text-slate-400">Rejected</div>
                </div>
                <div className="text-center">
                  <div className="text-xs font-bold text-blue-500">{ps.remix}</div>
                  <div className="text-[10px] text-slate-400">Remixed</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Merchandise Analytics */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
        <h3 className="font-bold text-slate-800 mb-4">Merchandise Ideas</h3>
        <div className="flex gap-6 mb-4">
          <div>
            <span className="text-2xl font-black text-emerald-600">{merchApproved}</span>
            <span className="text-sm text-slate-500 ml-1">Approved</span>
          </div>
          <div>
            <span className="text-2xl font-black text-red-500">{merchRejected}</span>
            <span className="text-sm text-slate-500 ml-1">Rejected</span>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {Object.entries(topMerchCategories).map(([cat, count]) => (
            <div key={cat} className="bg-pink-50 rounded-xl p-3 flex items-center justify-between border border-pink-100">
              <span className="text-sm font-medium text-pink-800">{cat}</span>
              <span className="text-sm font-black text-pink-600">{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Activity Timeline */}
      {batches.length > 0 && (
        <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
          <h3 className="font-bold text-slate-800 mb-4">Generation History</h3>
          <div className="space-y-2">
            {batches.map((batch) => (
              <div key={batch.id} className="flex items-center gap-3 text-sm">
                <div className="w-16 text-xs text-slate-400 shrink-0 font-mono">
                  {format(batch.generatedAt, 'h:mm a')}
                </div>
                <div className="w-2 h-2 rounded-full bg-purple-500 shrink-0" />
                <div className="flex-1 text-slate-600">
                  Generated {batch.posts.length} posts + {batch.merchandise.length} merch ideas
                </div>
                <div className="text-xs text-slate-400">
                  {format(batch.generatedAt, 'MMM d')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {batches.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <TrendingUp size={40} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No data yet</p>
          <p className="text-sm">Generate some content to see analytics</p>
        </div>
      )}
    </div>
  );
}
