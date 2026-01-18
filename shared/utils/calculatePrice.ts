export function calculatePrice(base: number, taxPercent = 0){
  const tax = base * (taxPercent/100);
  return Math.round((base + tax) * 100) / 100;
}
