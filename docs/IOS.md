# iPhone app (local build)

The iOS app is the same web app inside Capacitor, with native Bluetooth (no Bluefy needed).
A free Apple ID is enough to install it on your own iPhone; the install stays valid for 7 days, then run it again from Xcode.

## Once

1. Mac: install **Xcode** from the App Store, open it once (accept the license, let it install the iOS platform).
2. Install **Node 22+**: `brew install node`.
3. Get the code and prepare the iOS project:
   ```sh
   git clone https://github.com/artyrian/obdy && cd obdy
   npm ci
   npm run ios:sync      # copies the web app + Bluetooth plugins into ios/
   npm run ios:open      # opens Xcode
   ```
4. Xcode → **Settings → Accounts** → add your Apple ID.
5. Project **App** → target **App** → **Signing & Capabilities** → Team: *Your Name (Personal Team)*.
   If Xcode says the bundle ID is taken, change it to e.g. `io.github.<you>.obdy`.
6. Connect the iPhone with a cable, tap **Trust** on the phone.
   Turn on **Settings → Privacy & Security → Developer Mode** (appears after Xcode sees the phone; the phone restarts).
7. In Xcode pick your iPhone as the run destination and press **▶ Run**.
8. First launch only: iPhone **Settings → General → VPN & Device Management** → your Apple ID → **Trust**.
9. Open obdy → **Connect adapter** → allow Bluetooth → pick the adapter in the list.

## Update / after 7 days

```sh
git pull && npm ci && npm run ios:sync
```
Then **▶ Run** in Xcode again.

## Notes

- Close other OBD apps first: the adapter talks to one app at a time.
- Recording works with the screen on (the app keeps it awake). Background recording is not there yet.
- Save PDF isn't available in the app yet; use **Share** on the report.
- Problems: Info → App log → copy and send it.
