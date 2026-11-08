# Central Library demo

Central Library is building **01** while using the fixed campus demo position.
When GPS is enabled, campus buildings retain distance ordering. Humanities &
Social Sciences remains available elsewhere in the campus list.

Open Central Library and tap its indoor button to view the official floor maps.
The viewer starts on **2F**, where the published map shows the entrance hall, and
offers **B1, 1F, 2F, 3F and 4F**. The images are embedded in the shared HTML so the
hosted page, Android APK fallback and iPhone fallback all carry the same maps.
Scroll the image to read its labels. No simulated position or synthetic route is
drawn over these official images.

Source: [Nagoya University Central Library floor maps](https://www.nul.nagoya-u.ac.jp/central/floormap_e.html),
retrieved November 8, 2026. Original images:

- [B1](https://www.nul.nagoya-u.ac.jp/central/images/b1.jpg)
- [1F](https://www.nul.nagoya-u.ac.jp/central/images/1f.jpg)
- [2F](https://www.nul.nagoya-u.ac.jp/central/images/2f.jpg)
- [3F](https://www.nul.nagoya-u.ac.jp/central/images/3f.jpg)
- [4F](https://www.nul.nagoya-u.ac.jp/central/images/4f.jpg)

The maps are university publications, not a measured indoor-positioning model.
Opening hours remain unknown in this demo; consult the library's current notices.
Existing sample navigation and Engineering II/Room221 work are unchanged.

Deployment uses the existing public hosted page and Android App Distribution
trigger. Native iPhone installation uses the owner's local Personal Team and
`com.dpbelisario.contour.weekend`; signing settings remain local. The camera
permission fix from PR #32 is included in the installed iPhone build.
