export function SiteHeader({
  showBrand = true,
  status,
}: {
  showBrand?: boolean;
  status?: string;
}) {
  return (
    <header className={showBrand ? undefined : "table-header"}>
      {showBrand && <a className="home-brand" href="/">Pokerville</a>}
      <nav className="header-actions" aria-label="Primary navigation">
        <a className="page-link" href="/lobby">Lobby</a>
        <a className="page-link" href="/leaderboard">Leaderboard</a>
        <a
          aria-label="Pokerville on GitHub"
          className="github-link"
          href="https://github.com/TalkWIthKeyboard/agent-poker"
          rel="noreferrer"
          target="_blank"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.69c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.58 9.58 0 0 1 12 6.7c.85 0 1.71.12 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85V21c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
          </svg>
        </a>
        {status && <div className="connection"><span />{status}</div>}
      </nav>
    </header>
  );
}
