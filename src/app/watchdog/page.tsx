 'use client';
import {useAuth} from '@/contexts/AuthContext';
import {AppHeader} from '@/components/AppHeader';
import {WatchdogReviewInbox} from '@/components/watchdog/WatchdogReviewInbox';
function ActiveWatchdogPage(){
 const {user,loading,operatingCompanyId}=useAuth();
 return <><AppHeader/><main className="max-w-3xl mx-auto p-4 space-y-4">
 {loading?<p>Signing in...</p>:!user?<p>Sign in to review pulls.</p>:!operatingCompanyId?<p>Select a company in the header.</p>:<WatchdogReviewInbox key={user.uid+':'+operatingCompanyId} companyId={operatingCompanyId}/>}
 </main></>;
}
export default function WatchdogPage(){
 if(process.env.NEXT_PUBLIC_WATCHDOG_REMOTE_REVIEW==='disabled')return <><AppHeader/><main className="max-w-3xl mx-auto p-4">Watchdog reviews are not enabled.</main></>;
 return <ActiveWatchdogPage/>;
}
