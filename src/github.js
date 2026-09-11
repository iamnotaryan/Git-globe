export async function getEvents() {
  const TOKEN = import.meta.env.VITE_GITHUB_TOKEN;

  let allEvents = [];

  for (let page = 1; page <= 5; page++) {
    const response = await fetch(
      `https://api.github.com/events?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const events = await response.json();

    allEvents.push(...events);
  }

  return allEvents;
}