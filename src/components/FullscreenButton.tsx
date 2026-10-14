import { useEffect, useState } from 'react';

export function FullscreenButton() {
  const [active, setActive] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const onChange = () => setActive(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  if (!document.fullscreenEnabled) return null;

  const toggle = () => {
    const request = active ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    request.catch(() => {});
  };
  return (
    <button className="btn btn-ghost btn-icon" onClick={toggle} title={active ? 'Exit fullscreen' : 'Fullscreen'}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
        {active ? (
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        ) : (
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        )}
      </svg>
      <span className="sr-only">{active ? 'Exit fullscreen' : 'Fullscreen'}</span>
    </button>
  );
}
