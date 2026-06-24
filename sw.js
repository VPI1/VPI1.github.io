/* Tactical Map — Service Worker game loop
   Runs the game even when the page tab is closed.
   State lives in CacheStorage; events are queued for the main page to render.
*/
const CACHE  = 'tactical-map-sw-v1';
const S_KEY  = '/sw-state';
const E_KEY  = '/sw-events';

const TIME_SCALE = 20;
const WALK_MS    = 1.111 * TIME_SCALE;   // m/s walking speed (game scale)
const MAVIC_SPD  = 13.9  * TIME_SCALE;   // m/s mavic speed   (game scale)
const TICK_MS    = 1000;                  // real-world tick interval

let tickTimer = null;

// ── lifecycle ──────────────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ── messaging from the main page ───────────────────────────────────────────
self.addEventListener('message', async e => {
  const { type, state } = e.data || {};

  if (type === 'SAVE_STATE') {
    await writeCache(S_KEY, state);
    ensureTicking();
  }

  if (type === 'PAGE_OPEN') {
    // Hand off: stop ticking (page takes over), reply with buffered events via MessageChannel
    stopTicking();
    const evts = (await readCache(E_KEY)) || [];
    const replyPort = e.ports[0];
    if (replyPort) replyPort.postMessage({ events: evts });
    await writeCache(E_KEY, []); // clear event queue after delivery
  }

  if (type === 'PAGE_UNLOAD') {
    ensureTicking();
  }
});

// ── tick loop ──────────────────────────────────────────────────────────────
function ensureTicking() {
  if (tickTimer) return;
  tickTimer = setInterval(doTick, TICK_MS);
}
function stopTicking() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

async function doTick() {
  // Skip if page is open — it's running the authoritative loop
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  if (clients.length > 0) return;

  const state = await readCache(S_KEY);
  if (!state?.units?.length) return;

  const now    = Date.now();
  const delta  = now - (state.savedAt || now);
  if (delta < 200) return;  // nothing meaningful to advance

  const events = (await readCache(E_KEY)) || [];
  const next   = advance(state, delta, now, events);
  next.savedAt = now;

  await Promise.all([writeCache(S_KEY, next), writeCache(E_KEY, events)]);
}

// ── pure-data game advance ─────────────────────────────────────────────────
function advance(state, deltaMs, now, events) {
  const units = state.units.map(u => ({ ...u }));

  for (let i = 0; i < units.length; i++) {
    const u = units[i];

    // ── move along route ──
    if (u.remainingRoute?.length >= 2) {
      let budget = WALK_MS * (deltaMs / 1000);
      let route  = u.remainingRoute;
      let seg = 0, t = 0;
      while (budget > 0 && seg < route.length - 1) {
        const d    = segDist(route[seg], route[seg + 1]);
        const left = d * (1 - t);
        if (budget >= left) { budget -= left; seg++; t = 0; }
        else                { t += budget / d; budget = 0; }
      }
      if (seg >= route.length - 1) {
        u.lat = route[route.length - 1][0];
        u.lng = route[route.length - 1][1];
        u.remainingRoute = null;
        events.push({ type: 'unit_arrived', idx: i, lat: u.lat, lng: u.lng });
      } else {
        const a = route[seg], b = route[seg + 1];
        u.lat = a[0] + (b[0] - a[0]) * t;
        u.lng = a[1] + (b[1] - a[1]) * t;
        u.remainingRoute = [[u.lat, u.lng], ...route.slice(seg + 1)];
      }
    }

    // ── artillery ──
    if (u.artPending && u.artPending.fireAt <= now) {
      events.push({
        type: 'artillery_impact',
        idx:  i,
        side: u.side, role: u.role,
        lat:  u.artPending.lat,
        lng:  u.artPending.lng,
        blastR:   u.artPending.blastR,
        dispMax:  u.artPending.dispMax ?? 20,
      });
      u.artPending = null;
    }

    // ── supply convoy ──
    if (u.supplyType && u.supplyArrivesAt && u.supplyArrivesAt <= now) {
      events.push({ type: 'supply_arrived', idx: i, supplyType: u.supplyType });
      // Apply ammo/drones immediately so next tick sees correct values
      if (u.supplyType === 'ammo')  { u.ammo = u.maxAmmo; }
      if (u.supplyType === 'drones'){ u.drones = 6; }
      u.supplyType = null; u.supplyArrivesAt = null;
    }

    // ── mavic mission ──
    if (u.mavicMission) {
      advanceMavic(u, deltaMs, now, events, i);
    }

    // ── continuous recon: launch next scan if due ──
    if (u.continuousRecon && !u.mavicMission && u.nextReconAt && u.nextReconAt <= now && u.lastScanTarget) {
      const tgt = u.lastScanTarget;
      u.mavicMission = {
        type: 'scan', phase: 'outbound',
        lat: u.lat, lng: u.lng,
        dstLat: tgt.lat, dstLng: tgt.lng,
        homeLat: u.lat, homeLng: u.lng,
        scanEndsAt: 0, hoverSec: 5, hoverPerWP: 5,
        outboundBatt: 3, returnBatt: 5,
        waypoints: null, currentWP: 1,
      };
      u.nextReconAt = 0;
    }

    units[i] = u;
  }

  return { ...state, units };
}

function advanceMavic(u, deltaMs, now, events, unitIdx) {
  let budget = deltaMs;
  let cycles = 0;

  while (budget > 0 && cycles++ < 50 && u.mavicMission) {
    const mis = u.mavicMission;

    if (mis.phase === 'outbound' || mis.phase === 'returning') {
      const d       = segDist([mis.lat, mis.lng], [mis.dstLat, mis.dstLng]);
      const msNeeded = d > 0 ? (d / MAVIC_SPD) * 1000 : 0;

      if (budget >= msNeeded) {
        budget -= msNeeded;
        mis.lat = mis.dstLat; mis.lng = mis.dstLng;

        if (mis.phase === 'outbound') {
          u.lastScanTarget = { lat: mis.dstLat, lng: mis.dstLng };
          const hoverMs = ((mis.hoverSec ?? 5) * 1000) / TIME_SCALE;
          if (budget >= hoverMs) {
            budget -= hoverMs;
            // Advance to next WP or return
            if (mis.type === 'patrol' && mis.waypoints?.length) {
              const nextWP = (mis.currentWP ?? 1) + 1;
              if (nextWP < mis.waypoints.length) {
                mis.currentWP = nextWP;
                mis.dstLat = mis.waypoints[nextWP][0];
                mis.dstLng = mis.waypoints[nextWP][1];
                mis.hoverSec = mis.hoverPerWP ?? mis.hoverSec;
              } else {
                mis.phase = 'returning';
                mis.dstLat = mis.homeLat; mis.dstLng = mis.homeLng;
              }
            } else {
              mis.phase = 'returning';
              mis.dstLat = mis.homeLat; mis.dstLng = mis.homeLng;
            }
          } else {
            mis.scanEndsAt = now + (hoverMs - budget);
            mis.phase = 'scanning';
            budget = 0;
          }
        } else {
          // Returned home
          u.mavicBattery = u.autoBatterySwap ? 100 : Math.max(0, (u.mavicBattery ?? 100) - (mis.returnBatt ?? 5));
          const swapMs   = ((u.autoBatterySwap ? 5000 : 60000) / TIME_SCALE);
          u.mavicCooldownUntil = now;
          if (u.continuousRecon) u.nextReconAt = now + swapMs;
          events.push({ type: 'mavic_returned', idx: unitIdx });
          u.mavicMission = null;

          // Continuous recon: kick off next cycle if battery ok and time budget allows
          if (u.continuousRecon && u.mavicBattery >= 10 && u.lastScanTarget && budget > swapMs) {
            budget -= swapMs;
            const tgt = u.lastScanTarget;
            u.mavicMission = {
              type: 'scan', phase: 'outbound',
              lat: u.lat, lng: u.lng,
              dstLat: tgt.lat, dstLng: tgt.lng,
              homeLat: u.lat, homeLng: u.lng,
              scanEndsAt: 0, hoverSec: mis.hoverSec ?? 5, hoverPerWP: mis.hoverPerWP ?? 5,
              outboundBatt: mis.outboundBatt ?? 3, returnBatt: mis.returnBatt ?? 5,
              waypoints: null, currentWP: 1,
            };
            u.nextReconAt = 0;
          }
        }
      } else {
        const r = budget / msNeeded;
        mis.lat += (mis.dstLat - mis.lat) * r;
        mis.lng += (mis.dstLng - mis.lng) * r;
        budget = 0;
      }
    } else if (mis.phase === 'scanning') {
      if (now >= mis.scanEndsAt) {
        if (mis.type === 'patrol' && mis.waypoints?.length) {
          const nextWP = (mis.currentWP ?? 1) + 1;
          if (nextWP < mis.waypoints.length) {
            mis.currentWP = nextWP;
            mis.dstLat = mis.waypoints[nextWP][0];
            mis.dstLng = mis.waypoints[nextWP][1];
            mis.phase = 'outbound';
          } else {
            mis.phase = 'returning';
            mis.dstLat = mis.homeLat; mis.dstLng = mis.homeLng;
          }
        } else {
          mis.phase = 'returning';
          mis.dstLat = mis.homeLat; mis.dstLng = mis.homeLng;
        }
      } else {
        budget = 0;
      }
    } else {
      break;
    }
  }
}

// ── utils ──────────────────────────────────────────────────────────────────
function segDist(a, b) {
  const R = 6371000;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

async function readCache(key) {
  try {
    const cache = await caches.open(CACHE);
    const resp  = await cache.match(key);
    return resp ? resp.json() : null;
  } catch { return null; }
}
async function writeCache(key, data) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  } catch {}
}
