Place U1-profile G-code for one, two, three, and four copies of model/proof-token.stl here:

- proof-token-1.gcode
- proof-token-2.gcode
- proof-token-3.gcode
- proof-token-4.gcode

These files depend on your exact printer profile, filament and slicer. They must be inspected and printed with an operator present. The gateway will not report operational until all four files are present and Moonraker responds. It can accept new orders while a healthy print is in progress; it starts the next batch only after the operator confirms the completed plate in `/admin`.
