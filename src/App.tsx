import { useState } from 'react';
import { FullscreenButton } from './components/FullscreenButton';
import { TopbarSlotContext } from './components/TopbarSlot';
import { loadSession } from './net/socket';
import { Home } from './pages/Home';
import { MultiplayerMode } from './pages/MultiplayerMode';
import { SoloMode } from './pages/SoloMode';

type View = 'home' | 'solo' | 'multiplayer';

function roomFromUrl(): string {
  const code = new URLSearchParams(window.location.search).get('room') ?? '';
  return /^[A-Za-z0-9]{6}$/.test(code) ? code.toUpperCase() : '';
}

export function App() {
  // A stored session (page refresh) or an invite link opens multiplayer directly.
  const [view, setView] = useState<View>(() => (loadSession() || roomFromUrl() ? 'multiplayer' : 'home'));
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const goHome = () => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    setView('home');
  };

  return (
    <TopbarSlotContext.Provider value={slot}>
      <div className="app">
        <header className="topbar">
          <span className="brand">
            TYPE<span>RACE</span>
          </span>
          <div className="topbar-actions" ref={setSlot} />
          <FullscreenButton />
        </header>
        <main className="screen">
          {view === 'home' && <Home onSolo={() => setView('solo')} onMultiplayer={() => setView('multiplayer')} />}
          {view === 'solo' && <SoloMode onExit={goHome} />}
          {view === 'multiplayer' && <MultiplayerMode onExit={goHome} initialCode={roomFromUrl()} />}
        </main>
      </div>
    </TopbarSlotContext.Provider>
  );
}
