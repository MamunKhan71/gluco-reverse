// Push alerts to the caregiver's phone through ntfy.sh (free, no account).
// The caregiver installs the "ntfy" app and subscribes to the same secret topic.
import { randomId } from './store.js';

export function randomTopic() {
  return `sugar-${randomId(20)}`;
}

export async function sendNtfy(topic, { title, message, priority = 4 }) {
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    body: JSON.stringify({ topic, title, message, priority, tags: ['warning'] }),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}
