/** "+919876543210" -> "+91 98•••••210". Staff roles that do not need to call people only ever receive the masked form. */
export const maskPhone = (p: string | null | undefined): string | null => (p && /^\+91\d{10}$/.test(p) ? `+91 ${p.slice(3, 5)}•••••${p.slice(-3)}` : p ? '•••' : null);
