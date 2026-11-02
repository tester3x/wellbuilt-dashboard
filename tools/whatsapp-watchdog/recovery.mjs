export class ReceiverRecovery {
  constructor({snapshot, online, restart, now = Date.now}) {
    Object.assign(this, {snapshot, online, restart, now});
    this.changedAt = now(); this.lastState = ''; this.nextAttempt = 0;
    this.failures = 0; this.busy = false;
  }
  async tick() {
    if (this.busy) return;
    const s = this.snapshot(), now = this.now();
    if (s.state !== this.lastState) { this.lastState = s.state; this.changedAt = now; }
    if (!s.connect || ['Scan QR', 'Authentication failed'].includes(s.state)) return;
    if (s.state === 'Connected' && now - Date.parse(s.lastReceiverCheck || 0) < 120000) {
      this.failures = 0; this.nextAttempt = 0; return;
    }
    const stale = now - Math.max(this.changedAt, Date.parse(s.lastReceiverCheck) || 0) > 180000;
    if (!['Stopped', 'Disconnected', 'Connection failed'].includes(s.state) && !stale) return;
    if (now < this.nextAttempt) return;
    this.busy = true;
    try {
      if (!await this.online()) { this.nextAttempt = this.now() + 30000; return; }
      this.nextAttempt = this.now() + Math.min(300000, 15000 * 2 ** this.failures++);
      await this.restart();
      this.changedAt = this.now();
    } finally { this.busy = false; }
  }
}
