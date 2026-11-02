// Self-contained: Puppeteer serializes this function into the WhatsApp page.
export async function collectReceiver({ids, checkpoints, now}) {
  if (window.AuthStore?.AppState?.state !== 'CONNECTED') throw Error('WhatsApp is not connected');
  const collections = window.require('WAWebCollections');
  const groups = collections.Chat.getModelsArray().filter(c => c.id?.server === 'g.us');
  if (!window.__wellBuiltRawMessages) {
    window.__wellBuiltRawMessages = [];
    const remember = m => { window.__wellBuiltRawMessages.push(m); if (window.__wellBuiltRawMessages.length > 500) window.__wellBuiltRawMessages.shift(); };
    for (const event of ['add', 'change:body', 'change:type']) collections.Msg.on(event, remember);
  }
  const selected = groups.filter(c => ids.includes(c.id._serialized));
  if (selected.length !== ids.length) throw Error('Waiting for all configured WhatsApp groups to sync');
  const messages = [], diagnostics = [], covered = {};
  const received = [...collections.Msg.getModelsArray(), ...window.__wellBuiltRawMessages];
  window.__wellBuiltHistory ??= {};
  for (const chat of selected) {
    const id = chat.id._serialized;
    // A successful poll is not proof that WhatsApp has synced every older post.
    // Reconcile a full day as well as any longer durable outage. Message IDs and
    // server receipts make this replay idempotent; a late-synced post must not
    // become invisible just because the polling watermark already passed it.
    const since = Math.min(checkpoints[id] || now - 86400, now - 86400) - 600;
    const all = new Map();
    const add = list => { for (const m of list) if (m.id?._serialized || m.id?.id) all.set(m.id._serialized || m.id.id, m); };
    add(chat.msgs.getModelsArray()); add(received.filter(m => m.id?.remote?._serialized === id));
    if (now - (window.__wellBuiltHistory[id] || 0) > 30) {
      const loader=window.require('WAWebChatLoadMessages');
      // Chat caches can have ancient group notices plus the newest post, with
      // an unsynced hole between. Only a fresh page walk proves coverage.
      if(typeof loader.loadRecentMsgs==='function')await loader.loadRecentMsgs({chat});
      let pageOldest=Infinity;
      for (let page = 0; page < 100; page++) {
        if (pageOldest <= since) { window.__wellBuiltHistory[id] = now; break; }
        const previousOldest=pageOldest;
        let timer, loaded;
        try { loaded = await Promise.race([
          loader.loadEarlierMsgs({chat}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('WhatsApp history timed out')), 15000); }),
        ]); } finally { clearTimeout(timer); }
        add(Array.isArray(loaded) ? loaded : []); add(chat.msgs.getModelsArray());
        if(!Array.isArray(loaded)){
          // A newly created/exhausted group can return undefined, rather than
          // [], after the fresh page request. Require WhatsApp's explicit end
          // state; an old cached notice or a missing response alone is no proof.
          const state=chat.msgs.msgLoadState,read=key=>state?.[key]??state?.['__x_'+key];
          if(loaded==null&&read('noEarlierMsgs')===true&&read('contextLoaded')===true&&
            !read('isLoadingEarlierMsgs')&&!read('isLoadingRecentMsgs')&&!read('isRepairingMsgHistory')){
            window.__wellBuiltHistory[id]=now;break;
          }
          throw Error('WhatsApp history page unavailable');
        }
        if(!loaded.length){window.__wellBuiltHistory[id]=now;break;}
        const times=loaded.filter(m=>typeof m.body==='string'&&m.body.trim()&&!m.isNotification)
          .map(m=>Number(m.t)).filter(Number.isFinite);
        pageOldest=Math.min(pageOldest,...times);
        if(page>0&&pageOldest>=previousOldest&&pageOldest>since)throw Error('WhatsApp history did not advance; checkpoint preserved');
      }
      if (window.__wellBuiltHistory[id] !== now) throw Error('WhatsApp history exceeds catch-up batch; retrying without advancing checkpoint');
    }
    for (const m of all.values()) {
      if (typeof m.body !== 'string' || !Number.isFinite(Number(m.t)) || Number(m.t) < since) continue;
      messages.push({id:m.id._serialized || m.id.id, channel:id, timestamp:Number(m.t), fromMe:!!m.id.fromMe,
        senderId:(typeof m.id?.participant === 'string' ? m.id.participant : m.id?.participant?._serialized) ||
          (typeof m.author === 'string' ? m.author : m.author?._serialized) || null,
        author:m.notifyName || m.author?._serialized || m.from?._serialized || 'Driver', body:m.body, deleted:m.type === 'revoked'});
    }
    covered[id] = now;
    window.__wellBuiltHistory[id] = now;
    diagnostics.push({id, loaded:all.size, eligible:messages.filter(m => m.channel === id).length});
  }
  return {messages, diagnostics, covered, groups:groups.map(c => ({id:c.id._serialized, name:c.name || c.formattedTitle || c.id._serialized}))};
}
