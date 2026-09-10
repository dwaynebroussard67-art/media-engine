import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { BRANDS, currentBrand, nextSwitch } from '../config/brands';

// No manual switch — the active brand follows the clock and syncs the store.
export default function BrandSwitcher() {
  const setBrand = useStore((s) => s.setBrand);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => { const d = new Date(); setNow(d); setBrand(currentBrand(d)); };
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, [setBrand]);

  const active = currentBrand(now);
  const nxt = nextSwitch(now);
  const cfg = BRANDS[active];
  return (
    <div style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 9999,
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderRadius: 999,
      background: 'rgba(17,17,20,.92)', border: '1px solid rgba(255,255,255,.12)',
      boxShadow: '0 10px 30px -12px rgba(0,0,0,.6)', backdropFilter: 'blur(8px)',
      fontFamily: 'inherit', fontSize: 13, color: '#fff' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#36d399',
        boxShadow: '0 0 0 0 rgba(54,211,153,.6)', animation: 'pulse 2.4s infinite' }} />
      <span style={{ opacity: .6 }}>Now creating:</span>
      <b style={{ background: active === 'forge' ? 'linear-gradient(180deg,#FF5A1F,#C73A0A)' : 'linear-gradient(180deg,#7048e8,#4521a8)',
        WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', fontWeight: 700 }}>
        {cfg.emoji} {cfg.name}
      </b>
      <span style={{ opacity: .45, fontSize: 11 }}>→ {BRANDS[nxt.to].name} at {nxt.at}</span>
      <style>{`@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(54,211,153,.55)}70%{box-shadow:0 0 0 7px rgba(54,211,153,0)}100%{box-shadow:0 0 0 0 rgba(54,211,153,0)}}`}</style>
    </div>
  );
}
