# Putting ParkPulse on the Google Play Store

ParkPulse ships to Android as a **Trusted Web Activity** (TWA): a thin native
shell, a few hundred kilobytes, that opens www.parkpulse.fun full-screen with no
browser chrome. It is the same app people already use on the web. There is no
second codebase, no second deploy, and no app update needed when you ship a
change — you push to `main`, Railway deploys, and the Android app is updated
too, because the Android app *is* the website.

The only things that ever need a new Play release are the icon, the name, the
package id, or the shell's own settings.

## What is already done, in this repo

Nothing below needs building. It is here and live:

| Thing | Where |
|---|---|
| Web app manifest (name, icons, `start_url`, `scope`, theme) | `public/manifest.json` |
| Service worker (offline shell, cached waits) | `public/sw.js` |
| App icon, 512×512 | `public/icon-512.png` |
| App icon, 1024×1024 (Play listing) | `public/icon-1024.png` |
| Maskable icon, 512×512 | `public/icon-maskable-512.png` |
| Feature graphic, 1024×500 | `public/feature-graphic.png` |
| Phone screenshots, 1080×1920 | `public/shot-waits.png`, `public/shot-plan.png` |
| Privacy policy page | https://www.parkpulse.fun/privacy |
| Terms page | https://www.parkpulse.fun/terms |
| Digital Asset Links endpoint | `/.well-known/assetlinks.json`, served by `server.js` |

The asset-links endpoint reads two Railway variables and returns an empty array
until you set them:

- `ANDROID_PACKAGE` — defaults to `fun.parkpulse.twa`
- `ANDROID_FINGERPRINT` — comma-separated SHA-256 signing fingerprints

Step 4 is where those get filled in.

---

## Step 0 — decide personal or organization account. Do this first.

This is the single biggest fork in the road, it costs nothing to get right, and
it is painful to change later.

**Personal account.** $25, sign up with a Google account and a government ID.
But every personal account created after 13 November 2023 has to run a **closed
test with at least 12 testers, opted in continuously for 14 days**, before it
can apply for production access. Since 2026 Google also checks the testers
actually opened the app. Testers who drift in and out don't count — the 14 days
must be continuous. Realistically that is three to four weeks from signup to
public listing.

**Organization account.** Same $25, but you register as a legal business
entity, which needs a **D-U-N-S number** for that entity (free from Dun &
Bradstreet, typically issued in a few days, sometimes up to 30). Organization
accounts are **exempt from the 12-tester rule entirely** — you can go straight
to production.

You already trade as Maben Consulting. If that entity has or can get a D-U-N-S
number, register the organization account: it removes a three-week gate, and it
puts "Maben Consulting" rather than your personal name on the store listing,
which reads better next to a paid product.

Start the D-U-N-S request the same day you decide, because it is the one step
with a queue you don't control.

---

## Step 1 — create the Play Console account

1. https://play.google.com/console/signup
2. Pick **Organization** or **Personal** per Step 0.
3. Pay the one-time $25 USD.
4. Complete identity verification (ID, address, and for an organization, the
   D-U-N-S plus a verification call or email to the business).
5. In **Payments profile**, add your bank details even though the app itself is
   free — you'll need it if you ever sell through Play.

Verification usually clears in a few days. You can start Step 2 while you wait.

---

## Step 2 — build the Android package

You need an `.aab` (Android App Bundle). Two routes; pick one.

### Route A — PWABuilder (no toolchain, ~10 minutes)

Best if you don't want Java and the Android SDK on your machine.

1. Go to https://www.pwabuilder.com
2. Enter `https://www.parkpulse.fun` and let it analyse the manifest.
3. Choose **Android → Package for stores**.
4. Set:
   - **Package ID**: `fun.parkpulse.twa`
   - **App name**: `ParkPulse`
   - **Launcher name**: `ParkPulse`
   - **Start URL**: `/app`
   - **Theme / background colour**: `#2c2154`
   - **Display mode**: standalone
   - **Signing key**: *Create new* — PWABuilder generates one for you
5. Download the zip. It contains `app-release-bundle.aab`, the signing key
   (`signing.keystore`), and `signing-key-info.txt` with the key alias and
   passwords.

**Back that zip up somewhere permanent and private, right now.** Lose the
keystore and you can never update this app again under this listing — you would
have to publish a new one and lose your reviews and installs. Put it in a
password manager or an encrypted drive, not in this git repo.

### Route B — Bubblewrap CLI (more control, reproducible)

Needs Node 18+ and JDK 17. Bubblewrap will offer to download the Android SDK
itself.

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://www.parkpulse.fun/manifest.json
```

Answer the prompts:

- Application ID: `fun.parkpulse.twa`
- Display name: `ParkPulse`
- Start URL: `/app`
- Icon URL: `https://www.parkpulse.fun/icon-512.png`
- Maskable icon: `https://www.parkpulse.fun/icon-maskable-512.png`
- Status bar / navigation colour: `#2c2154`
- Signing key: let it generate one; **record the alias and both passwords**

Then:

```bash
bubblewrap build          # produces app-release-bundle.aab
bubblewrap fingerprint list   # prints the SHA-256 you need in Step 4
```

If Play later rejects the upload for targeting too old an API level, run
`bubblewrap update && bubblewrap build` — that pulls the current target.

Same warning as Route A: the keystore is unrecoverable. Back it up.

---

## Step 3 — create the app in Play Console and upload

1. **All apps → Create app**
   - App name: `ParkPulse: Park Wait Times` (30 characters max)
   - Default language: English (United States)
   - App or game: **App**
   - Free or paid: **Free** (passes are sold on the website — see the payments
     note at the end)
   - Accept the declarations.
2. **Release → Testing → Internal testing → Create new release**
3. Upload the `.aab`. Internal testing is instant and has no tester minimum —
   use it to check the app actually opens before you touch anything else.
4. Add yourself as an internal tester, install from the opt-in link, and open
   it on a real phone.

At this point the app will work **but show a browser address bar at the top**.
That is expected and Step 4 fixes it.

---

## Step 4 — kill the address bar (Digital Asset Links)

Chrome only hides its URL bar when the website vouches for the app. This is the
step everyone gets wrong, so read the second bullet carefully.

1. Get the fingerprints. You need **both**:
   - Your **upload key** — `bubblewrap fingerprint list`, or
     `signing-key-info.txt` from PWABuilder.
   - **Google's app-signing key** — Play Console → your app → **Test and
     release → Setup → App integrity → App signing key certificate → SHA-256**.

   This second one is the trap. Google re-signs your bundle with its own key
   before shipping it, so the app your users install is *not* signed with your
   upload key. Register only the upload key and the address bar disappears for
   you and stays visible for everybody else.

2. In Railway, on the ParkPulse service, set:

   ```
   ANDROID_PACKAGE      fun.parkpulse.twa
   ANDROID_FINGERPRINT  AA:BB:...:99,11:22:...:FF
   ```

   Both fingerprints, comma-separated, colons included, upper case.

3. Redeploy, then check it:

   ```
   https://www.parkpulse.fun/.well-known/assetlinks.json
   ```

   You should see one object with both fingerprints in
   `sha256_cert_fingerprints`. An empty `[]` means the variable didn't take.

4. Verify Google agrees:
   https://developers.google.com/digital-asset-links/tools/generator — paste
   the site and package name.

5. Uninstall and reinstall the app on your phone. Address bar gone.

---

## Step 5 — the store listing

**App name** (30 max)

```
ParkPulse: Park Wait Times
```

**Short description** (80 max)

```
Live wait times and AI day plans for 65 theme parks worldwide.
```

**Full description** (4000 max)

```
Stop guessing. ParkPulse shows you live wait times for 65 theme parks around
the world — Disney, Universal, Six Flags, Cedar Fair, Europa-Park, Tokyo,
Shanghai, Paris and more — and turns them into a plan for your actual day.

LIVE WAIT TIMES
Every ride, updated continuously, colour-coded so you can read the whole park
at a glance. If a park's feed goes quiet, ParkPulse shows you the last known
board rather than an empty screen.

A PLAN BUILT AROUND YOUR GROUP
Tell it who you're with — toddlers, a teenager who only wants coasters, someone
who needs a sit-down every couple of hours — and ParkPulse builds an order that
actually works. Walking distance, ride heights, showtimes, and the queues as
they are right now.

MILA, YOUR PARK ADVISOR
Ask anything, in plain language. "It's raining, what now?" "Is the Lightning
Lane worth it today?" "Where do we eat near Fantasyland at 1pm?" Mila knows the
park you're standing in, your group, and what you've already ridden.

WAIT-DROP ALERTS
Pick the rides you care about and get a notification the moment the queue
drops. No more walking the park to check.

DINING AND RESERVATIONS
Every restaurant, with the right reservation page for the park you are actually
in — not a generic resort landing page.

CROWD FORECASTS
See how busy a park is likely to be before you go, built from what actually
happened there on the same weekday.

19 LANGUAGES
English, Spanish, Portuguese, French, German, Italian, Chinese, Japanese,
Korean, Russian, Arabic, Hindi, Bengali, Marathi, Tamil, Telugu, Turkish, Urdu,
Vietnamese, Indonesian.

FREE TO TRY
Browse live waits for free. A pass unlocks every park, the plan builder, Mila
and wait-drop alerts — from $6.99 for a day, $17.99 for a ten-day trip.

Not affiliated with, endorsed by, or sponsored by Disney, Universal, Six Flags,
Cedar Fair, Merlin Entertainments or any park operator. All park and ride names
are trademarks of their respective owners.
```

That last paragraph is not optional. Play rejects apps that look like an
official park app; naming the parks is fine, implying endorsement is not.

**Graphics** — all in `public/`, upload as-is:

- App icon: `icon-512.png`
- Feature graphic: `feature-graphic.png` (1024×500)
- Phone screenshots: `shot-waits.png`, `shot-plan.png` (1080×1920)

Two screenshots is the minimum. Four to six converts better — take them on a
real phone from `/app`: a busy wait board, a built plan, a Mila answer, and the
alerts screen.

**Category**: Travel & Local. **Tags**: travel, trip planner, maps.
**Contact email**: your support address. **Website**: `https://www.parkpulse.fun`.
**Privacy policy**: `https://www.parkpulse.fun/privacy`.

---

## Step 6 — the compliance forms

Four forms under **Policy → App content**. None are hard, but the app cannot go
live until all are green.

**Privacy policy** — `https://www.parkpulse.fun/privacy`.

**Data safety** — answer it from what ParkPulse actually does:

| Question | Answer |
|---|---|
| Personal info → Name, Email | **Collected**, not shared. For account creation and the plan email. |
| Personal info → Other (AI chat messages) | **Collected**, not shared. Sent to the AI provider to answer. |
| Location → Approximate location | **Not collected.** The browser's location is used on-device to find the nearest park and draw a you-are-here dot; it is rounded and kept in local storage and never sent to our server. |
| Financial info | **Not collected.** Payments go to Stripe; card details never touch our servers. |
| App activity → In-app actions | **Collected**, not shared. Which park and rides, to build the plan. |
| Data encrypted in transit | **Yes.** |
| Users can request deletion | **Yes** — https://www.parkpulse.fun/delete-account |

**Content rating** — fill in the IARC questionnaire. A wait-times app with no
violence, no gambling and no user-to-user chat rates **Everyone / PEGI 3**.
Declare that it does contain in-app purchases and that it collects an email.

**Ads** — ParkPulse shows no third-party ads. Answer **No**.

**Target audience** — 13+. Do *not* tick "designed for children"; that pulls in
the Families policy and its extra review, and the app is aimed at the adult
planning the trip.

**Government apps / financial features / health** — all No.

---

## Step 7 — release

**If you have an organization account**, go straight to
**Production → Create new release**, upload the AAB, write release notes,
roll out. Review for a first submission usually takes a few days and can take
up to a week.

**If you have a personal account**, the 12-tester gate applies:

1. **Testing → Closed testing → Create a new track.**
2. Add at least 12 testers by email, or create a Google Group and add that.
   Family, friends, a Disney-planning Facebook group, r/wdwplanning — real
   people who will actually open it.
3. Every one of them has to **accept the opt-in link and install the app**, and
   stay opted in for **14 continuous days**. Someone who opts out on day 9
   resets to zero.
4. Tell them explicitly to open it a few times over the fortnight. Google now
   checks for genuine use, not just installs.
5. On day 15, **Dashboard → Apply for production access**, answer the short
   questionnaire about how you tested and what you learned, and submit.

Add a couple of spare testers above the 12. One person uninstalling to free up
phone space should not restart your clock.

---

## The payments question — read this before you submit

ParkPulse sells passes through Stripe on the website. Inside a TWA, that
checkout runs in the app. Historically Google required Google Play Billing for
digital goods bought in-app, and TWAs selling through a web checkout were a
common rejection.

That changed. Following the Epic v. Google injunction, Google no longer
requires Play Billing in apps distributed on Play, nor prohibits other in-app
payment methods, nor stops you telling users about them. In parallel Google has
been standing up a fee-and-reporting regime for external links and alternative
billing — as of October 2026, developers enrolled in those US programs report
transactions and pay service fees, and there is a per-download fee on external
content links.

What that means for you, practically:

- **Submitting as-is is reasonable.** The hard prohibition that used to sink
  TWAs is gone.
- **The fee regime is in flux**, and how it applies to a website that happens
  to be wrapped in a TWA is not crisply settled. Budget for the possibility
  that Play takes a cut of app-originated sales eventually.
- **If you are rejected on payments**, the cheap fix is to stop selling inside
  the wrapper: hide the pass cards when the app is running as a TWA and say
  "manage your pass at parkpulse.fun". The app then does what a reader app
  does — recognises an account that already has a pass. That is a small change
  in `public/app.html` and I can make it if it comes to that.
- Do **not** ship a version that takes payment and hides it from review. That
  is the one thing that gets a developer account terminated rather than an app
  rejected.

Because of all this, list the app as **Free** with **in-app purchases**
declared, not as a paid app.

---

## Afterwards

**Shipping web changes** needs no Play release. Push to `main`, Railway
deploys, users get it on next open. This is the entire point of the TWA.

**A new Play release** is only needed for the app icon, the app name, the
package id, or the shell's settings. Rebuild the AAB with the same keystore,
bump `versionCode`, upload.

**Watch, in the first weeks:**

- Play Console → Quality → Android vitals. Crash-free rate matters for ranking,
  and a TWA's crashes are almost always the shell failing to reach the site.
- Reviews. Reply to them; it is weighted.
- Your own `/admin` funnel, to see whether Android installs convert to passes
  at a different rate than the web. If they don't convert at all, the pass
  cards are probably being hidden by something in the wrapper.

**iOS** is a separate exercise and a harder one: Apple rejects thin web
wrappers under guideline 4.2, so an App Store version needs real native
capability rather than the same trick. The `shot-*-ios.png` assets are already
sized for it when you want to take that on.
