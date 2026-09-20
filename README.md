# Gemini Video Prompt Queue v0.8.3

A Chrome extension that queues scene prompts into one Gemini conversation, selects the Avatar tool before every scene, waits for generation to finish, and can automatically download each completed scene.

## Install / update

1. Unzip the extension into a permanent folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. If updating an existing unpacked install, replace the old files with these and click **Reload** on the extension card. Otherwise click **Load unpacked** and select this folder.
5. Refresh your Gemini conversation.

## Typical workflow

1. Open the Gemini conversation you use for Avatar video generation.
2. Click **Load scenes** and select the queue `.md` file.
3. Click **Bind to this chat**.
4. In **Settings**, leave Avatar enabled and position `2` if Avatar is the second item in Gemini's `+` menu.
5. Test one scene with **Send one**.
6. When that works, use **Start / Resume**.

## Automatic downloads

Enable **Auto-download each completed video**.

Set **Download subfolder** to something such as:

`YouTube`

Chrome will save files like:

`Downloads/YouTube/Scene_027.mp4`

`Downloads/YouTube/Scene_028.mp4`

If a scene heading has a descriptive title, that title is included too, for example:

`Scene_027_VHS_vs_LaserDisc.mp4`

### Why it saves under Downloads

Chrome's Downloads API intentionally restricts unattended extension downloads to paths beneath Chrome's configured Downloads directory. The extension can choose subfolders and filenames, but it cannot silently write to an arbitrary absolute path such as `D:\Projects\LaserDisc`.

If you want a particular physical folder to be the base destination, set Chrome's download location to that folder in Chrome Settings, then use the extension's subfolder field underneath it.

For fully automatic operation, turn off Chrome's **Ask where to save each file before downloading** setting. Otherwise Chrome will open a Save As dialog for every scene.

## Safety / recovery

- **Pause** stops queue processing.
- **Retry current** regenerates the scene currently shown.
- **Mark finished + continue** advances a visibly completed scene if Gemini's beta UI changed and the completion detector missed it.
- When auto-download is enabled, the extension does not advance the scene if it cannot find Gemini's Download button.


## Background/reference image

Choose an image under **Settings → Background/reference image**. It is saved by the extension and automatically attached to every queued Avatar scene before the prompt is sent. The extension also prepends a background-reference instruction to each scene. Use **Clear image** to disable it.


## v0.5.2
Prevents duplicate background-image attachment attempts by detecting an existing composer attachment before and between upload methods.


## v0.5.2 background attachment fix
Background/reference images are now attached using paste only. The extension will never reopen Gemini’s + menu as a fallback for the image; + is reserved for selecting Avatar.


## v0.7 download reliability

- Scrolls the Gemini conversation/result into view before looking for Download.
- Hovers the newest video/result to reveal hidden actions.
- Tries the newest actions menu if Download is hidden there.
- Arms filename renaming immediately before the click; the next download is renamed without hostname/MIME guessing.
- Waits for Chrome to confirm the download actually started before advancing the queue.
- If Chrome never confirms a download, the queue pauses on the current scene instead of silently skipping it.


## New in v0.7

- Detects Gemini's “You have 2 video generation requests running right now…” response.
- Waits 10 minutes on the first busy response, then adds 5 minutes for each consecutive busy response.
- Retries the same scene after cooldown instead of advancing the queue.
- Resets the busy backoff after a successful scene.


## v0.7.1 busy-backoff reset fix

- A busy cooldown now applies only when a new “video generation requests running right now” response appears after the current scene was submitted.
- Old busy replies already in the chat cannot retrigger cooldowns when Gemini re-renders the conversation.
- A successful scene resets the busy retry count and cooldown before the next scene.
- Manually marking a scene finished also clears the busy backoff.


## New in v0.7.2

- Auto-download failures are now non-fatal. The queue advances to the next scene even if Download cannot be found, started, confirmed, or renamed.
- Failed download attempts clear their pending rename token so they cannot affect a later unrelated download.
- The extension shows a warning status when a scene finished successfully but its auto-download failed.


## New in v0.8.3

- Simplifies completion detection around Gemini's prompt composer instead of requiring the generated video card DOM to settle.
- After the queue observes Gemini become blocked/occupied by generation, it advances once the composer is usable again for 2.5 seconds.
- A newly visible video/download/result remains a fallback completion signal when Gemini does not expose the blocked-composer transition.
- Removes the separate completion-guard content script from the extension runtime so only one completion system decides when to advance.
- Keeps **Mark finished + continue** as a manual escape hatch, but it should be needed much less often.
