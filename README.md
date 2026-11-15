# АПОЖ

Party game: one player secretly sings a song, the recording is played backwards, another player imitates the backwards audio, that imitation is reversed again and everyone guesses the song.

Static site, no build step. Open `index.html` through any web server (microphone access needs `https` or `localhost`):

```bash
python3 -m http.server 8000
```

Built for a laptop connected to a TV: everything is controlled with the keyboard (shortcuts are shown on the buttons).

- `app.js`: game flow and screens
- `ui.js`: DOM helpers, keyboard shortcuts, widgets (recorder, waveform, confetti)
- `audio.js`: microphone capture, reverse, playback, jingles
- `songs.js`: song deck by category
