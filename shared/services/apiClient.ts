const BASE = process.env.BACKEND_URL || 'http://localhost:3000';

export async function apiGet(path: string){
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if(!res.ok) throw new Error('Network error');
  return res.json();
}

export async function apiPost(path: string, body: any){
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error('Network error');
  return res.json();
}
