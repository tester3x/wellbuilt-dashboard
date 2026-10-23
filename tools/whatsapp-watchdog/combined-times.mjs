const issue='Multiple wells in one message; confirm individual pull times';
/** Estimate only same-sender/channel combined reports; never infer across a shift-sized gap. */
export function combinedPullTimes(message,data){
 const rows=message.rows||[],anchor=Date.parse(message.postedAt);
 if(!message.senderId||message.deleted||message.edited||!Number.isFinite(anchor)||rows.length<2||rows.length>5||rows.some(r=>!r.wellName||!r.issues?.includes(issue)||r.issues.some(i=>![issue,'Missing barrels'].includes(i))||Date.parse(r.dateTimeUTC)!==anchor))return null;
 const posts=Object.values(data.messages||{}).filter(p=>p.channel===message.channel&&p.senderId===message.senderId&&!p.deleted&&!p.edited&&p.rows?.length===1).flatMap(p=>p.rows.filter(r=>{
  const d=data.deliveries?.[r.id];return d?.status==='complete'&&!d.needsReview&&!r.timeEstimate&&Date.parse(r.dateTimeUTC)<anchor;
 })).sort((a,b)=>Date.parse(a.dateTimeUTC)-Date.parse(b.dateTimeUTC));
 const gaps=[];for(let i=1;i<posts.length;i++){
  const minutes=(Date.parse(posts[i].dateTimeUTC)-Date.parse(posts[i-1].dateTimeUTC))/60000;
  if(minutes>=15&&minutes<=240)gaps.push(minutes);
 }
 const samples=gaps.slice(-20);if(samples.length<3)return null;
 const minutes=Math.round(samples.reduce((a,b)=>a+b,0)/samples.length);
 if(anchor-(rows.length-1)*minutes*60000<=Date.parse(posts.at(-1).dateTimeUTC))return null;
 return rows.map((r,i)=>({...r,dateTimeUTC:new Date(anchor-(rows.length-1-i)*minutes*60000).toISOString(),issues:r.issues.filter(v=>v!==issue),combinedTimeResolved:true,...(i<rows.length-1?{timeEstimate:{status:'estimated',method:'back_to_back_average',sampleCount:samples.length,intervalMinutes:minutes,anchorPostedAt:new Date(anchor).toISOString()}}:{})}));
}
