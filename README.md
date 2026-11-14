# Echo Companion / Echo Library

Browse music, import playlists, and play your selections directly on an Amazon Echo from a browser tab.

**Version 0.4.0** includes a Chrome/Brave extension that opens the full Echo Library interface, plus a local Node.js helper that serves the app and maintains the Amazon connection. The Echo streams audio through its linked music service; the computer does not send Bluetooth audio.

This is a standalone project. It does not require a separate Echo Library web-app installation, a hosted server, or a build step. Public search and supported public playlist imports work without connecting a music catalogue account.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install and start](#install-and-start)
- [Connect Amazon and your Echo](#connect-amazon-and-your-echo)
- [Choose a streaming service](#choose-a-streaming-service)
- [Optional music account connections](#optional-music-account-connections)
- [Search, playlists, and playback](#search-playlists-and-playback)
- [Local data and backups](#local-data-and-backups)
- [Git repository contents](#git-repository-contents)
- [Development and updates](#development-and-updates)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Project structure](#project-structure)
- [License](#license)

## Features

- Search songs and artists as you type, with a country selector that defaults to India.
- Play songs on an Echo using an explicit streaming service or Alexa's default.
- Request one artist at a time and try alternative artist credits when playback does not match the selected song.
- Browse optionally connected Apple Music, Spotify, and Google/YouTube accounts.
- Create local playlists, add songs from search, and import playlist links or pasted song lists.
- Keep your chosen playlist name alongside its original source name, cover, author when available, and an **Open original playlist** link.
- Preview and apply **Sync from source** while keeping your chosen name and backing up the previous saved playlist.
- Hover over a playlist song's artwork to play it; use the same button with keyboard focus or touch.
- Play a complete playlist cycle starting at any song, with Shuffle and Repeat All.
- Manage upcoming songs in the queue sidebar.
- Control Echo play/pause, previous/next, song position, and volume using reported device state.
- Show/hide the Commands sidebar, send typed Alexa requests, and inspect request status, any readable Alexa response, and playback observations separately.

## Requirements

- **Node.js 18.20 or newer**, with npm, as declared in `package.json`.
- **Chrome or Brave** with extension support. The manifest declares Chromium 111 or newer; development and live Echo checks have been performed on macOS with Brave and an Echo Dot 5th generation. Other operating systems/devices have not been live-verified.
- An Amazon account with an Echo registered to it, and an online Echo.
- Internet access for Amazon, catalogue searches, artwork, imports, and optional account authorization.
- Your desired music service linked to Alexa, with any subscription or regional access that service requires.
- Local TCP ports **4320** for the app and **4321** for Amazon sign-in available when needed.

The `.command` launcher is for macOS. The terminal startup instructions below are the portable entry point. The project uses fixed ports; there is no documented `.env` or command-line port configuration.

## Install and start

### From a fresh Git clone

Replace `REPOSITORY_URL` with your repository's clone URL:

```sh
git clone REPOSITORY_URL Alexa_Extension
cd Alexa_Extension
npm ci --ignore-scripts
npm start
```

Keep that terminal running, then open [Echo Library](http://127.0.0.1:4320/). Use this exact loopback address consistently for the app and account callbacks.

`npm ci` installs the versions in `package-lock.json`. There is no separate frontend build. A fresh clone starts without saved accounts, sessions, playlists, or private credentials; the helper creates its own `.local/` data directory.

### Load the browser extension

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's **extension/** subfolder, not the repository root.
4. Pin Echo Companion if desired, then click its toolbar icon.

The toolbar icon opens or focuses the app at [http://127.0.0.1:4320/](http://127.0.0.1:4320/). It does **not** start the helper. The app also works by opening that URL directly; extension pairing is not needed for normal use.

### macOS shortcut

After installing Node.js/npm, open **Start Echo Companion.command**, or run:

```sh
zsh "Start Echo Companion.command"
```

The launcher opens an existing helper if one is already running. Otherwise it installs missing dependencies and starts the helper. Node.js and npm must be available to the launcher; if they are not found, use a terminal where `node --version` and `npm --version` work, then run `npm start`.

### Stop the helper

Press **Ctrl-C** in its terminal. Closing the browser tab or extension does not stop the helper.

Saved accounts and playlists survive a restart. The automatic playlist queue, playback attempts, and command history are held in memory and do not resume after restarting the helper. Keep the helper and computer running while its queue is in use; closing the app tab alone does not stop that queue. Stopping the helper is not a command to stop audio already playing on the Echo.

## Connect Amazon and your Echo

1. Open the app and choose your **Amazon account region** and **Echo language** in the left sidebar.
2. Click **Connect Amazon**, then **Open Amazon sign-in** when offered.
3. Complete Amazon's sign-in and any verification in the opened browser page.
4. Return to Echo Library and wait for **Amazon connected**.
5. Under **Play on**, select your Echo speaker.

Use the Amazon account the Echo is registered to. Amazon region, catalogue country, and the music account's country are separate settings; changing one does not transfer an account to another region.

Amazon session data is stored locally and reused on later starts. The optional [helper setup page](http://127.0.0.1:4320/setup) also exposes Amazon connection status. Its pairing-code controls are retained for older API clients and are not part of the current toolbar-launcher setup.

## Choose a streaming service

The two sidebar choices serve different purposes:

| Setting | Purpose | What it requires |
| --- | --- | --- |
| **Play on → Streaming service** | Determines which service Alexa is asked to use on the Echo. | That service must be linked in the Alexa app and available to your Amazon account. |
| **Music catalogue → Platform** | Selects an optional browsing/account connection in Echo Library. | The corresponding app credentials and account authorization, described below. |

Connecting a catalogue account here does not link that service to Alexa. Importing a playlist also does not transfer its audio or subscription rights.

With **Apple Music** selected as the streaming service, a normal request is similar to `play song Lover by Taylor Swift on Apple Music`. Choosing **Alexa default** omits the explicit service and lets Alexa choose. If Alexa uses an unexpected service, select one explicitly here and verify its linking in the Alexa app.

Available services are discovered from the Amazon account, with a fallback list when discovery is unavailable. A listed service is not confirmation of subscription access. YouTube Music is a catalogue/import source, not a native Echo playback service in this app; its imported songs are requested through the supported streaming service you select.

## Optional music account connections

Skip this section if public search, public imports, and local playlists are enough. These connections provide account/library access and stronger catalogue checks; they are not mandatory for sending music to the Echo.

### Apple Music

1. Select **Apple Music** under **Music catalogue** and expand **App setup**.
2. Supply your Apple Developer **Team ID**, MusicKit **Key ID**, and Media Services private key (`.p8`), then save. Alternatively, use an existing valid MusicKit developer token in the advanced field.
3. Click **Connect Apple Music** and authorize your Apple Music account in Apple's window.

App credentials are separate from an Apple Music subscription. Apple documents the Media ID/key setup and the required Account Holder or Admin role in [Create a media identifier and private key](https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key/). See also [MusicKit](https://developer.apple.com/musickit/). A normal Apple account sign-in alone does not create these developer credentials. Expired developer tokens need replacing; the key-based setup generates tokens locally.

The key is stored by the local helper, not in the extension files. Keep the original downloaded key outside the Git checkout. Apple storefront and account access can differ from the selected public-search country.

### Spotify

1. Create a Spotify developer app and register this exact redirect URI:

   ```text
   http://127.0.0.1:4320/api/spotify/callback
   ```

2. Select **Spotify → App setup**, enter its **Client ID**, and save. This integration uses authorization code with PKCE and has no Spotify client-secret field.
3. Click **Connect Spotify** and authorize your account.

Spotify requires a literal loopback address, not `localhost`; see [Redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri). Development-mode apps have Premium/access restrictions, including an active Premium subscription for the app owner; check the [current development-mode requirements](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and the app dashboard for permitted users. Spotify's API may limit which playlist contents are accessible. Public imports remain a separate option.

### YouTube Music / YouTube

1. Create a Google Cloud project, enable **YouTube Data API v3**, and configure its OAuth consent screen/test users as applicable.
2. Create an OAuth client of type **Desktop app**.
3. Select **YouTube Music / YouTube → App setup**, enter the client ID and client secret, and save.
4. Click **Connect YouTube Music / YouTube** and approve the read-only YouTube permission.

The helper receives the desktop OAuth callback at:

```text
http://127.0.0.1:4320/api/youtube/callback
```

This is a desktop loopback flow, rather than a Web application client with a website-origin setup. Google's [OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app) explains the credentials and authorization process.

The connection exposes accessible YouTube playlists; the YouTube API does not provide this app with the complete YouTube Music library. Public playlist links can be loaded without this connection. Private playlists need account access. The requested scope is `youtube.readonly`.

## Search, playlists, and playback

### Search

Select a catalogue country and type at least two characters. Search updates after a short pause; **Enter** or **Search** runs it immediately. India is the initial default. Country filtering follows the selected catalogue's data; finding a song does not guarantee that Alexa or every streaming service can play it in that country.

A song request starts with an individual artist credit, while the interface retains the full artist list. Spoken requests omit film credits and language-only tags such as `[Tamil]`; library titles stay complete, and Live, Remix, Taylor’s Version and other recording labels remain meaningful. Artist preferences for identified Apple Music, Spotify, and YouTube songs can retain a verified or explicitly chosen first artist without changing the displayed credits. The helper checks the Echo's reported song/service and can try alternative individual credits if needed. If a title-track request instead starts a different song from its same-named album, and fresh album/artist/service metadata supports that interpretation, it tries **“No, just play the title track”** once before continuing the artist alternatives. It still requires fresh confirmation of the selected song; missing album evidence does not trigger that follow-up. For any song with a reliable release year, a confirmed wrong recording can also trigger one backup request with the year, such as **“play song Shake It Off 2014 by Taylor Swift on Apple Music”**. The initial request stays unchanged. If the year is missing, a bounded catalogue lookup is attempted; ambiguous results or unknown years are not guessed. The selected release/version stays intact, including Taylor’s Version when selected. Matching is based on reported metadata and can be imperfect. A successful request acknowledgement is shown separately from confirmed song playback.

### Import a playlist

1. Open **My playlists → Import playlist**.
2. Paste a link into the first, optional field. Supported links are loaded automatically; **Load songs** remains available.
3. Review the detected platform, source name, country, and song details.
4. Keep the suggested name, such as **Spotify: Top 50 - India**, or enter your own.
5. Correct any missing titles/artists and review partial-import notices, then save to Created.

| Source | Public link import | Optional account connection |
| --- | --- | --- |
| Apple Music | Yes, when public metadata is accessible. | MusicKit / Apple Music. |
| Spotify | Yes; public embeds may expose only part of a playlist. | Spotify OAuth. |
| YouTube / YouTube Music | Yes; available continuation pages are fetched up to the import limit. | Google OAuth for accessible/private playlists. |
| Amazon Music | Yes, when usable public playlist metadata is exposed. | No catalogue-account connector. |
| JioSaavn | Yes, when usable public playlist metadata is exposed. | No catalogue-account connector. |

A link can identify its platform and source title. Country is inferred only when the link supplies a supported explicit country/storefront; otherwise the current selection is retained. Language codes and share-tracking parameters are not treated as countries. Names you type are preserved during automatic loading.

Instead of a link, paste one song per line using a spaced em dash:

```text
Lover — Taylor Swift
Baby — Justin Bieber
```

Loading or saving does not play audio. The current local-library limits are **100 playlists**, **500 songs per playlist**, and **10,000 songs overall**. Hidden/unavailable entries, unknown full counts, and missing artist credits are reported rather than silently presented as a complete import. A public page may omit data that appears when signed in to its music app.

### Source identity, artwork, and sync

Your chosen name remains the main title. Imported playlists also retain the original platform and source name, original cover when available, original author/curator when supplied, and a link that opens the source playlist in a new tab. Older saved playlists can load missing source metadata when opened. Song artwork is resolved when available; a music-note placeholder remains when no usable artwork can be found.

**Sync from source** loads a review of the latest source copy. It shows song counts/additions/removals and any incomplete-import warning before you apply the replacement. Your chosen local name stays intact, and the old saved playlist is backed up first. Applying sync replaces the saved songs/order with the reviewed source copy; local edits can therefore be replaced. Sync does not modify the original service playlist and does not run automatically in the background.

### Playlist queues and controls

Click a song's thumbnail/play button to start from it and queue a complete cycle. Starting song 5 in a ten-song playlist produces:

```text
5 → 6 → 7 → 8 → 9 → 10 → 1 → 2 → 3 → 4
```

Without Repeat All, the cycle ends after song 4. With Repeat All enabled, song 5 starts the next cycle. **Shuffle**, to the left of Previous, changes upcoming order. **Repeat All**, to the right of Next, repeats the cycle. These modes control the helper's song queue, not a music website or a provider's native playlist mode.

The queue sidebar lets you inspect and edit upcoming songs. Play/pause, previous/next, seeking, and volume target the selected Echo; availability depends on its reported state and the music service. The helper watches playback to advance its own queue. Device changes or an unverified recording can pause that process and require attention.

Where offered, **Play playlist directly** asks Alexa to play the named playlist through its native service. This is separate from the helper's song-by-song queue; Alexa still needs to recognize and have access to that playlist.

### When Alexa plays the wrong song

After all song-request attempts fail with a confirmed mismatch, the helper can keep the recording Alexa is already playing as the current queue slot. It shows a warning with the requested and actual song, confirms stable advancing playback, and watches that recording to its end before requesting the next queued song. It sends no extra playback command to accept the substitute, does not insert an extra item, and keeps the pending order intact. The saved playlist and Repeat All source cycle retain the originally requested song. Unknown, paused, stopped, or incomplete playback information still requires attention rather than assuming a song ended.

### Recover a queue after a manual correction

If a queued song cannot be confirmed, the remaining queue stays available. After a manual command starts identifiable music, the helper waits for two stable observations with advancing song progress, inserts that actual song immediately after the failed item, and treats it as current without requesting it again.

For example, if item 5 of 10 fails, a manually started song becomes item 6; the original items 6–10 become 7–11. **Next** and automatic end detection continue with the original item 6. Pending song IDs/order, the queue identity, and Shuffle/Repeat All settings are retained. The adopted song is monitored on its actual reported service; later queued songs still use the queue's selected service.

Typed commands keep queue ownership while cancelling automatic song retries. An unrelated command does not insert an unchanged song. If an already-confirmed current song continues after the command, monitoring resumes without an extra queue item. A failed queue also watches reported playback for spoken/external corrections while the helper runs, with slower polling after the initial recovery period. This inference uses song metadata/progress and cannot distinguish a voice request from a service's own automatic song change. Missing song identity, duration, provider, or progress leaves the queue waiting for confirmation. Explicit Clear/Cancel or a new selection stops the old recovery watcher.

### Commands sidebar

Use **Commands** to show/hide the right sidebar and send your own Alexa text command. History keeps up to **100 commands from the current helper session**. Request acceptance, a readable Alexa response when one is available, and Echo playback observations are distinct fields. Amazon often supplies no readable response; the app does not invent a transcript. A custom command cancels automatic song retries while preserving a same-speaker queue; newly confirmed music can be adopted as its current item as described above.

## Local data and backups

Private data lives inside **`.local/`**, which is excluded by `.gitignore`:

| Location | Contents |
| --- | --- |
| `.local/amazon/` | Amazon session/registration data and account region/language settings. |
| `.local/library/playlists.json` | Created/imported playlists, source metadata, song details, and ordering. |
| `.local/library/request-artists.json` | Saved artist-request preferences. |
| `.local/library/apple-*.json` | MusicKit setup and Apple Music account authorization. |
| `.local/library/spotify-*.json` | Spotify app setup and account authorization. |
| `.local/library/youtube-*.json` | Google app setup and account authorization. |
| `.local/library/sync-backups/` | Previous saved copies created before source sync. |
| `.local/pairing.json` | Optional compatibility API pairing state. |

The browser also stores interface preferences locally. Helper queues and command history are not durable library backups. Configuration is entered through the app; no checked-in credentials or `.env` file are required.

Stop the helper before backing up or restoring its data. For a complete private backup, copy `.local/` to a safe location outside Git. To move only the music library, copy `playlists.json` and, if wanted, `request-artists.json` into the new installation's `.local/library/` while both helpers are stopped. Back up the destination first: copying these files replaces its existing library rather than merging it. Sessions may need sign-in again after a move.

Saved files use restricted local filesystem permissions, but they are not an encrypted vault. Account tokens, private keys, session cookies, and backups containing them should remain private. Use the app's disconnect controls to remove the corresponding saved sign-in; do not delete the entire `.local/` directory as a routine troubleshooting step.

## Git repository contents

Commit the application source, tests, extension icons/assets, launcher, `README.md`, `.gitignore`, **`package.json` and `package-lock.json`**. Dependencies are installed after cloning.

The ignore rules exclude `.local/`, `node_modules/`, `.npm-cache/`, `.DS_Store`, logs, HAR captures, personal `.env` files (while allowing `.env.example`), and common private-key formats (`.p8`, `.pem`, `.key`, `.p12`, `.pfx`). A clone therefore does not include your private library/accounts or installed dependencies. Keep downloaded keys and OAuth credential exports outside the checkout as well; review staged files because credentials can have arbitrary filenames.

After you initialize the repository, inspect what will be published:

```sh
git status --short --ignored
git diff --cached --stat
git diff --cached --name-only
git ls-files -- .local node_modules .npm-cache
```

The final command should produce no tracked paths. Ignore rules do not remove files that were already tracked; check the staged contents before the first push. Use sanitized examples for issues/tests rather than real account files or session-bearing logs.

## Development and updates

```sh
npm run check
npm test
```

`check` validates manifest entry files and JavaScript syntax. `test` runs the Node test suite, including account flows, loopback/CSRF boundaries, public imports, source metadata/sync, artwork, matching, controls, queues, frontend behavior, and isolated standalone hosting. Tests use mock account/Echo connections and temporary data; passing them does not verify your own provider authorization or every live Echo/service combination.

| Change | How to load it |
| --- | --- |
| Frontend files in `library/public/` | Refresh the app tab. |
| Helper/backend files | Stop and restart `npm start`, then refresh. The in-memory queue/history is cleared. |
| Extension launcher or manifest | Click **Reload** on the browser's extensions page, then reopen the app. |
| Dependency lockfile | Stop the helper, run `npm ci --ignore-scripts`, then restart. |

Keep private backups before moving or replacing an installation. The original separate web-app project is not a dependency of this repository.

App-owned questions and confirmations use dialogs inside Echo Library rather than native browser alert/confirm/prompt boxes. Provider sign-in still opens the provider’s own authorization window.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Toolbar opens an unavailable page / connection refused | Start the helper and open `http://127.0.0.1:4320/`. The toolbar does not start Node.js. |
| Node/npm is not found by the macOS launcher | Verify both commands in a terminal and use `npm start` from the project root. |
| Port 4320 is already in use | Check whether another copy of the helper is running; use that copy or stop its own terminal before starting this one. |
| Amazon sign-in reports a busy local port | Check for another Amazon sign-in/helper instance using port 4321. |
| Echo is missing or offline | Verify the signed-in Amazon account, selected Amazon region, device registration, and Echo connectivity. |
| Alexa plays through the wrong service | Choose an explicit Streaming service and check that service's linking/subscription in Alexa. Catalogue sign-in is separate. |
| A saved playlist’s Play button is disabled | Select the same catalogue country as the playlist; also check the Echo connection and wait for any active request to finish. |
| A listed song does not play or the recording is wrong | Check title/artist credits, country and service; inspect attempt status and Commands. Alexa's catalogue/matching can differ from search results. |
| An import contains fewer songs or blank artists | Review the partial/missing-data notice. Public pages can hide songs or omit credits. Use an authorized connection where supported, or paste/correct the missing details. |
| Author or artwork is missing | The source may not expose it, or the lookup may have failed. Reopen/refresh later; the source link remains usable when known. |
| Spotify rejects sign-in | Check the exact callback, Client ID, permitted users and current development-mode/Premium requirements. |
| Google rejects sign-in | Check Desktop client credentials, enabled YouTube Data API v3, consent/test-user settings, and the displayed callback. |
| An account window does not open | Check the browser's blocked-popup indicator and allow the intended account sign-in window for this local app. |
| The interface is old after an update | Apply the refresh/restart/extension-reload step for the type of file changed above. |
| Queue stops progressing | Keep the helper/computer running, check Echo status and queue notices, and confirm the current song. A helper restart does not restore its old queue. |

## Limitations

- Alexa access uses the third-party `alexa-remote2` integration, rather than a public Alexa music-control API. Amazon changes can affect login, commands, response text, or reported playback.
- Public playlist import depends on available source metadata. It cannot recover hidden/private/unavailable songs, guarantee a complete Spotify embed, or guarantee every song's availability on the Echo's selected service.
- Provider account rules, rate limits, country restrictions, and subscriptions still apply. Account connections require each installation's own usable app setup.
- MusicKit authorization uses Apple's web SDK in the ordinary local app page, not inside an extension page.
- There is no browser-music Follow mode, tab-audio forwarding, or automatic control of a YouTube Music/Spotify/Apple Music website. The extension opens Echo Library.
- Seek, queue progress and song/service confirmation depend on the state Amazon reports. Requests and retries can be audible; metadata matching is not an audio-fingerprint guarantee.
- The helper is a local, single-user service. It binds to loopback and is not configured as a public hosted or multi-user application.

## Project structure

```text
extension/                  Toolbar launcher, icons, and compatibility API/client files
library/public/             Full browser interface (HTML, CSS, JavaScript)
library/                    Account, catalogue, import, playlist, playback, and queue engine
library/test/               Engine tests included by the top-level test suite
helper/                     Local setup and optional pairing page
alexa/                      Supporting Alexa/catalogue/response modules
alexa-connection.mjs         Local Amazon connection adapter
server.mjs                  Loopback HTTP host and request boundaries
scripts/check.mjs           Manifest and syntax validation
test/                       Integration, frontend, helper, and regression tests
legacy/library-0.3/         Archived extension-page UI and tests; not the current runtime
Start Echo Companion.command  macOS startup shortcut
package.json                Runtime requirements and npm scripts
package-lock.json           Locked dependency versions
.local/                     Generated private data; excluded from Git
```

The app enforces loopback Host/Origin/cross-site checks and JSON app headers for mutations. Exact Spotify/YouTube OAuth callbacks use state/PKCE checks. Compatibility `/api/library/` requests also require extension-origin and pairing authorization. The archived/compatibility files are retained for development history and regression checks; their presence does not enable the old Follow interface.

## License

No project `LICENSE` file is currently included. A project license has not been selected in this repository.
