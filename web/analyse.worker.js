// Runs the track analysis away from the page, so the app stays responsive while a song is measured.
import { analyseTrack } from "./dsp.js";

self.onmessage = (e) => {
  const { id, x, sr } = e.data;
  self.postMessage({ id, result: analyseTrack(x, sr) });
};
