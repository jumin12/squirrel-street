Original prompt: if the user selects the host button it should automatically generate a room code. the stats screen should look better and display the player within the chart like other games do highlighting the player and also the charts and everything should be moved up towards the top of that screen. in challenge mode when two players play, between levels it should give a little waiting screen instead of showing the player frozen, it should show the score of both players on this screen. When one of the players dies or leaves it should end the game for that player but the other player can keep playing and if the player closed the game but wasnt dead they should be able to reconnect. there should be no run again button on the end screen screen. The user during multiplayer should be able to change their name and see a list of their friends and it should be connected to facebook. The game should have the top ui numbers shifted up they appear under the boxes they are supposed to be in. Also whenever both players either leave or die it should show a game history showing who won with the most score and these stats should be tracked showing the score, words spelt, times won and times lost in the overall global stats and on the profile stats. The multiplayer profile should be enterable via the challange mode. Ensure the user who didnt lose can keep playing not having to wait for the other player, also allow the player to leave and return to the game doing one at a time instead of the player having to just wait. This way if the user leaves they have up to 24 hours to continue playing. Do all of this and update the version code in game and for the android files then give me the command to sync to android.

## Notes
- Starting implementation by inspecting the existing single-file web game, challenge multiplayer, stats, version display, and Android wrapper setup.
- Client UI updated for better stats/profile layout, highlighted score bars, challenge name editing, safer Facebook friends rendering, no visible Run Again button, and higher HUD number placement.
- Challenge server is being updated to store per-level score submissions so players can continue independently instead of blocking on one shared current level.
- Version bumped to in-game v2.4, package 2.4.0, and Android VERSION_CODE 29 / VERSION_NAME 2.4.0.
- Verification: server syntax passes with `node --check server/index.js`; lints show no errors. Playwright CLI captured and inspected the preload screenshot successfully. The bundled skill client could not run directly on this Windows/CommonJS project because Node treated its ES module script as CommonJS.

## 2026-07-17 — HUD alignment + v2.14
- Fixed top HUD: aspect-locked `topui.png` (249/33), absolute % well centers, DOM order Level?Score?High?Lives.
- Verified visually via Playwright on iPhone SE/12/14 Pro Max, Pixel 5, Galaxy S9+, 320/390/430 widths — aspect ~7.546 and well % stable (13/35/60/78).
- Challenge Mode now calls `createHostedChallengeRoom(false)` on open; live API returned codes (e.g. L7MBXT, S4EGU9).
- Versions: in-game **v2.14**, package **2.14.0**, Play `VERSION_CODE=39` / `VERSION_NAME=2.14.0`, iOS build 39.
- Android sync: `npm run android:sync` from repo root.
- Helper scripts: `scripts/hud-visual-check.js`, `scripts/mp-smoke.js` (local QA; screenshots under `tmp-hud-shots/`).

## 2026-08-12 — Challenge lobby / stats UX + v2.16
- Rebuilt Play, Challenge, Stats, and between-level screens to match the wood/gold UI (removed slate-blue overlay look and competing Host/Join/Start row).
- Host: big room code + Copy/Share + full-width Start run. Join: code + Join run. Profile/name/invites live in one profile panel. Active matches sit at the top when present.
- Stats: tile grid for wins/losses/pts/words, Win/Loss history cards, player-facing copy.
- Versions: in-game **v2.16**, package **2.16.0**, Play `VERSION_CODE=41` / `VERSION_NAME=2.16.0`, iOS build 41.
- Android sync: `npm run android:sync` from repo root.

## 2026-08-12 — Cutout HUD + matchmaking lobby + v2.17
- Top HUD uses `env(safe-area-inset-top)` only. Phones with no camera inset (SE, etc.) stay flush at `top: 0`. Notched/punch-hole phones shift the bar down and fill the gap with the same wood color. Desktop playfield stays unpadded.
- Challenge lobby no longer uses room codes, Host/Join, or offline seeds. Players can find a match, join people waiting, challenge friends, search usernames, play bots, and accept/decline incoming challenges. Internal match `code` is still used by the API.
- Server: waiting list, inbox, matchmake, player search, bot opponents with auto-scored rounds, and host rejoin while waiting for a rival.
- Versions: in-game **v2.17**, package **2.17.0**, Play `VERSION_CODE=42` / `VERSION_NAME=2.17.0`, iOS build 42.
- Android sync: `npm run android:sync` from repo root.

## TODOs / next
- Live two-device challenge playtest (host share ? join ? between-level Continue).
- Facebook friends remain API/invite based; no Facebook SDK in this pass.
