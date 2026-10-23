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
