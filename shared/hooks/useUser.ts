import { useState, useEffect } from 'react';
import { apiGet } from '../services/apiClient';

export function useUser(userId?: string){
  const [user, setUser] = useState<any | null>(null);
  useEffect(()=>{
    if(!userId) return;
    let mounted = true;
    apiGet(`/users/${userId}`).then((u)=>{ if(mounted) setUser(u); }).catch(()=>{});
    return ()=>{ mounted = false; };
  },[userId]);
  return { user };
}
