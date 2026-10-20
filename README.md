# FDM for Safari

A Safari add-on that sends downloads to [Free Download Manager](https://www.freedownloadmanager.org/) on this Mac.

Safari cannot load the Chrome or Firefox add-on, and it cannot talk to FDM’s `wenativehost` helper directly. This project is a Safari web extension plus a small Mac app. The app keeps the same local connection FDM already uses for Chrome and Firefox, and the extension asks that app to pass each download along.

The extension can:

- Send a link, image, video, audio file, or selected links from the right-click menu.
- Catch clicks on file links, magnet links, and links with a download attribute.
- Optionally check other links with the server before Safari opens them.
- Pass the page address and Safari’s cookies for that site to FDM, so signed-in downloads still work.
- Skip the same sites and file types you set in FDM’s browser integration.

## Turn it on

1. Open **FDM for Safari** (installed in `~/Applications`).
2. Click **Open Safari Extensions Settings…**.
3. Turn on **FDM for Safari**.
4. In that same Safari settings page, allow the extension on **every website**. It needs that to see the link you clicked and the cookies for the download.
5. Leave **FDM for Safari** running. Closing its window does not quit it. Quit it from the Dock when you want Safari to stop using it.

Free Download Manager itself should be installed in `/Applications`. This add-on starts it when a download is sent over.

## Build

The Xcode project is in `FDM for Safari/`. The Apple Development certificate on this Mac is revoked, so the installed copy is ad-hoc signed. Safari 27 does not put “Allow Unsigned Extensions” in the Develop menu. Turn it on in Safari Settings, on the Developer tab (Develop → Developer Settings…). Safari forgets that checkbox when you quit it.

```bash
xcodebuild -project "FDM for Safari.xcodeproj" -scheme "FDM for Safari" -configuration Release -destination "platform=macOS" -derivedDataPath ../build \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=NO DEVELOPMENT_TEAM=""
codesign --force --sign - --entitlements ../native/extension.entitlements \
  "../build/Build/Products/Release/FDM for Safari.app/Contents/PlugIns/FDM for Safari Extension.appex"
codesign --force --sign - "../build/Build/Products/Release/FDM for Safari.app"
```

The web extension source is in `extension/`. The bridge that talks to `wenativehost` is in `native/FdmHostBridge.swift`.
