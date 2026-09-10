# Clicket archive

Archived code for the Clicket simulated-cricket-league integration.
Removed from the main app when CricWormViz moved to a static GitHub Pages deployment.

## Files

- `clicketProcessor.js` — converts Clicket `/game/{id}` API response to the internal innings format
- `cricbuzzProcessor.js` — early Cricbuzz experiment (unused)
- `server.py` — the Python proxy server that served static files and proxied both ESPN and Clicket APIs

## To revive

1. Copy `server.py` back to the project root and run it (`python3 server.py`)
2. Copy `clicketProcessor.js` back to `js/`
3. Re-add the Clicket section to `index.html` and the source picker to `landing.js`
4. Re-add the `loadClicket` / `renderClicket` / `clicketCard` functions to `landing.js`
5. Re-add `loadClicket` and `scheduleRefreshClicket` to `main.js`

The Clicket API (`clicket-game.com/api`) does not send CORS headers so it requires the proxy.
