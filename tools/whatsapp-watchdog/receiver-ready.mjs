// Runs in the receiver page after the SDK registered its normal sync callback.
// WhatsApp can finish syncing before that listener is attached after a reboot.
export async function finishSyncedLogin(){
  const socket=window.require?.('WAWebSocketModel')?.Socket;
  if(window.AuthStore?.AppState?.state!=='CONNECTED'||socket?.state!=='CONNECTED'||socket.hasSynced!==true||window.WWebJS||
    window.__wellBuiltReadyBootstrap||typeof window.onAppStateHasSyncedEvent!=='function')return false;
  window.__wellBuiltReadyBootstrap=true;
  try{await window.onAppStateHasSyncedEvent();return true;}
  catch(error){window.__wellBuiltReadyBootstrap=false;throw error;}
}
