import { useState } from 'react';
import { useStore } from '../store/useStore';
import { remixPost, remixMerchandise } from '../services/aiService';
import { format } from 'date-fns';
import {
  CheckCircle2, XCircle, RefreshCw, ExternalLink,
  ChevronDown, ChevronUp, Loader2, ShoppingBag
} from 'lucide-react';
import toast from 'react-hot-toast';
import type { SocialPost, MerchandiseIdea } from '../store/useStore';

const PLATFORM_COLORS: Record<string, string> = {
  TikTok: 'bg-black text-white',
  Facebook: 'bg-blue-600 text-white',
  Instagram: 'bg-gradient-to-r from-purple-500 to-pink-500 text-white',
  Twitter: 'bg-sky-500 text-white',
};

const PLATFORM_ICONS: Record<string, string> = {
  TikTok: '🎵',
  Facebook: '📘',
  Instagram: '📸',
  Twitter: '🐦',
};

function RemixModal({ onConfirm, onCancel }: { onConfirm: (notes: string) => void; onCancel: () => void }) {
  const [notes, setNotes] = useState('');
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl">
        <h3 className="text-lg font-bold text-slate-800 mb-2">🎛 Remix Instructions</h3>
        <p className="text-sm text-slate-500 mb-4">
          Tell the AI what to change. It'll go back to the lab and tweak it.
        </p>
        <textarea
          className="w-full border border-slate-200 rounded-xl p-3 text-sm min-h-[100px] focus:outline-none focus:ring-2 focus:ring-purple-400 resize-none"
          placeholder="e.g. 'Make it more hopeful' or 'Change the design to be more urban' or 'Add a Bible verse about redemption'"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          autoFocus
        />
        <div className="flex gap-3 mt-4">
          <button
            onClick={() => onConfirm(notes)}
            disabled={!notes.trim()}
            className="flex-1 bg-blue-600 text-white py-2.5 rounded-xl font-bold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send to Lab 🧪
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm hover:bg-slate-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function PostCard({ post, batchId }: { post: SocialPost; batchId: string }) {
  const { updatePostStatus, gallery: galleryImages } = useStore();
  const [expanded, setExpanded] = useState(false);
  const [remixing, setRemixing] = useState(false);
  const [showRemixModal, setShowRemixModal] = useState(false);

  const handleApprove = () => {
    updatePostStatus(batchId, post.id, 'posted');
    toast.success(`✅ ${post.platform} post approved & marked as posted!`);
  };

  const handleReject = () => {
    updatePostStatus(batchId, post.id, 'rejected');
    toast('🗑 Post rejected and recycled.', { icon: '♻️' });
  };

  const handleRemix = async (notes: string) => {
    setShowRemixModal(false);
    setRemixing(true);
    try {
      toast.loading(`🧪 Remixing your ${post.platform} post...`, { id: `remix-${post.id}` });
      const remixed = await remixPost(post, galleryImages, notes);
      useStore.setState((state) => ({
        batches: state.batches.map(b =>
          b.id === batchId
            ? { ...b, posts: b.posts.map(p => p.id === post.id ? remixed : p) }
            : b
        )
      }));
      toast.success(`✅ ${post.platform} post remixed!`, { id: `remix-${post.id}` });
    } catch (e) {
      toast.error('Remix failed. Try again.', { id: `remix-${post.id}` });
    } finally {
      setRemixing(false);
    }
  };

  const isActionable = post.status === 'pending' || post.status === 'remix';

  return (
    <>
      {showRemixModal && (
        <RemixModal onConfirm={handleRemix} onCancel={() => setShowRemixModal(false)} />
      )}
      <div className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all ${
        post.status === 'posted' || post.status === 'approved' ? 'border-emerald-200 opacity-75' :
        post.status === 'rejected' ? 'border-red-200 opacity-60' :
        'border-slate-200'
      }`}>
        {/* Header */}
        <div className="p-4 flex items-center gap-3">
          <span className={`text-xs font-black px-3 py-1 rounded-full ${PLATFORM_COLORS[post.platform]}`}>
            {PLATFORM_ICONS[post.platform]} {post.platform}
          </span>
          <span className="text-xs text-slate-400">{format(post.generatedAt, 'h:mm a')}</span>
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-bold ${
            post.status === 'posted' || post.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
            post.status === 'rejected' ? 'bg-red-100 text-red-600' :
            post.status === 'remix' ? 'bg-blue-100 text-blue-600' :
            'bg-amber-100 text-amber-700'
          }`}>
            {post.status === 'posted' ? 'POSTED ✓' : post.status.toUpperCase()}
          </span>
        </div>

        {/* Image */}
        {post.imageUrl && (
          <div className="relative">
            <img
              src={post.imageUrl}
              alt="Post visual"
              className="w-full h-48 object-cover"
              loading="lazy"
            />
          </div>
        )}

        {/* Content */}
        <div className="p-4">
          <p className="text-slate-700 text-sm leading-relaxed">{post.content}</p>
          {post.hashtags.length > 0 && (
            <p className="mt-2 text-blue-500 text-sm">
              {post.hashtags.join(' ')}
            </p>
          )}

          {post.remixNotes && (
            <div className="mt-2 text-xs text-blue-600 bg-blue-50 rounded-lg p-2">
              🎛 Remix note: "{post.remixNotes}"
            </div>
          )}

          {/* Expand */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-slate-400 mt-2 hover:text-slate-600"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded ? 'Hide details' : 'Show image prompt'}
          </button>

          {expanded && (
            <div className="mt-2 text-xs text-slate-500 bg-slate-50 rounded-lg p-2">
              <span className="font-bold">Image prompt:</span> {post.imagePrompt}
            </div>
          )}
        </div>

        {/* Actions */}
        {isActionable && (
          <div className="px-4 pb-4 flex gap-2">
            <button
              onClick={handleApprove}
              className="flex-1 flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white py-2 rounded-xl font-bold text-sm transition-all"
            >
              <CheckCircle2 size={16} /> Approve & Post
            </button>
            <button
              onClick={() => setShowRemixModal(true)}
              disabled={remixing}
              className="flex-1 flex items-center justify-center gap-2 bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-xl font-bold text-sm transition-all disabled:opacity-50"
            >
              {remixing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Remix
            </button>
            <button
              onClick={handleReject}
              className="flex items-center justify-center gap-2 bg-red-100 hover:bg-red-200 text-red-600 py-2 px-3 rounded-xl font-bold text-sm transition-all"
            >
              <XCircle size={16} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function MerchCard({ item, batchId }: { item: MerchandiseIdea; batchId: string }) {
  const { updateMerchandiseStatus } = useStore();
  const [showRemixModal, setShowRemixModal] = useState(false);
  const [remixing, setRemixing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleApprove = () => {
    updateMerchandiseStatus(batchId, item.id, 'approved');
    toast.success(`✅ Merch idea approved! Check ${item.printProvider} to start production.`);
  };

  const handleReject = () => {
    updateMerchandiseStatus(batchId, item.id, 'rejected');
    toast('🗑 Merch idea rejected.', { icon: '♻️' });
  };

  const handleRemix = async (notes: string) => {
    setShowRemixModal(false);
    setRemixing(true);
    try {
      toast.loading(`🧪 Remixing merch idea...`, { id: `remix-merch-${item.id}` });
      const remixed = await remixMerchandise(item, notes);
      useStore.setState((state) => ({
        batches: state.batches.map(b =>
          b.id === batchId
            ? { ...b, merchandise: b.merchandise.map(m => m.id === item.id ? remixed : m) }
            : b
        )
      }));
      toast.success('✅ Merch idea remixed!', { id: `remix-merch-${item.id}` });
    } catch (e) {
      toast.error('Remix failed.', { id: `remix-merch-${item.id}` });
    } finally {
      setRemixing(false);
    }
  };

  const isActionable = item.status === 'pending' || item.status === 'remix';

  return (
    <>
      {showRemixModal && (
        <RemixModal onConfirm={handleRemix} onCancel={() => setShowRemixModal(false)} />
      )}
      <div className={`bg-white rounded-2xl border shadow-sm overflow-hidden ${
        item.status === 'approved' ? 'border-emerald-200 opacity-75' :
        item.status === 'rejected' ? 'border-red-200 opacity-60' :
        'border-slate-200'
      }`}>
        {/* Header */}
        <div className="p-4 flex items-center gap-3">
          <span className="text-xs font-black px-3 py-1 rounded-full bg-pink-100 text-pink-700">
            <ShoppingBag size={12} className="inline mr-1" />{item.category}
          </span>
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-bold ${
            item.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
            item.status === 'rejected' ? 'bg-red-100 text-red-600' :
            item.status === 'remix' ? 'bg-blue-100 text-blue-600' :
            'bg-amber-100 text-amber-700'
          }`}>
            {item.status.toUpperCase()}
          </span>
        </div>

        {/* Product Image */}
        {item.imageUrl && (
          <img src={item.imageUrl} alt={item.title} className="w-full h-48 object-cover" loading="lazy" />
        )}

        <div className="p-4">
          <h3 className="font-bold text-slate-800">{item.title}</h3>
          <p className="text-sm text-slate-500 mt-1 leading-relaxed">{item.description}</p>

          {/* Economics */}
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="bg-slate-50 rounded-lg p-2 text-center">
              <div className="text-xs text-slate-400">Est. Cost</div>
              <div className="text-sm font-bold text-slate-700">{item.estimatedCost}</div>
            </div>
            <div className="bg-emerald-50 rounded-lg p-2 text-center">
              <div className="text-xs text-slate-400">Margin</div>
              <div className="text-sm font-bold text-emerald-700">{item.profitMargin}</div>
            </div>
            <div className="bg-blue-50 rounded-lg p-2 text-center">
              <div className="text-xs text-slate-400">Provider</div>
              <div className="text-xs font-bold text-blue-700">{item.printProvider}</div>
            </div>
          </div>

          {/* Provider Link */}
          <a
            href={item.printProviderUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 mt-2"
          >
            <ExternalLink size={12} /> Open {item.printProvider} →
          </a>

          {item.remixNotes && (
            <div className="mt-2 text-xs text-blue-600 bg-blue-50 rounded-lg p-2">
              🎛 Remix note: "{item.remixNotes}"
            </div>
          )}

          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-slate-400 mt-2 hover:text-slate-600"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded ? 'Hide' : 'Show image prompt'}
          </button>
          {expanded && (
            <div className="mt-1 text-xs text-slate-500 bg-slate-50 rounded-lg p-2">
              {item.imagePrompt}
            </div>
          )}
        </div>

        {/* Actions */}
        {isActionable && (
          <div className="px-4 pb-4 flex gap-2">
            <button
              onClick={handleApprove}
              className="flex-1 flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white py-2 rounded-xl font-bold text-sm"
            >
              <CheckCircle2 size={16} /> Approve
            </button>
            <button
              onClick={() => setShowRemixModal(true)}
              disabled={remixing}
              className="flex-1 flex items-center justify-center gap-2 bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-xl font-bold text-sm disabled:opacity-50"
            >
              {remixing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Remix
            </button>
            <button
              onClick={handleReject}
              className="flex items-center justify-center gap-2 bg-red-100 hover:bg-red-200 text-red-600 py-2 px-3 rounded-xl font-bold text-sm"
            >
              <XCircle size={16} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export function ApprovalQueue() {
  const { batches, markNotificationRead, notifications } = useStore();
  const [tab, setTab] = useState<'posts' | 'merch'>('posts');
  const [batchFilter, setBatchFilter] = useState<'all' | 'pending'>('pending');

  // Mark all alerts as read
  const unreadBatchNotifs = notifications.filter(n => !n.read && n.type === 'alert');
  if (unreadBatchNotifs.length > 0) {
    unreadBatchNotifs.forEach(n => markNotificationRead(n.id));
  }

  const filteredBatches = batchFilter === 'pending'
    ? batches.filter(b =>
        b.posts.some(p => p.status === 'pending' || p.status === 'remix') ||
        b.merchandise.some(m => m.status === 'pending' || m.status === 'remix')
      )
    : batches;

  const totalPending = batches.flatMap(b => b.posts).filter(p => p.status === 'pending').length +
    batches.flatMap(b => b.merchandise).filter(m => m.status === 'pending').length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black text-slate-800 mb-1">Approval Queue</h2>
        <p className="text-slate-500 text-sm">
          Review, approve, remix, or reject AI-generated posts and merchandise ideas.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-3 flex-wrap">
        <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
          <button
            onClick={() => setTab('posts')}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              tab === 'posts' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-600'
            }`}
          >
            📱 Social Posts
          </button>
          <button
            onClick={() => setTab('merch')}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              tab === 'merch' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-600'
            }`}
          >
            🛍 Merchandise
          </button>
        </div>
        <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
          <button
            onClick={() => setBatchFilter('pending')}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              batchFilter === 'pending' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-600'
            }`}
          >
            Pending ({totalPending})
          </button>
          <button
            onClick={() => setBatchFilter('all')}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              batchFilter === 'all' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-600'
            }`}
          >
            All History
          </button>
        </div>
      </div>

      {filteredBatches.length === 0 && (
        <div className="text-center py-16 text-slate-400">
          <p className="text-4xl mb-3">🎉</p>
          <p className="font-bold text-lg">All caught up!</p>
          <p className="text-sm">No pending items to review right now.</p>
        </div>
      )}

      {/* Batch Sections */}
      {filteredBatches.map((batch) => (
        <div key={batch.id} className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs font-bold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
              Batch — {format(batch.generatedAt, 'MMM d · h:mm a')}
            </span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          {tab === 'posts' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {batch.posts
                .filter(p => batchFilter === 'all' || p.status === 'pending' || p.status === 'remix')
                .map((post) => (
                  <PostCard key={post.id} post={post} batchId={batch.id} />
                ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {batch.merchandise
                .filter(m => batchFilter === 'all' || m.status === 'pending' || m.status === 'remix')
                .map((item) => (
                  <MerchCard key={item.id} item={item} batchId={batch.id} />
                ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
