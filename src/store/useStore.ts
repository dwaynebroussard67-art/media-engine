import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { currentBrand, type Brand } from '../config/brands';
import { v4 as uuidv4 } from 'uuid';
import {
  extractFeatures, eventsFromDecision, curate, tasteDirective,
  type TasteEvent, type TasteProfile, type Decision,
} from '../lib/tasteMemory';
import {
  pushBatch, pullBatches, pushDecision, pushTasteEvents, pullTasteEvents, syncEnabled,
} from '../lib/syncService';
import { permanentAssetsForBrand } from '../lib/permanentAssets';

export type PostStatus = 'pending' | 'approved' | 'rejected' | 'remix' | 'posted';
export type PostPlatform = 'TikTok' | 'Facebook' | 'Instagram' | 'Twitter';
export type MerchandiseStatus = 'pending' | 'approved' | 'rejected' | 'remix';

export interface GalleryImage {
  id: string; url: string; name: string; uploadedAt: number; dataUrl?: string; permanent?: boolean;
}

export interface SocialPost {
  id: string; platform: PostPlatform; content: string; imagePrompt: string;
  imageUrl?: string; hashtags: string[]; status: PostStatus; generatedAt: number;
  batchId: string; remixNotes?: string;
}

export interface MerchandiseIdea {
  id: string; title: string; description: string; imagePrompt: string; imageUrl?: string;
  category: string; estimatedCost: string; printProvider: string; printProviderUrl: string;
  profitMargin: string; status: MerchandiseStatus; generatedAt: number; batchId: string; remixNotes?: string;
}

export interface PostBatch {
  id: string; generatedAt: number; scheduledFor: number; posts: SocialPost[];
  merchandise: MerchandiseIdea[]; alertSent: boolean; hourSlot: number;
}

export interface Notification {
  id: string; message: string; type: 'alert' | 'success' | 'info' | 'warning';
  timestamp: number; read: boolean; batchId?: string;
}

// map UI status → taste decision (only these three move taste)
function decisionFor(status: string): Decision | null {
  if (status === 'approved') return 'approved';
  if (status === 'rejected') return 'rejected';
  if (status === 'remix') return 'remix';
  return null;
}

interface AppState {
  gallery: GalleryImage[];
  batches: PostBatch[];
  notifications: Notification[];
  tasteEvents: TasteEvent[];
  schedulerActive: boolean;
  brand: Brand;
  currentView: string;
  isGenerating: boolean;
  cloudSynced: boolean;

  addGalleryImage: (img: GalleryImage) => void;
  removeGalleryImage: (id: string) => void;
  seedPermanentGallery: () => void;

  addBatch: (batch: PostBatch) => void;
  updatePostStatus: (batchId: string, postId: string, status: PostStatus, notes?: string) => void;
  updateMerchandiseStatus: (batchId: string, itemId: string, status: MerchandiseStatus, notes?: string) => void;

  addNotification: (n: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void;
  markNotificationRead: (id: string) => void;
  clearAllNotifications: () => void;

  setSchedulerActive: (v: boolean) => void;
  setBrand: (b: Brand) => void;
  setCurrentView: (v: string) => void;
  setIsGenerating: (v: boolean) => void;

  // memory + cloud
  getTasteProfile: (brand?: Brand) => TasteProfile;
  getTasteDirective: (brand?: Brand) => string;
  hydrateFromCloud: () => Promise<void>;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      gallery: [],
      batches: [],
      notifications: [],
      tasteEvents: [],
      schedulerActive: false,
      brand: currentBrand(),
      currentView: 'dashboard',
      isGenerating: false,
      cloudSynced: false,

      addGalleryImage: (img) => set((s) => ({ gallery: [...s.gallery, img] })),

      // permanent images can never be removed from the gallery
      removeGalleryImage: (id) =>
        set((s) => ({ gallery: s.gallery.filter((g) => g.id !== id || g.permanent) })),

      // Bake the permanent images into the gallery (idempotent).
      seedPermanentGallery: () =>
        set((s) => {
          const perms = permanentAssetsForBrand(s.brand).map((a) => ({
            id: a.id, url: a.url, name: a.name, uploadedAt: 0, permanent: true as const,
          }));
          const have = new Set(s.gallery.map((g) => g.id));
          const add = perms.filter((p) => !have.has(p.id));
          return add.length ? { gallery: [...add, ...s.gallery] } : {};
        }),

      addBatch: (batch) => {
        set((s) => ({ batches: [batch, ...s.batches] }));
        void pushBatch(batch);
      },

      updatePostStatus: (batchId, postId, status, notes) => {
        const state = get();
        const batch = state.batches.find((b) => b.id === batchId);
        const post = batch?.posts.find((p) => p.id === postId);
        const newEvents: TasteEvent[] = [];
        const d = decisionFor(status);
        if (post && d) {
          const feats = extractFeatures({
            platform: post.platform, content: post.content,
            imagePrompt: post.imagePrompt, hashtags: post.hashtags,
          });
          newEvents.push(...eventsFromDecision(state.brand, d, post.id, feats, Date.now(), uuidv4));
        }
        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === batchId
              ? { ...b, posts: b.posts.map((p) => (p.id === postId ? { ...p, status, remixNotes: notes ?? p.remixNotes } : p)) }
              : b
          ),
          tasteEvents: newEvents.length ? [...newEvents, ...s.tasteEvents] : s.tasteEvents,
        }));
        void pushDecision(postId, 'post', status, notes);
        if (newEvents.length) void pushTasteEvents(newEvents);
      },

      updateMerchandiseStatus: (batchId, itemId, status, notes) => {
        const state = get();
        const batch = state.batches.find((b) => b.id === batchId);
        const item = batch?.merchandise.find((m) => m.id === itemId);
        const newEvents: TasteEvent[] = [];
        const d = decisionFor(status);
        if (item && d) {
          const feats = extractFeatures({
            content: `${item.title} ${item.description}`, imagePrompt: item.imagePrompt,
            merchCategory: item.category,
          });
          newEvents.push(...eventsFromDecision(state.brand, d, item.id, feats, Date.now(), uuidv4));
        }
        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === batchId
              ? { ...b, merchandise: b.merchandise.map((m) => (m.id === itemId ? { ...m, status, remixNotes: notes ?? m.remixNotes } : m)) }
              : b
          ),
          tasteEvents: newEvents.length ? [...newEvents, ...s.tasteEvents] : s.tasteEvents,
        }));
        void pushDecision(itemId, 'merch', status, notes);
        if (newEvents.length) void pushTasteEvents(newEvents);
      },

      addNotification: (n) =>
        set((s) => ({
          notifications: [{ ...n, id: uuidv4(), timestamp: Date.now(), read: false }, ...s.notifications].slice(0, 50),
        })),

      markNotificationRead: (id) =>
        set((s) => ({ notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)) })),

      clearAllNotifications: () => set({ notifications: [] }),

      setSchedulerActive: (v) => set({ schedulerActive: v }),
      setBrand: (b) => { set({ brand: b }); get().seedPermanentGallery(); },
      setCurrentView: (v) => set({ currentView: v }),
      setIsGenerating: (v) => set({ isGenerating: v }),

      // ---- memory ----
      getTasteProfile: (brand) => curate(get().tasteEvents, brand ?? get().brand),
      getTasteDirective: (brand) => tasteDirective(curate(get().tasteEvents, brand ?? get().brand)),

      // ---- cloud hydrate: merge Supabase truth into local (union, no deletes) ----
      hydrateFromCloud: async () => {
        if (!syncEnabled) return;
        const [cloudBatches, cloudEvents] = await Promise.all([pullBatches(), pullTasteEvents()]);
        set((s) => {
          const haveBatch = new Set(s.batches.map((b) => b.id));
          const mergedBatches = [...s.batches, ...cloudBatches.filter((b) => !haveBatch.has(b.id))]
            .sort((a, b) => b.generatedAt - a.generatedAt);
          const haveEvent = new Set(s.tasteEvents.map((e) => e.id));
          const mergedEvents = [...cloudEvents.filter((e) => !haveEvent.has(e.id)), ...s.tasteEvents]
            .sort((a, b) => b.at - a.at);
          return { batches: mergedBatches, tasteEvents: mergedEvents, cloudSynced: true };
        });
      },
    }),
    { name: 'misfit-ministries-store' }
  )
);
