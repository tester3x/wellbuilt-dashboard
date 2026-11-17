import {createHash} from 'node:crypto';

export class PhotoInbox {
  constructor(queue, transport, download) {
    this.queue = queue;
    this.transport = transport;
    this.download = download;
    this.busy = false;
    this.error = '';
  }

  async tick(channels) {
    if (this.busy || !this.transport.secret) return;
    this.busy = true;
    this.queue.data.photoInbox ??= {};
    try {
      const posts = Object.values(this.queue.data.messages).filter(post =>
        !post.deleted && post.rows?.some(row => row.photo) && channels.some(channel => channel.id === post.channel))
        .sort((a, b) => Date.parse(b.postedAt || b.updatedAt) - Date.parse(a.postedAt || a.updatedAt));
      const errors = [];
      for (const post of posts) {
        try {
          const key = createHash('sha256').update(post.channel + ':' + post.id).digest('hex');
          const previous = this.queue.data.photoInbox[key];
          const revision = createHash('sha256').update(JSON.stringify([post.digest, post.rows, post.body, post.chat])).digest('hex');
          if (previous?.complete && previous.revision === revision) continue;
          let snapshot = previous?.complete ? {...previous.snapshot, rows: post.rows, caption: post.body || post.chat || ''} : null;
          if (!snapshot) {
            const media = await this.download(post);
            if (!media?.data || !['image/jpeg', 'image/png', 'image/webp'].includes(media.mimetype)) throw Error('Original photo unavailable for ' + key);
            if (media.data.length > 16 * 1024 * 1024) throw Error('Photo exceeds inbox limit');
            const bytes = Buffer.from(media.data, 'base64');
            snapshot = {channel: post.channel, messageId: post.id, postedAt: post.postedAt || post.updatedAt,
              caption: post.body || post.chat || '', rows: post.rows, mimeType: media.mimetype,
              bytes: bytes.length, imageDigest: createHash('sha256').update(bytes).digest('hex')};
            const prepared = await this.transport.request('syncWatchdogPhotoInboxV2', snapshot);
            const upload = await fetch(prepared.uploadUrl, {method: 'PUT', headers: {'Content-Type': media.mimetype,
              'x-goog-if-generation-match': '0'}, body: bytes, signal: AbortSignal.timeout(60000)});
            // An immutable object may already exist after a lost completion response.
            if (!upload.ok && upload.status !== 412) throw Error('Photo upload HTTP ' + upload.status);
          }
          const receipt = await this.transport.request('syncWatchdogPhotoInboxV2', {...snapshot, complete: true});
          if (receipt.messageHash !== key) throw Error('Photo inbox message mismatch');
          this.queue.data.photoInbox[key] = {complete: true, revision, snapshot, imageDigest: snapshot.imageDigest, syncedAt: new Date().toISOString()};
          this.queue.save();
        } catch (error) { errors.push(String(error.message || error)); }
      }
      this.error = errors.join('; ').slice(0, 1000);
    } catch (error) {
      this.error = String(error.message || error);
    } finally {
      this.busy = false;
    }
  }
}
