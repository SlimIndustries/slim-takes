# Building Slim Takes

You only need this if you're making a new .exe. Same idea as Slim Reaper.

## Option A — build on your PC

1. Install **Node.js LTS** from https://nodejs.org (if you don't already have it from Slim Reaper).
2. Unzip this folder somewhere, e.g. `C:\Projects\slim-takes`.
3. Open that folder, click the address bar, type `cmd`, press Enter.
4. Run:
   ```
   npm install
   npm start
   ```
   `npm start` opens the app straight away so you can try it.
5. To make the portable .exe:
   ```
   npm run dist
   ```
   It appears in the `dist` folder as `SlimTakes-1.0.0-portable.exe`.

### If `npm start` says "Electron failed to install correctly"

Newer versions of npm block Electron's setup step. Run these in the slim-takes folder, one at a time:
```
npm install-scripts approve electron
curl -L -o electron.zip https://github.com/electron/electron/releases/download/v39.8.10/electron-v39.8.10-win32-x64.zip
powershell -Command "Expand-Archive electron.zip -DestinationPath node_modules\electron\dist -Force"
echo|set /p="electron.exe">node_modules\electron\path.txt
del electron.zip
```
(If `npm install` put a different Electron version in place, check it with `npm ls electron` and use that number in the link.)

## Updating an existing copy

When you get a new source zip: copy the new files over your old `slim-takes` folder and say yes to replacing.
Keep your `node_modules` folder. Unless the notes say otherwise, no `npm install` is needed: just `npm start`.

## Option B — let GitHub build it

1. Make a public repo called **slim-takes** on the slimindustries account and upload everything in this folder.
2. Make a release with a tag like `v1.0.0`.
3. The workflow in `.github/workflows/build.yml` builds the .exe on a Windows machine and attaches it to the release (takes ~5 minutes; watch the **Actions** tab).

## If the repo name is different

The app checks `slimindustries/slim-takes` for new versions. If you name the repo something else,
change `UPDATE_REPO` in `src/main/settings.js`.

## Making a new version

Change `"version"` in `package.json` (e.g. `1.0.1`), rebuild, and release it with tag `v1.0.1`.
Everyone on an older version gets a "new version is out" banner.

## Tests

`npm test` runs the automatic checks (file naming, duplicates, formats, the queue).
The queue tests use a pretend downloader and run on Linux/macOS; on Windows run `node --test test/core.test.js`.

## Where Slim Takes keeps its stuff

`%APPDATA%\Slim Takes\` — settings, history, the log, and the `engine` folder (yt-dlp, ffmpeg, Deno).
Forgot your PIN? Close Slim Takes and delete `settings.json` there (your other settings reset too).
