# Prepared print plates

Place operator-inspected U1 G-code here, named `proof-token-N.gcode`, where **N is the exact number of customer objects on that plate**. For example:

- `proof-token-1.gcode`
- `proof-token-3.gcode`
- `proof-token-6.gcode`
- `proof-token-12.gcode`

The gateway discovers nonempty regular files on each heartbeat; directories, symlinks, empty files and invalid names are ignored. Counts 1–1000 are accepted as an input sanity bound, not a statement about printer capacity. You do not need every intermediate size. Supply a one-object file to ensure a small remaining queue can be fulfilled.

“Start the next batch” selects the largest available size no greater than the paid queue. With files for 1, 3 and 6 and five waiting orders, it selects 3. Existing queued plates retain their size and require the matching file.

The operator must verify the slicer profile, filament, actual object count and safe movement. The app cannot infer these from the filename. G-code is not committed to Git; the directory is mounted read-only in the gateway. Do not change a file while its plate is being prepared. Empty the physical plate and confirm it in the dashboard before every new start.
