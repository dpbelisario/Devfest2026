# Shared floor-overlay snapshot

The user explicitly requested publishing the floor plan saved in their iPhone app
with the code on main. It was exported from the app's single saved-overlay file
on 2026-11-08. No other phone files, preferences, GPS history, credentials or
signing data are included.

Artifact: `ios/Contour/Resources/default-floor-overlay.json`. The decoded image
is the Central Library **2F** plan. The reference source already documented by the
project is [Nagoya University Central Library floor maps](https://www.nul.nagoya-u.ac.jp/central/floormap_e.html)
and its [2F image](https://www.nul.nagoya-u.ac.jp/central/images/2f.jpg).
This export preserves the user's saved normalized PNG, rather than downloading or
substituting another image. Source ownership remains with the library.

Decoded PNG: 813,944 bytes, SHA-256 `73427f34369579b61003899acf6f420e01456ab604b8709a1f67486d9e9ef0d4`.

The user's saved geographic center, metric width, aspect ratio, angle, opacity,
visibility and name are preserved exactly. These are manual alignment settings,
not surveyed accuracy or verified exit guidance. The imported plan does not create
walls, walkable edges or live positioning. Existing local saves override this
bundled default; fresh iPhone installs load it automatically.
