import {readFileSync} from 'node:fs';
import path from 'node:path';

export function loadWorkerConfig(directory) {
  try {
    const config = JSON.parse(readFileSync(path.join(directory, 'worker.json'), 'utf8'));
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(config.workerId) || !/^[a-f0-9]{7,40}$/.test(config.sourceCommit))
      throw Error('Invalid worker.json identity/source');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Roles, grace periods, claims and actual receipt verification live in Firebase.
// The existing intake message reservation remains the final duplicate barrier.
export class WorkerCoordinator {
  constructor(queue, config, request) {
    this.queue = queue;
    this.config = config;
    this.request = request;
    this.error = '';
    this.verified = new Map();
    this.busy = false;
    this.auditCursor = 0;
    this.lastReportAt = 0;
    this.lastAuditAt = 0;
  }

  async deliver(body) {
    const result = await this.request('claimWatchdogMessageV2', {workerId: this.config.workerId,
      channel: body.chatId, messageId: body.messageId, rowIndex: body.rowIndex});
    if (result.receipt) {
      if (result.receipt.alreadyRecorded) this.verified.set(result.receipt.identity, result.receipt);
      return result.receipt;
    }
    if (!result.granted) throw Error('worker_wait:' + result.reason);
    // No retries here: a timeout is reconciled by message ID on the next poll.
    return this.request('ingestWatchdogPullV2', body);
  }

  async route(endpoint, body) {
    if (endpoint === 'ingestWatchdogPullV2') return this.deliver(body);
    if (endpoint === 'getWatchdogPullReceiptV2' && this.verified.has(body.identity)) {
      const receipt = this.verified.get(body.identity);
      this.verified.delete(body.identity);
      return receipt;
    }
    return this.request(endpoint, body);
  }

  async tick(status) {
    if (this.busy) return;
    this.busy = true;
    try {
      const entries = Object.values(this.queue.data.deliveries || {});
      const now = Date.now();
      const report = {
        state: status.state, paused: !!status.paused, sourceCommit: this.config.sourceCommit,
        lastCaptureAt: status.lastReceiverCheck || '',
        channels: (status.channels || []).map(channel => channel.id),
        pending: entries.filter(entry => ['retry', 'queued', 'incomplete'].includes(entry.status)).length,
        review: entries.filter(entry => entry.status === 'review' || entry.needsReview).length,
        error: String(status.error || this.error || '').slice(0, 500)
      };
      // Capture itself remains local and frequent. Send a cloud heartbeat each
      // minute, or promptly on an operational change, not every timer tick.
      const reportKey = JSON.stringify({...report,lastCaptureAt:undefined});
      if (!this.lastReportAt || now-this.lastReportAt>=60000 || reportKey!==this.lastReportKey) {
        await this.request('reportWatchdogWorkerV2', {workerId:this.config.workerId,report});
        this.lastReportAt=now;this.lastReportKey=reportKey;
      }
      // Independently recheck completed local rows instead of trusting local green
      // badges forever. This only reads/resumes their original receipt identity.
      const rows = Object.values(this.queue.data.messages || {}).filter(post => !post.deleted)
        .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt)).slice(0, 100)
        .flatMap(post => (post.rows || []).map((row, rowIndex) => ({post, row, rowIndex})))
        .filter(({row}) => this.queue.data.deliveries?.[row.id]?.status === 'complete');
      if (this.lastAuditAt && now-this.lastAuditAt<600000) {this.error='';return;}
      this.lastAuditAt=now;
      const audits=this.queue.data.workerReceiptAudits??={};
      let checked=0;
      for (let count = 0; count < rows.length && checked<3; count++) {
        const {post, row, rowIndex} = rows[this.auditCursor++ % rows.length];
        const local=this.queue.data.deliveries[row.id];
        const key=JSON.stringify([local.identity,local.packetId]);
        if(audits[row.id]?.key===key && now-audits[row.id].at<6*3600000)continue;
        checked++;
        const response = await this.request('claimWatchdogMessageV2', {workerId: this.config.workerId,
          channel: post.channel, messageId: post.id, rowIndex});
        if (!response.receipt) throw Error('completed_row_has_no_cloud_reservation');
        if(response.receipt.identity!==local.identity||response.receipt.packetId!==local.packetId)throw Error('completed_row_receipt_mismatch');
        if (!response.receipt.alreadyRecorded) {
          this.queue.data.deliveries[row.id] = {...this.queue.data.deliveries[row.id], status: 'incomplete',
            lastError: 'Cloud receipt requires reconciliation'};
          this.queue.save();
        }
        audits[row.id]={key,at:now};this.queue.save();
      }
      this.error = '';
    } catch (error) { this.error = String(error.message || error); }
    finally { this.busy = false; }
  }
}
