# Indoor room directions: Engineering Building II pilot

Contour uses the supplied Student/Evacuation design. In **Student → Ask**, ask
“How do I get to room 221 in Engineering Building II?” Select a room or landmark
you recognize, then open **3D AR**. Chat and the camera overlay use the same ordered
route steps. There is no separate classroom dashboard.

## Try the prototype

Use Node 24. From the repository root run `npm ci` and `npm run dev`, then open
`http://localhost:8080/app/`.

1. Select **Student**, open **Ask**, and ask the question above.
2. Select **Mechanical Engineering Office · Middle wing 3F** as your starting
   landmark. Room 221 remains the destination, on middle-wing 2F.
3. Read the directions: face the corridor landmark, continue to the north-wing
   stairs, go down to 2F, then follow the corridor to room 221.
4. Open **3D AR**. Face the named landmark and tap **Align here**. With a phone
   compass, the camera arrow rotates relative to that alignment. Without compass
   data, it is explicitly a step illustration. Stairs have an up/down overlay.
5. Tap **Next landmark** only when you reach it. After stairs, align again. The
   final action is **Confirm room door**, requiring a door-sign check.
6. Use **I'm elsewhere** if you lose your place. It clears the route and asks for
   a new recognizable checkpoint. Closing AR or hiding the page stops its camera.

GPS can suggest Engineering II and asks whether you are inside. GPS never chooses
your indoor floor, room, or facing direction. A room/landmark supplies the start.
New questions require the backend; a failed request clears the previous route and
offers a visible retry message. The bundled APK calls the existing public host,
which must first receive this backend change. Camera access needs HTTPS or localhost.

## What the prototype knows

The [official 2026 Engineering handbook](https://www.engg.nagoya-u.ac.jp/current/doc/binran/binran_2026.pdf#page=36)
(PDF page 36, printed page 30) places room 221 and 222 in the middle wing on 2F,
231/232 in the south wing on 3F, 241 in the south wing on 4F, and 242/243 in the
north wing on 4F. It also identifies the middle-wing office on 3F and library on 1F.
The building coordinate comes from the
[university campus directory](https://www.nagoya-u.ac.jp/extra/map/a_js/map_data.csv).
The catalog retains the 17 rooms of
[ILAS Building A](https://office.ilas.nagoya-u.ac.jp/files/kyomu/map/ILAS_A_building_map.pdf).

Door connections, corridor coordinates, turns, stairs and lift paths are
interpretations of the plans. **Every edge remains unsurveyed.** Costs are relative
graph weights, never meters or ETAs. The UI says “Floor-plan preview · check signs.”
Avoiding stairs does not verify lift operation or step-free access.

Room questions are parsed deterministically; route language comes from graph
connections, rather than a new Gemini conversation. The existing evacuation
assistant remains separate. There is no camera recognition, QR scanner, continuous
indoor positioning, world anchor, BLE/Wi-Fi localization, or automatic progress.
Physical-phone AR alignment and real corridor routes still need field testing.
These ordinary classroom previews are not emergency evacuation routes.

## Catalog and API

`backend/data/indoor.json` is canonical. `backend/scripts/sync-indoor.mjs` embeds
it in the shared HTML asset during `dev` and `build`; run it before an Android-only
build if you change the catalog. Do not edit its embedded copy manually.

- `GET /api/indoor/catalog`: versioned nodes, edges and provenance.
- `GET /api/indoor/rooms?q=221`: normalized room lookup.
- `GET /api/indoor/route?buildingId=nu-eng2&from=eng2-office-3&to=eng2-221&avoidStairs=true`:
  stairs-free graph preview. Invalid input is 400, unknown nodes 404, no path 422.
- `POST /api/indoor/ask`: room question plus optional GPS and conversation context;
  returns building/checkpoint choices or structured steps and matching chat text.

Example body:

```json
{
  "message": "How do I get to room 221 in Engineering Building II?",
  "language": "en",
  "context": { "buildingId": "nu-eng2", "checkpointId": "eng2-office-3" }
}
```

## First campus test

Walk Engineering II to check the door labels, corridor connections and floor signs.
Record evidence and a survey date before marking any edge surveyed. Then test
three journeys with students: same floor, stairs to another floor, and recovery
after a wrong turn. Check they can identify the starting landmark independently.
Surveyed landmarks or approved checkpoint QR links are the next step toward
reliable localization; timetable/class-name integration can follow later.

## Merge and rollback

The prototype branch is `david/campus-class-finder`. Squash its PR into `main` to
make the whole prototype one revertible commit. It also includes the unmerged
shared-alert/iPhone scaffold from `david/kmp-ios`; that work should not be merged
again separately. Native iPhone compilation remains unverified without full Xcode.

To undo the prototype, revert the resulting **squash commit** through a new PR
(`git revert <squash-commit>`). Redeploy the reverted backend and HTML, and rebuild
the reverted Android app with the usual signing key and a version code higher than
the installed build. Existing pipelines are unchanged; deployment is not verified
by these local checks. No database migrations or stored indoor session changes
need undoing.

The pre-prototype rollback baseline is `6c1d1c5c675d04f710a0a71c3f4bba51ded4d990`.
For a standalone rollback APK without changing your checkout:

```bash
git worktree add --detach ../contour-rollback 6c1d1c5c675d04f710a0a71c3f4bba51ded4d990
cd ../contour-rollback/android
./gradlew :app:assembleDebug -PcontourUiUrl= -PversionCode=<higher-version-code>
```

An empty `contourUiUrl` forces the baseline HTML bundled in that APK; a hosted-page
APK can otherwise keep loading the new UI even after you install older code. For a
full rollback, restore both backend/hosted HTML and APK. Sign prototype and rollback
APKs with the same keystore. A different distribution key requires uninstalling,
which erases the app's local data. Local debug APKs are not signed with the cloud
distribution key unless that key is supplied locally. Keep the existing App Tester
release available too.
