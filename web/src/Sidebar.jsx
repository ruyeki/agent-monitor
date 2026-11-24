const LIVE_LABEL = { live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting' };

const svgProps = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' };
const ICON = {
  monitor: (
    <svg {...svgProps}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 9h18" />
    </svg>
  ),
  workflow: (
    <svg {...svgProps}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 6h7M6 8.5v3a4 4 0 0 0 4 4h5.5" />
    </svg>
  ),
  stats: (
    <svg {...svgProps}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  ),
  accounts: (
    <svg {...svgProps}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  ),
};
const NAV = [
  ['monitor', '#/', 'Monitor'],
  ['workflow', '#/workflow', 'Workflow'],
  ['stats', '#/stats', 'Stats'],
  ['accounts', '#/accounts', 'Accounts'],
];
export const VIEWS = [
  ['waiting', 'Needs you', 'dot-waiting'],
  ['active', 'Running', 'dot-active'],
  ['finished', 'Finished', 'dot-finished'],
];

// `routeName` is the page's own route (a run page has current 'monitor' but is not the Monitor): the Views filter shows as
// pressed only on the Monitor itself.
export function Sidebar({ current, routeName = current, openCount, counts, query, onQuery, searchRef, view, onView, connection, theme, onTheme }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12h4l3-8 4 16 3-8h4" />
        </svg>
        <span>Agent Monitor</span>
      </div>
      <div className="search-box">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={searchRef}
          type="search"
          className="search"
          aria-label="Search runs"
          placeholder="Search runs"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onQuery('');
          }}
        />
        <kbd>Ctrl K</kbd>
      </div>
      <nav className="side-nav" aria-label="Sections">
        {NAV.map(([id, href, label]) => (
          <a key={id} href={href} aria-current={current === id ? 'page' : undefined}>
            {ICON[id]}
            <span className="nav-label">{label}</span>
            {id === 'monitor' && <span className="nav-count">{openCount}</span>}
          </a>
        ))}
      </nav>
      <nav className="side-nav views" aria-label="Views">
        <h2 className="nav-head">Views</h2>
        {VIEWS.map(([id, label, dot]) => (
          <button key={id} type="button" aria-pressed={routeName === 'monitor' && view === id} onClick={() => onView(id)}>
            <span className={`dot ${dot}`} aria-hidden="true" />
            <span className="nav-label">{label}</span>
            <span className="nav-count">{counts[id]}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className={`conn conn-${connection}`} role="status">
          <span className="dot" aria-hidden="true" /> {LIVE_LABEL[connection]}
        </span>
        <button type="button" className="sm theme-btn" onClick={onTheme} aria-label={`Theme: ${theme}. Click to change.`}>
          {theme.charAt(0).toUpperCase() + theme.slice(1)}
        </button>
      </div>
    </aside>
  );
}
