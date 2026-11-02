export function projectDispatchAccountSignal(driverId:string,proof:any,profile:any,now:number){
 const time=(value:unknown)=>{const n=typeof value==='number'?value:typeof value==='string'?Date.parse(value):0;return Number.isFinite(n)&&n>0&&n<=now+60000?n:0;};
 const verifiedAt=Math.max(proof?.hydrationDriverId===driverId?time(proof.hydrationAt):0,proof?.secureLoginDriverId===driverId?time(proof.secureLoginAt):0);
 const signedOutAt=time(profile?.logoutAt??profile?.profile?.logoutAt);
 const state=signedOutAt&&signedOutAt>=verifiedAt?'signed_out':verifiedAt&&now-verifiedAt<=30*60000?'recently_active':'unknown';
 return {state,verifiedAt:verifiedAt||null,signedOutAt:signedOutAt||null};
}
