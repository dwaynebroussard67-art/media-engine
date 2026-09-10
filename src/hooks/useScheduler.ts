import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { generateBatch } from '../services/aiService';
import { currentBrand, BRANDS } from '../config/brands';
import toast from 'react-hot-toast';

// Hours when the scheduler runs: 8 AM to 8 PM (hour 8–20, triggers at each whole hour)
const START_HOUR = 8;
const END_HOUR = 20;

export function useScheduler() {
  const { schedulerActive, gallery, brand, addBatch, addNotification, setIsGenerating } = useStore();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastGeneratedHour = useRef<number>(-1);

  const runGeneration = useCallback(
    async (hourSlot: number) => {
      setIsGenerating(true);
      try {
        toast.loading('🤖 Generating your hourly posts & merch ideas...', { id: 'generating', duration: 60000 });
        const activeBrand = currentBrand();
        const batch = await generateBatch(gallery, hourSlot, activeBrand);
        addBatch(batch);
        addNotification({
          message: `📱 ${BRANDS[activeBrand].emoji} ${BRANDS[activeBrand].name} — hour ${hourSlot}:00: 4 posts + 4 ideas ready!`,
          type: 'alert',
          batchId: batch.id,
        });
        toast.success('✅ New batch ready! Check your approval queue.', { id: 'generating', duration: 5000 });

        // Browser notification if permission granted
        if (Notification.permission === 'granted') {
          new Notification('Misfit Ministries — Posts Ready!', {
            body: `Your ${hourSlot}:00 batch of posts and merch ideas is ready for approval.`,
            icon: '/favicon.ico',
          });
        }
      } catch (e) {
        console.error('Generation failed:', e);
        toast.error('Generation failed. Will retry next hour.', { id: 'generating' });
      } finally {
        setIsGenerating(false);
      }
    },
    [gallery, brand, addBatch, addNotification, setIsGenerating]
  );

  useEffect(() => {
    if (!schedulerActive) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    // Request browser notification permission
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Check every 60 seconds if we've crossed an hour boundary
    const check = () => {
      const now = new Date();
      const hour = now.getHours();
      const minutes = now.getMinutes();

      // Only trigger if within 8AM–8PM and we haven't already generated this hour
      if (hour >= START_HOUR && hour < END_HOUR && minutes === 0 && lastGeneratedHour.current !== hour) {
        lastGeneratedHour.current = hour;
        runGeneration(hour);
      }
    };

    timerRef.current = setInterval(check, 60 * 1000);
    check(); // Run immediately on mount to see if we should trigger

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [schedulerActive, runGeneration]);

  // Manual trigger for testing
  const triggerNow = useCallback(async () => {
    const hour = new Date().getHours();
    lastGeneratedHour.current = hour;
    await runGeneration(hour);
  }, [runGeneration]);

  return { triggerNow };
}
