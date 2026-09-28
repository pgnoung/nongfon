// The live list of cameras = the ones in .env (CAMERA_*) plus the ones the owner added through the
// finder. We rebuild config.cameras in place (same array reference) so the watch loop, the live view and
// the web server all see a newly added camera on the next cycle, with no restart.

/** Rebuild `config.cameras` in place from the .env base plus the store's user cameras. */
export function applyCameras(config, store) {
  const base = config.baseCameras || [];
  const user = store.listUserCameras().map(({ id, name, url }) => ({ id, name, url }));
  const seen = new Set();
  const merged = [];
  for (const cam of [...base, ...user]) {
    if (seen.has(cam.id)) continue;
    seen.add(cam.id);
    merged.push(cam);
  }
  config.cameras.length = 0;
  config.cameras.push(...merged);
  return config.cameras;
}
