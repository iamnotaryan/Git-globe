// Normalized event model + human-readable formatting for GitHub Globe.
//
// Pure functions only: no DOM, no network, no globe. Input is a raw GitHub
// Events API object; output is a compact normalized record plus formatting
// helpers. Missing fields stay null/undefined internally and renderers must
// skip them (never print "undefined"/"null").

export function eventKeyOf(event) {
  return event?.id ?? `${event?.actor?.login}:${event?.type}:${event?.created_at}`;
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function shortRef(ref) {
  const s = cleanString(ref);
  if (!s) return null;
  return s.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '') || null;
}

function firstCommitMessage(commits) {
  if (!Array.isArray(commits)) return null;
  for (const c of commits) {
    const msg = cleanString(c?.message);
    if (msg) return msg.split('\n')[0].slice(0, 140);
  }
  return null;
}

// Build a clean normalized representation for visualization/UI.
// Extra/unknown payload fields are ignored; every optional slot may be null.
export function normalizeEvent(raw) {
  const payload = raw?.payload ?? {};
  const type = cleanString(raw?.type) || 'UnknownEvent';
  const actorLogin = cleanString(raw?.actor?.login);
  const avatarUrl = cleanString(raw?.actor?.avatar_url);
  const createdAt = Date.parse(raw?.created_at) || Date.now();

  // Repository identity always comes from the event-level `repo.name`
  // ("owner/repo") which GitHub includes on every event.
  const fullName = cleanString(raw?.repo?.name);
  const [ownerPart, ...rest] = (fullName || '').split('/');
  const owner = cleanString(ownerPart);
  const name = cleanString(rest.join('/')) || fullName;

  // Optional repo metadata: only what GitHub already embedded in the payload
  // (payload.repository is occasionally present). Never fetched separately.
  const payloadRepo = payload?.repository ?? null;
  const description = cleanString(payloadRepo?.description);
  const language = cleanString(payloadRepo?.language);
  const stars = cleanNumber(payloadRepo?.stargazers_count);
  const forks = cleanNumber(payloadRepo?.forks_count);

  const norm = {
    eventId: eventKeyOf(raw),
    eventType: type,
    username: actorLogin,
    avatarUrl,
    createdAt,
    repository: fullName
      ? {
          name,
          fullName,
          owner,
          description,
          url: `https://github.com/${fullName}`,
          language,
          stars,
          forks
        }
      : null,
    // Generic action/ref slots, filled per type below.
    action: cleanString(payload?.action),
    ref: null,
    refType: null,
    branch: null,
    commitCount: null,
    commitMessage: null,
    title: null,
    number: null,
    merged: null,
    member: null,
    release: null,
    comment: null
  };

  switch (type) {
    case 'PushEvent': {
      norm.branch = shortRef(payload?.ref);
      const commits = Array.isArray(payload?.commits) ? payload.commits : null;
      norm.commitCount =
        cleanNumber(payload?.size) ??
        cleanNumber(payload?.distinct_size) ??
        (commits ? commits.length : null);
      norm.commitMessage = firstCommitMessage(commits);
      norm.ref = norm.branch;
      break;
    }
    case 'PullRequestEvent':
    case 'PullRequestReviewEvent':
    case 'PullRequestReviewCommentEvent': {
      const pr = payload?.pull_request ?? {};
      norm.number = cleanNumber(payload?.number) ?? cleanNumber(pr?.number);
      norm.title = cleanString(pr?.title);
      norm.merged = typeof pr?.merged === 'boolean' ? pr.merged : null;
      break;
    }
    case 'IssuesEvent':
    case 'IssueCommentEvent': {
      const issue = payload?.issue ?? {};
      norm.number = cleanNumber(payload?.number) ?? cleanNumber(issue?.number);
      norm.title = cleanString(issue?.title);
      break;
    }
    case 'ForkEvent': {
      const forkee = payload?.forkee ?? {};
      // Fork target display: prefer forkee full_name when present.
      norm.title = cleanString(forkee?.full_name);
      break;
    }
    case 'CreateEvent':
    case 'DeleteEvent': {
      norm.ref = cleanString(payload?.ref);
      norm.refType = cleanString(payload?.ref_type);
      if (norm.refType === 'branch') norm.branch = norm.ref;
      break;
    }
    case 'ReleaseEvent': {
      const release = payload?.release ?? {};
      norm.release =
        cleanString(release?.name) ||
        cleanString(release?.tag_name) ||
        null;
      break;
    }
    case 'MemberEvent': {
      norm.member = cleanString(payload?.member?.login);
      break;
    }
    case 'CommitCommentEvent': {
      const body = cleanString(payload?.comment?.body);
      norm.comment = body ? body.slice(0, 140) : null;
      break;
    }
    case 'WatchEvent':
    default:
      break;
  }

  return norm;
}

// Short human label for an event type, e.g. "PushEvent" -> "Push".
export function eventShortLabel(type) {
  const s = cleanString(type);
  if (!s) return 'Event';
  return s.replace(/Event$/, '');
}

// Headline + supporting lines describing the activity. Only includes data
// that actually exists; callers render each line only when non-null.
export function describeActivity(norm) {
  const actor = norm?.username || 'Someone';
  const repo = norm?.repository?.fullName || null;
  const t = norm?.eventType;

  const out = { headline: null, detail: null };

  switch (t) {
    case 'PushEvent': {
      const n = norm.commitCount;
      const count = n === 1 ? '1 commit' : n != null ? `${n} commits` : 'commits';
      out.headline = `${actor} pushed ${count}` + (norm.branch ? ` to ${norm.branch}` : '');
      out.detail = norm.commitMessage ? `\u201C${norm.commitMessage}\u201D` : null;
      break;
    }
    case 'PullRequestEvent': {
      const action = norm.action || 'updated';
      const mergedWord = action === 'closed' && norm.merged ? 'merged' : action;
      const num = norm.number != null ? ` #${norm.number}` : '';
      out.headline = `${actor} ${mergedWord} pull request${num}`;
      out.detail = norm.title ? `\u201C${norm.title}\u201D` : null;
      break;
    }
    case 'PullRequestReviewEvent':
    case 'PullRequestReviewCommentEvent': {
      const num = norm.number != null ? ` #${norm.number}` : '';
      out.headline = `${actor} reviewed pull request${num}`;
      out.detail = norm.title ? `\u201C${norm.title}\u201D` : null;
      break;
    }
    case 'IssuesEvent': {
      const action = norm.action || 'updated';
      const num = norm.number != null ? ` #${norm.number}` : '';
      out.headline = `${actor} ${action} issue${num}`;
      out.detail = norm.title ? `\u201C${norm.title}\u201D` : null;
      break;
    }
    case 'IssueCommentEvent': {
      const num = norm.number != null ? ` #${norm.number}` : '';
      out.headline = `${actor} commented on issue${num}`;
      out.detail = norm.title ? `\u201C${norm.title}\u201D` : null;
      break;
    }
    case 'WatchEvent': {
      out.headline = `${actor} starred ${repo || 'a repository'}`;
      out.detail = null;
      break;
    }
    case 'ForkEvent': {
      out.headline = norm.title
        ? `${actor} forked to ${norm.title}`
        : `${actor} forked ${repo || 'a repository'}`;
      out.detail = null;
      break;
    }
    case 'CreateEvent': {
      const what = norm.refType || 'something';
      out.headline = norm.ref
        ? `${actor} created ${what} ${norm.ref}`
        : `${actor} created ${what}`;
      out.detail = null;
      break;
    }
    case 'DeleteEvent': {
      const what = norm.refType || 'something';
      out.headline = norm.ref
        ? `${actor} deleted ${what} ${norm.ref}`
        : `${actor} deleted ${what}`;
      out.detail = null;
      break;
    }
    case 'ReleaseEvent': {
      out.headline = norm.release
        ? `${actor} released ${norm.release}`
        : `${actor} published a release`;
      out.detail = null;
      break;
    }
    case 'MemberEvent': {
      out.headline = norm.member
        ? `${actor} added ${norm.member} as a collaborator`
        : `${actor} updated a collaborator`;
      out.detail = null;
      break;
    }
    case 'CommitCommentEvent': {
      out.headline = `${actor} commented on a commit`;
      out.detail = norm.comment ? `\u201C${norm.comment}\u201D` : null;
      break;
    }
    default: {
      const label = eventShortLabel(t).toLowerCase();
      out.headline = norm.action
        ? `${actor} ${norm.action} (${label})`
        : `${actor} triggered ${label}`;
      out.detail = norm.title ? `\u201C${norm.title}\u201D` : null;
      break;
    }
  }

  return out;
}

export function timeAgo(timestamp) {
  const diff = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function formatTimestamp(timestamp) {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return null;
  }
}
