#!/usr/bin/env node
/* Tactical Map — GitHub Actions game tick
   Advances all game state by the elapsed time since the last save.
   Run by .github/workflows/game-tick.yml every 5 minutes.
*/
'use strict';
const fs   = require('fs');
const path = require('path');

const TIME_SCALE = 20;
const WALK_MS    = 1.111 * TIME_SCALE;
const MAVIC_SPD  = 13.9  * TIME_SCALE;

const stateFile = path.join(__dirname, 'game-state.json');

let state;
try {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
} catch {
  console.log('No game-state.json found — nothing to advance');
  process.exit(0);
}

if (!state.units?.length) {
  console.log('No units in state — nothing to advance');
  process.exit(0);
}

const now   = Date.now();
const delta = now - (state.savedAt || now);
if (delta < 1000) {
  console.log(`Only ${delta}ms elapsed — skipping tick`);
  process.exit(0);
}

console.log(`Advancing ${Math.round(delta / 1000)}s of game time…`);
const events = state._pendingEvents ? [...state._pendingEvents] : [];
const next   = advance(state, delta, now, events);
next.savedAt        = now;
next._pendingEvents = events;

fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
console.log(`Done. ${events.length - (state._pendingEvents?.length ?? 0)} new events queued`);

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
        type:    'artillery_impact',
        idx:     i,
        side:    u.side,
        role:    u.role,
        lat:     u.artPending.lat,
        lng:     u.artPending.lng,
        blastR:  u.artPending.blastR,
        dispMax: u.artPending.dispMax ?? 20,
      });
      u.artPending = null;
    }

    // ── supply convoy ──
    if (u.supplyType && u.supplyArrivesAt && u.supplyArrivesAt <= now) {
      events.push({ type: 'supply_arrived', idx: i, supplyType: u.supplyType });
      if (u.supplyType === 'ammo')   u.ammo   = u.maxAmmo;
      if (u.supplyType === 'drones') u.drones = Math.min(6, (u.drones ?? 0) + 3);
      u.supplyType = null; u.supplyArrivesAt = null;
    }

    // ── mavic mission ──
    if (u.mavicMission) advanceMavic(u, deltaMs, now, events, i);

    // ── continuous recon: relaunch if due ──
    if (u.continuousRecon && !u.mavicMission && u.nextReconAt && u.nextReconAt <= now && u.lastScanTarget) {
      const tgt = u.lastScanTarget;
      u.mavicMission = {
        type: 'scan', phase: 'outbound',
        lat: u.lat, lng: u.lng,
        dstLat: tgt.lat, dstLng: tgt.lng,
        homeLat: u.lat, homeLng: u.lng,
        scanEndsAt: 0, hoverSec: 5, hoverPerWP: 5,
        outboundBatt: 3, returnBatt: 5, waypoints: null, currentWP: 1,
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
      const d        = segDist([mis.lat, mis.lng], [mis.dstLat, mis.dstLng]);
      const msNeeded = d > 0 ? (d / MAVIC_SPD) * 1000 : 0;

      if (budget >= msNeeded) {
        budget -= msNeeded;
        mis.lat = mis.dstLat; mis.lng = mis.dstLng;

        if (mis.phase === 'outbound') {
          u.lastScanTarget = { lat: mis.dstLat, lng: mis.dstLng };
          const hoverMs = ((mis.hoverSec ?? 5) * 1000) / TIME_SCALE;
          if (budget >= hoverMs) {
            budget -= hoverMs;
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

function segDist(a, b) {
  const R = 6371000;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const s = Math.sin(dLat/2)**2 + Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
