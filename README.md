# Place Builders Timesheet

A simple no-login timesheet app: log hours by task, track project/task budgets,
assign a dollar amount per person per task, and generate invoices.

## 1. Create a free Firebase project

1. Go to https://console.firebase.google.com and sign in with your Google account.
2. Click **Add project**, name it something like `place-builders-timesheet`, and finish the wizard (you can decline Google Analytics).
3. In the left sidebar, click **Build > Firestore Database**, then **Create database**.
   - Choose a region close to you.
   - Start in **Test mode** (this app has no login, so it reads/writes freely — that's expected for now, since we're keeping the app's URL private/unlisted).
4. Click the gear icon next to **Project Overview > Project settings**.
5. Under **Your apps**, click the **</>** (web) icon to register a new web app. Give it any nickname (e.g. "timesheet"). You don't need Firebase Hosting.
6. Firebase will show you a `firebaseConfig` object. Copy the values.

## 2. Paste your config

Open [firebase-config.js](firebase-config.js) in this folder and replace the placeholder
values (`YOUR_API_KEY`, etc.) with the real values from step 1.6.

## 3. Run it locally

Browsers block Firebase's SDK from working correctly when you just double-click an
HTML file (`file://` URLs), so serve the folder with a tiny local web server instead.
Pick whichever you have installed:

**Option A — Node (if you have it):**
```bash
npx serve .
```

**Option B — Python (if you have it):**
```bash
python -m http.server 8000
```

Then open the printed URL (e.g. `http://localhost:3000` or `http://localhost:8000`)
in your browser.

## 4. First-time setup inside the app

1. Go to **Admin** and add your team as **People** (name + hourly rate).
2. Add a **Project** (e.g. "Cache County AT Guidebook").
3. Under **Tasks & Budgets**, select that project and add tasks with their $ budgets
   (e.g. "Task 1: Project Management" — $1500).
4. Under **Assignments**, assign each person to the tasks they'll work on, with a max
   hours cap.
5. Go to **Timesheet** to start logging hours — pick your name, then project, then task.
6. Go to **My Dashboard** to see hours worked, money owed, and invoiced history per project.
7. Go to **Invoicing** to generate a PDF invoice for a project's uninvoiced hours and
   mark them as invoiced once you've sent it to the client.

## Notes

- There's no login. Anyone with the app's URL can view and edit all data, including
  pay rates — so once this is deployed, only share the link with your team, don't
  post it publicly.
- Next step (not done yet): deploy these same files to GitHub Pages for free hosting
  so the team can use it from anywhere without you running a local server.
