export async function getSession(){
  // Platform-neutral session getter. Implement platform-specific storage adapters if needed.
  // For web, you might read a cookie; for mobile use SecureStore. Keep this file platform-agnostic.
  try{
    const res = await fetch((process.env.BACKEND_URL || 'http://localhost:3000') + '/session', { credentials: 'include' });
    if(!res.ok) return null;
    return res.json();
  }catch(e){
    return null;
  }
}
