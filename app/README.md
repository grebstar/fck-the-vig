# fck the vig — iPhone app

The app is the website in `docs/` wrapped with [Capacitor](https://capacitorjs.com). It uses the same
odds files (loaded live from https://www.fckvig.com/data/) and the same accounts API (api.fckvig.com),
so the site and the app always show the same thing.

What's different inside the app (all in `docs/js/main.js`, switched on by `NATIVE`):

- A 21+ gate on first launch (required for App Store review).
- Odds data comes from www.fckvig.com instead of files bundled in the app.
- Push alerts say "coming in the next app update" until native push is added. Email alerts work.

Bundle ID: `com.fckvig.app` (permanent once registered with Apple).

## First time on the Mac

1. Install **Xcode** from the Mac App Store and open it once so it finishes setting up.
   If it asks which platforms to install, include **iOS**.
2. Install **Node.js 22 or newer** (the LTS version) from https://nodejs.org.
3. Open **Terminal** and paste:

   ```sh
   cd ~
   git clone https://github.com/grebstar/fck-the-vig.git
   cd fck-the-vig/app
   npm install
   npx cap add ios
   npm run sync
   npm run open
   ```

   If the Mac asks to install "command line developer tools" for `git`, click Install and run the
   commands again.
4. Xcode opens the project. At the top, pick any iPhone simulator, then press
   the **▶ Run** button.

## Getting the latest version later

```sh
cd ~/fck-the-vig && git pull && cd app && npm run sync
```

Then press **▶ Run** in Xcode again.

## Not done yet

- Signing, TestFlight and App Store upload (need the Apple Developer account).
- Native push notifications (needs an APNs key from the developer account).
- App icon and launch screen.
- The `ios/` project folder is generated on the Mac by `npx cap add ios` and isn't in the repo yet.
