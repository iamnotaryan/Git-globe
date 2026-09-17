// Floating event card DOM for GitHub Globe: hover tooltip + persistent
// selection panel. Cyber/neon styling lives in style.css; this module only
// builds DOM and positions it. Never renders missing values.

import {
  describeActivity,
  eventShortLabel,
  formatTimestamp,
  timeAgo
} from './eventDetails.js';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function avatarHtml(norm) {
  if (!norm?.avatarUrl || !norm?.username) return '';
  return `<img class="ev-avatar" src="${escapeHtml(norm.avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
}

function metaLineHtml(norm) {
  const parts = [];
  if (norm?.repository?.language) {
    parts.push(`<span class="ev-meta-item">${escapeHtml(norm.repository.language)}</span>`);
  }
  if (typeof norm?.repository?.stars === 'number') {
    parts.push(`<span class="ev-meta-item">★ ${norm.repository.stars}</span>`);
  }
  if (typeof norm?.repository?.forks === 'number') {
    parts.push(`<span class="ev-meta-item">⑂ ${norm.repository.forks}</span>`);
  }
  if (!parts.length) return '';
  return `<div class="ev-meta">${parts.join('')}</div>`;
}

// Shared card body. `compact` trims to headline+repo for arc hovers.
// `interactive` controls whether repository/actor render as clickable links:
// the hover card is pointer-transparent (non-interactive) so it never steals
// the pointer from the globe; the pinned selection panel is interactive.
export function eventCardBodyHtml(norm, color, { compact = false, interactive = true } = {}) {
  const { headline, detail } = describeActivity(norm);
  const label = eventShortLabel(norm?.eventType);
  const ago = timeAgo(norm?.createdAt);
  const fullTime = formatTimestamp(norm?.createdAt);
  const actorUrl = norm?.username ? `https://github.com/${norm.username}` : null;
  const repoUrl = norm?.repository?.url || null;

  const lines = [];
  lines.push(
    `<div class="ev-type" style="--ev-accent:${escapeHtml(color)}">` +
      `<span class="ev-dot"></span><span>${escapeHtml(label.toUpperCase())}</span></div>`
  );

  if (norm?.repository?.fullName && repoUrl && interactive) {
    lines.push(
      `<a class="ev-repo" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">` +
        `${escapeHtml(norm.repository.fullName)}</a>`
    );
  } else if (norm?.repository?.fullName) {
    lines.push(`<div class="ev-repo">${escapeHtml(norm.repository.fullName)}</div>`);
  }

  if (!compact && norm?.repository?.description) {
    lines.push(`<div class="ev-desc">${escapeHtml(norm.repository.description)}</div>`);
  }

  if (headline) {
    const actor = norm?.username ? escapeHtml(norm.username) : 'Someone';
    const headlineHtml = escapeHtml(headline).replace(actor, `<strong>${actor}</strong>`);
    lines.push(`<div class="ev-headline">${avatarHtml(norm)}<span>${headlineHtml}</span></div>`);
  }

  if (!compact && detail) {
    lines.push(`<div class="ev-detail">${escapeHtml(detail)}</div>`);
  }

  if (!compact) lines.push(metaLineHtml(norm));

  lines.push(
    `<div class="ev-time"${fullTime ? ` title="${escapeHtml(fullTime)}"` : ''}>${escapeHtml(ago)}</div>`
  );

  if (!compact && actorUrl && repoUrl && interactive) {
    lines.push(
      `<div class="ev-links"><a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">View repository ↗</a>` +
        `<span class="ev-sep">·</span>` +
        `<a href="${escapeHtml(actorUrl)}" target="_blank" rel="noopener noreferrer">View actor ↗</a></div>`
    );
  } else if (!compact && repoUrl && interactive) {
    lines.push(
      `<div class="ev-links"><a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">View repository ↗</a></div>`
    );
  }

  return lines.join('');
}

function clampCardPosition(card, x, y) {
  const pad = 12;
  const offset = 16;
  const rect = card.getBoundingClientRect();
  let left = x + offset;
  let top = y + offset;
  if (left + rect.width > window.innerWidth - pad) {
    left = x - rect.width - offset;
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = y - rect.height - offset;
  }
  left = Math.max(pad, Math.min(left, window.innerWidth - rect.width - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - rect.height - pad));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

export function createHoverCard() {
  const el = document.createElement('div');
  el.className = 'ev-hover-card';
  el.style.display = 'none';
  el.setAttribute('aria-hidden', 'true');
  // Hover card is informational only: never steal pointer events, so moving
  // between globe points never flickers through the card itself.
  document.body.appendChild(el);

  return {
    element: el,
    show(norm, color, x, y) {
      if (!norm) return;
      el.innerHTML = eventCardBodyHtml(norm, color, { compact: false, interactive: false });
      el.style.setProperty('--ev-accent', color);
      el.style.display = 'block';
      clampCardPosition(el, x, y);
    },
    move(x, y) {
      if (el.style.display === 'none') return;
      clampCardPosition(el, x, y);
    },
    hide() {
      el.style.display = 'none';
    }
  };
}

export function createSelectedPanel({ onClose }) {
  const el = document.createElement('div');
  el.className = 'ev-selected-panel';
  el.style.display = 'none';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);

  // Links inside the panel must not propagate to globe handlers.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => e.stopPropagation());

  const close = () => {
    el.style.display = 'none';
    if (typeof onClose === 'function') onClose();
  };

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ev-close]');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  return {
    element: el,
    show(norm, color) {
      if (!norm) return;
      el.innerHTML =
        `<button class="ev-close" data-ev-close aria-label="Close event details and resume rotation">×</button>` +
        eventCardBodyHtml(norm, color, { compact: false, interactive: true }) +
        `<button class="ev-resume" data-ev-close>Resume rotation</button>`;
      el.style.setProperty('--ev-accent', color);
      el.style.display = 'block';
    },
    hide() {
      el.style.display = 'none';
    },
    close
  };
}
