// WhatsApp revokes authentication in the page before LocalAuth.logout runs.
// The library then deletes the profile while Chromium still owns it. On Windows
// that can partially remove the profile and reject with EBUSY from Crashpad.
// Keep the profile: an unpaired session must still complete WhatsApp's QR flow.
export function createProfileAuth(LocalAuth, options, onLogout = () => {}) {
  return new (class extends LocalAuth {
    async logout() {
      onLogout();
    }
  })(options);
}

// Chromium can restore an old WhatsApp tab as well as Puppeteer's active tab.
// Both use the same linked-device session and block each other with "Use here".
export async function closeRestoredReceiverTabs(client) {
  for (const page of await client.pupBrowser.pages()) {
    if (page === client.pupPage) continue;
    if (page.url().startsWith('https://web.whatsapp.com/')) await page.close();
  }
}
