export function formatDateISO(d?: string | Date){
  const date = d ? new Date(d) : new Date();
  return date.toISOString();
}
