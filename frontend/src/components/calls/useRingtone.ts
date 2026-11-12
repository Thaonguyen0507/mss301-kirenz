import { useCallback, useEffect, useRef, useState } from 'react';

// Generate a small ringtone locally: no media downloads and no third-party audio assets.
export function useRingtone(ringing: boolean, incoming: boolean) {
  const context = useRef<AudioContext | null>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const enableSound = useCallback(() => {
    void context.current?.resume().then(() => setSoundBlocked(context.current?.state !== 'running')).catch(() => setSoundBlocked(true));
  }, []);

  useEffect(() => {
    if (!ringing || !window.AudioContext) return;
    const audio = new AudioContext();
    context.current = audio;
    let stopped = false;
    const ring = () => {
      if (audio.state !== 'running') { setSoundBlocked(true); return; }
      setSoundBlocked(false);
      const now = audio.currentTime;
      for (const offset of incoming ? [0, 0.3] : [0]) {
        for (const frequency of incoming ? [660, 880] : [425]) {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0, now + offset);
          gain.gain.linearRampToValueAtTime(0.045, now + offset + 0.025);
          gain.gain.setValueAtTime(0.045, now + offset + 0.17);
          gain.gain.linearRampToValueAtTime(0, now + offset + 0.23);
          oscillator.connect(gain); gain.connect(audio.destination);
          oscillator.start(now + offset); oscillator.stop(now + offset + 0.24);
        }
      }
    };
    void audio.resume().then(() => { if (!stopped) ring(); }).catch(() => setSoundBlocked(true));
    const interval = window.setInterval(ring, 2200);
    return () => {
      stopped = true; window.clearInterval(interval); context.current = null;
      void audio.close().catch(() => {}); setSoundBlocked(false);
    };
  }, [ringing, incoming]);

  return { soundBlocked, enableSound };
}
