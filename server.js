/**
 * OCULUS backend — runs the watcher continuously and serves readings to
 * the static landing page over a small JSON API. The frontend polls
 * GET /api/readings every few seconds and appends whatever's new.
 *
 * Requires Node 18+ (uses the global fetch() that oculus-watcher.js relies
 * on — there's no other network dependency).
 *
 * Run with: npm install && npm start
 */

const express = require("express");
const path = require("path");
const { startWatching, CONFIG } = require("./oculus-watcher");

const PORT = process.env.PORT || 3000;
const MAX_BUFFERED_READINGS = 200; // ring buffer size — plenty for a feed that shows the last 12

const app = express();
app.use(express.static(__dirname)); // serves anything else dropped in this folder

// the landing page isn't named index.html, so express.static won't serve
// it for "/" on its own — send it explicitly.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "oculus-landing.html"));
});

// in-memory ring buffer of readings, oldest first, each with a monotonic id
// so the frontend can ask "give me everything after id X" instead of
// re-sending the whole feed every poll.
const readings = [];
let nextId = 1;

// coarse liveness state for /api/status, updated by onPollComplete below —
// lets you (or the frontend) tell "is this actually still polling" apart
// from "it's polling but nothing above threshold has happened yet."
const status = {
  pollCount: 0,
  lastPollAt: null,
  lastPollError: null,
};

app.get("/api/readings", (req, res) => {
  const since = Number(req.query.since ?? 0);
  const fresh = Number.isFinite(since) ? readings.filter(r => r.id > since) : readings;
  res.json({ readings: fresh, latestId: nextId - 1 });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    ...status,
    readingsBuffered: readings.length,
    config: CONFIG,
  });
});

app.listen(PORT, () => {
  console.log(`[server] OCULUS listening on http://localhost:${PORT}`);
});

function onReading(reading) {
  const withId = { id: nextId++, ...reading };
  readings.push(withId);
  while (readings.length > MAX_BUFFERED_READINGS) readings.shift();
  console.log(`[server] reading #${withId.id} (${withId.tag}): ${withId.text}`);
}

function onPollComplete(err, info) {
  status.pollCount++;
  status.lastPollAt = new Date().toISOString();
  status.lastPollError = err ? err.message : null;
}

startWatching(onReading, onPollComplete);
