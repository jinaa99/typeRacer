import { useEffect } from 'react';
import { FallingLetters } from '../components/FallingLetters';

export function Home({ onSolo, onMultiplayer }: { onSolo: () => void; onMultiplayer: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === '1') onSolo();
      if (e.key === '2') onMultiplayer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSolo, onMultiplayer]);

  return (
    <div className="home">
      <FallingLetters />
      <div className="home-content">
        <h1 className="home-title">
          TYPE<span>RACE</span>
        </h1>
        <p className="home-tagline">Notes fall. You type. Every key hits the line.</p>

        <div className="hitline-deco" aria-hidden="true">
          <span className="lane-0" />
          <span className="lane-1" />
          <span className="lane-2" />
          <span className="lane-3" />
        </div>

        <div className="mode-cards">
          <button className="mode-card lane-0" onClick={onSolo}>
            <span className="mode-note">S</span>
            <span className="mode-name">Solo race</span>
            <span className="mode-desc">Race the clock on Easy, Medium or Hard. No account needed.</span>
            <kbd>1</kbd>
          </button>
          <button className="mode-card lane-2" onClick={onMultiplayer}>
            <span className="mode-note">M</span>
            <span className="mode-name">Multiplayer</span>
            <span className="mode-desc">Create a private room, share the code, and race 2–8 friends live.</span>
            <kbd>2</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
