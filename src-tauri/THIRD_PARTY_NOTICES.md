# Beatboard third-party runtime notices

Beatboard distributes or downloads the following runtimes on behalf of the user.

## FFmpeg 8.1.2

Beatboard bundles an FFmpeg command-line sidecar built from official tag `n8.1.2`
at commit `38b88335f99e76ed89ff3c93f877fdefce736c13`. The Beatboard build disables GPL
and nonfree components. Beatboard prefers the macOS VideoToolbox H.264 encoder and
falls back to FFmpeg's built-in LGPL MPEG-4 encoder when VideoToolbox is unavailable.

FFmpeg is licensed under LGPL 2.1 or later. The exact corresponding source is
available from https://git.ffmpeg.org/ffmpeg.git at the commit above. Beatboard's
reproducible build configuration is in `scripts/build-bundled-ffmpeg.sh`.

FFmpeg copyright and license details: https://ffmpeg.org/legal.html

## Node.js 24.18.0

Beatboard downloads the official macOS Node.js archive from https://nodejs.org and
verifies its SHA-256 digest before extraction. Node.js is distributed under the
MIT License and includes third-party software under their respective licenses.
The downloaded runtime retains its upstream `LICENSE` file.

## PixVerse CLI 1.2.9

Beatboard installs the official `pixverse` npm package into Beatboard's private
Application Support directory using the checked-in `package-lock.json`.
PixVerse CLI is licensed under the MIT License. Its npm dependencies retain
their own license and notice files in the managed runtime directory.

PixVerse CLI source: https://github.com/PixVerseAI/cli
