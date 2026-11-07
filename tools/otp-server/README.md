# Email login codes (free)

The app's "send code" login runs on **Google Apps Script** in your own Google account.
It sends the 6-digit code from your Gmail (free: about 100 emails a day on a normal Gmail
account) and returns a Firebase sign-in token. Password login does not use this; it goes
straight to Firebase Authentication, which is also free.

Nothing here costs money, and no credit card is needed.

## One-time setup (about 10 minutes)

### 1. Turn on Firebase Authentication
1. Open https://console.firebase.google.com/project/gluco-reverse/authentication
2. Click **Get started**.
3. Under **Sign-in method**, choose **Email/Password**, switch on the first toggle
   (leave "Email link" off), then click **Save**.

### 2. Download the service account key
1. Open https://console.firebase.google.com/project/gluco-reverse/settings/serviceaccounts/adminsdk
2. Click **Generate new private key**, then **Generate key**. A `.json` file downloads.
3. Keep it private. Do not put it in the app or send it to anyone.

### 3. Create the Apps Script
1. Open https://script.google.com and click **New project**. Name it `Sugar Helper OTP`.
2. Replace everything in `Code.gs` with the contents of [Code.gs](Code.gs).
3. Click the gear (**Project Settings**), tick **Show "appsscript.json" manifest file in
   editor**, go back to the editor, and replace `appsscript.json` with [appsscript.json](appsscript.json).
4. In **Project Settings → Script properties**, click **Add script property**:
   - Property: `SERVICE_ACCOUNT`
   - Value: paste the **whole** content of the `.json` file from step 2.
   Click **Save script properties**.

### 4. Deploy it
1. Click **Deploy → New deployment**, gear icon → **Web app**.
2. Execute as: **Me**. Who has access: **Anyone**.
3. Click **Deploy**, then **Authorize access**, pick your Gmail, then
   **Advanced → Go to Sugar Helper OTP (unsafe) → Allow**. (Google shows this warning for
   every personal script; it is your own code.)
4. Copy the **Web app URL** (it ends in `/exec`).

### 5. Connect the app
Put the URL in `www/src/cloud-config.js` as `otpUrl`, then rebuild the app.

## Later changes
After editing `Code.gs`, use **Deploy → Manage deployments → edit (pencil) → Version: New
version → Deploy**. This keeps the same URL, so the app does not need to change.

## Limits and safety
- A code is valid for 10 minutes and is thrown away after 5 wrong tries.
- One email address can ask for at most 5 codes an hour.
- Codes are stored only as a hash in the script's short-term cache.
