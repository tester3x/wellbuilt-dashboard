'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export default function FreshWaterBuilderRedirect() {
 const router=useRouter(); useEffect(()=>{router.replace('/admin?tab=routes');},[router]);
 return <p className="p-6 text-gray-400">Opening route builder…</p>;
}
