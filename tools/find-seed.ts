import { Room } from '../src/server/room.ts';
for (let s = 1; s < 400; s++) {
  const r = new Room('SEED', s);
  if (r.relicSite === 'VAULT') { console.log('seed', s, '-> relic at', r.relicSite); break; }
}
