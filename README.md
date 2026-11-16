# АПОЖ

Party game: one player secretly sings a song, the recording is played backwards, another player imitates the backwards audio, that imitation is reversed again and everyone guesses the song.

Built for a laptop connected to a TV: everything is controlled with the keyboard (shortcuts are shown on the buttons). Players can also scan a QR code and sing on their own phone in another room; the take is sent to the TV.

Run locally (microphone access needs `https` or `localhost`):

```bash
npm install
npm start          # http://localhost:8080, PORT overrides
```

`server.js` serves the static files and relays messages between the TV and phones over a WebSocket (`/ws`), in memory, one room per TV. Hosted on Railway: https://apozh-production.up.railway.app (service `apozh`, built from this repo with Railpack). Pushes deploy automatically only once the Railway GitHub app has access to the repo; otherwise trigger a deploy in Railway. The GitHub Pages copy redirects there. Without the server the game still works, just without phones.

- `app.js`: game flow and screens
- `ui.js`: DOM helpers, keyboard shortcuts, widgets (recorder, waveform, confetti)
- `audio.js`: microphone capture, reverse, playback, jingles
- `songs.js`: song deck by category
- `net.js`: WebSocket link, TV-side room and phone tracking, QR codes
- `phone.js`: phone mode (`/#join=CODE`)
- `server.js`: static files + room relay
