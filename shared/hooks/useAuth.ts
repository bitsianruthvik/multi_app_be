import { useState, useEffect } from 'react';
import { getSession } from '../services/sessionService';

export function useAuth(){
  const [user, setUser] = useState<any | null>(null);

  useEffect(()=>{
    let mounted = true;
    getSession().then(s => { if(mounted) setUser(s?.user ?? null); }).catch(()=>{});
    return ()=>{ mounted = false; };
  },[]);

  return { user };
}
