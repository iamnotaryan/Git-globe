// Event-payload analysis for GitHub Globe: extracting legitimate activity
// destinations from raw GitHub events. Pure functions — no DOM, no network,
// no geo — so they are easy to unit-test and reuse.

// Repository geographic metadata — investigated, not assumed.
//
// GitHub provides NO geographic information for repositories:
//  - the Events API feed's `repo` object only exposes { id, name, url };
//  - the REST /repos/{owner}/{repo} document carries name, full_name,
//    html_url, description, topics, … — but no location field at all.
//
// A repository therefore has no "location" that could be used as an arc
// destination. We never fetch repository metadata (it would be wasted
// network requests) and we never treat repo names/URLs as coordinates.
// This helper inspects the payload defensively and returns a location string
// only if some source genuinely provides one; with real GitHub data it always
// returns null.
export function repoLocationFromEvent(event) {
  const repo = event.payload?.repository ?? event.repo;
  const location = repo?.location;
  return typeof location === 'string' && location.trim() ? location.trim() : null;
}

// The repository owner taken from the event-level `repo.name` ("owner/repo").
// GitHub includes this on every event, so it is a universal last-resort
// destination: a real GitHub account whose profile location is meaningful.
export function repoOwnerFromEvent(event) {
  return event.repo?.name?.split('/')[0] ?? null;
}

// A second participant explicitly named in the event payload, other than the
// actor — the most meaningful "person interacting with another person"
// relationship.
function participantFromPayload(event) {
  const payload = event.payload ?? {};

  switch (event.type) {
    case 'IssuesEvent':
    case 'IssueCommentEvent':
      // The issue's author, e.g. a maintainer commenting on a user's bug.
      return payload.issue?.user?.login ?? null;
    case 'PullRequestReviewEvent':
      // The reviewer (usually the actor, which is discarded by the caller).
      return payload.review?.user?.login ?? null;
    case 'PullRequestReviewCommentEvent':
      // The commenter of a PR review thread (usually the actor).
      return payload.comment?.user?.login ?? null;
    case 'MemberEvent':
      // The actor added a collaborator, so actor -> member is a real
      // two-person interaction.
      return payload.member?.login ?? null;
    case 'ReleaseEvent':
      // The release author (usually the actor).
      return payload.release?.author?.login ?? null;
    case 'CommitCommentEvent':
      // The commenter of a commit.
      return payload.comment?.user?.login ?? null;
    default:
      return null;
  }
}

// Ordered destination candidates for an event, highest priority first:
//
//   1. a payload participant (≠ actor) — the other real person involved
//   2. the repository owner (≠ actor, ≠ participant) — a real GitHub account
//   3. legitimate repository geographic metadata — never present, see above
//
// NOTE ON PULL REQUESTS: the Events API feed omits `pull_request.user` for
// PullRequestEvent / PullRequestReviewEvent / PullRequestReviewCommentEvent —
// the `pull_request` object only carries { url, id, number, head, base } and
// `head` is { ref, sha, repo }. The PR author cannot be derived from the
// payload, so those events fall straight through to the repository owner.
export function destinationCandidates(event) {
  const actor = event.actor?.login;
  if (!actor) return [];

  const candidates = [];

  const participant = participantFromPayload(event);
  if (participant && participant !== actor) {
    candidates.push({ kind: 'user', username: participant });
  }

  const owner = repoOwnerFromEvent(event);
  if (owner && owner !== actor && owner !== participant) {
    candidates.push({ kind: 'user', username: owner });
  }

  const repoLocation = repoLocationFromEvent(event);
  if (repoLocation) {
    candidates.push({ kind: 'location', location: repoLocation });
  }

  return candidates;
}

// The single best destination username for an event, or null. Kept for
// callers that only need one username; main.js uses destinationCandidates()
// so it can still fall through to a lower-priority candidate when a
// higher-priority one cannot be resolved to a location.
export function getDestinationUsername(event) {
  const candidate = destinationCandidates(event).find((c) => c.kind === 'user');
  return candidate ? candidate.username : null;
}