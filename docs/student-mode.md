# Student mode (campus guide, offline demo)

A switch at the top of the map chooses **Student** or **Evacuation**. The chosen mode takes 80% of the
bar (black), the other 20% (light grey). The choice is remembered on the device. An emergency alert, or
the test alert, always switches to Evacuation.

| | Student | Evacuation |
| --- | --- | --- |
| Map and cards | 16 Nagoya University (Higashiyama) buildings | Official Nagoya evacuation sites (online) or demo points |
| Card button | 3D AR directions + Details | same |
| Details | Photo, floors, type, hours, what's inside | Capacity, type, location, rated for |
| Ask Contour | Offline: finds the building in the question, answers with direction, distance, nearby building, hours, a photo, **3D AR directions** and **Show on map** | Gemini via the backend |
| Indoor navigation (demo) | Details → "find a classroom", or a prompt within 10 m of the building during 3D AR | Before 3D AR: "Are you inside a building?" Yes → to the nearest exit, then 3D AR |
| Menu | Building list, Ask Contour, About, Speech & Translation | Area list, Attendance, Disaster info, Ask, Know-how, Emergency pop-up, About, Test alert, Speech & Translation |

All texts are in English, 日本語, 中文 and 한국어.

## Data (in `android/app/src/main/assets/contour.html`)

- `BUILDINGS`: names in four languages, position, type, floors, hours, what's inside, search keywords.
  Positions come from OpenStreetMap; hours and details are approximate demo values.
- `window.CAMPUS_PHOTOS` / `window.CAMPUS_CREDITS`: 9 building photos from Wikimedia Commons
  (CC BY-SA 3.0 / 4.0), shrunk to 560 px and embedded so the demo works offline (~340 KB). The author
  is shown on each photo and the About page credits Wikimedia Commons. Buildings without a photo show a
  drawn placeholder.

## Going online later

- Ask: replace `campusReply()` with a backend call (Gemini) that returns a building id; the answer
  layout (`addAsk(..., { building })`) stays the same.
- Photos: load from the backend or Wikimedia when online, keep the embedded ones as the offline fallback.
- More buildings or campuses: add entries to `BUILDINGS`.
